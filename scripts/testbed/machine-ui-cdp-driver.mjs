#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const STRICT_TAURI_HOST = "tauri.localhost";
const DEFAULT_REMOTE_CDP_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ROUTE_POLL_MS = 100;

export function isStrictTauriHashRouteUrl(value) {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "http:" &&
      url.hostname === STRICT_TAURI_HOST &&
      url.pathname === "/" &&
      url.hash.startsWith("#/")
    );
  } catch {
    return false;
  }
}

export function matchesRoute(value, expected) {
  const route = String(value ?? "");
  if (expected == null) return true;
  if (typeof expected === "string") return route === expected;
  if (expected instanceof RegExp) return expected.test(route);
  if (typeof expected === "function") return expected(route);
  throw new Error("expected route must be a string, RegExp, or predicate");
}

export function routeFromTauriUrl(value) {
  const url = new URL(String(value));
  return url.hash;
}

export function rewriteWebSocketDebuggerUrl(
  webSocketDebuggerUrl,
  forwardedEndpoint,
) {
  const original = new URL(String(webSocketDebuggerUrl));
  const forwarded = new URL(String(forwardedEndpoint));
  if (!["http:", "https:"].includes(forwarded.protocol)) {
    throw new Error("forwarded endpoint must use http or https");
  }
  original.protocol = forwarded.protocol === "https:" ? "wss:" : "ws:";
  original.username = forwarded.username;
  original.password = forwarded.password;
  original.hostname = forwarded.hostname;
  original.port = forwarded.port;
  return original.toString();
}

export async function discoverMachineUiTarget({
  endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!endpoint) throw new Error("endpoint is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const jsonEndpoint = new URL("/json", normalizeEndpoint(endpoint));
  const response = await withTimeout(
    fetchImpl(jsonEndpoint),
    timeoutMs,
    "CDP target discovery",
  );
  if (!response.ok) {
    throw new Error(`CDP target discovery failed with HTTP ${response.status}`);
  }
  const targets = await withTimeout(
    response.json(),
    timeoutMs,
    "CDP target discovery JSON",
  );
  if (!Array.isArray(targets)) {
    throw new Error("CDP target discovery did not return a target array");
  }

  const target = targets.find((candidate) =>
    isStrictTauriHashRouteUrl(candidate?.url),
  );
  if (!target) {
    throw new Error("CDP target discovery found no strict tauri hash route");
  }
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP target is missing webSocketDebuggerUrl");
  }
  return {
    ...target,
    route: routeFromTauriUrl(target.url),
  };
}

export async function openMachineUiCdpSidecar({
  endpoint,
  remote,
  sshPort,
  identityFile,
  certificateFile,
  sshArgs = [],
  localHost = "127.0.0.1",
  localPort,
  remoteCdpHost = "127.0.0.1",
  remoteCdpPort = DEFAULT_REMOTE_CDP_PORT,
  processAdapter = defaultProcessAdapter,
} = {}) {
  if (endpoint) {
    return {
      endpoint: normalizeEndpoint(endpoint),
      process: null,
      async close() {},
    };
  }
  if (!remote) throw new Error("remote is required when endpoint is omitted");

  const selectedLocalPort =
    localPort ?? (await findAvailableLocalPort(localHost));
  const tunnelSpec = `${localHost}:${selectedLocalPort}:${remoteCdpHost}:${remoteCdpPort}`;
  const args = [
    "-N",
    "-L",
    tunnelSpec,
    ...(sshPort ? ["-p", String(sshPort)] : []),
    ...(identityFile ? ["-i", identityFile] : []),
    ...(certificateFile ? ["-o", `CertificateFile=${certificateFile}`] : []),
    ...sshArgs,
    remote,
  ];
  const child = processAdapter.spawn("ssh", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let closed = false;
  return {
    endpoint: `http://${localHost}:${selectedLocalPort}`,
    process: child,
    async close() {
      if (closed) return;
      closed = true;
      await terminateChildProcess(child, processAdapter);
    },
  };
}

export class CdpClient {
  constructor(webSocketUrl, options = {}) {
    this.webSocketUrl = webSocketUrl;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url) => {
        if (typeof WebSocket !== "function") {
          throw new Error("WebSocket is unavailable");
        }
        return new WebSocket(url);
      });
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
    this.socket = null;
  }

  async connect({ timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.socket) return this;
    const socket = this.webSocketFactory(this.webSocketUrl);
    this.socket = socket;
    addSocketListener(socket, "message", (event) => this.#handleMessage(event));
    addSocketListener(socket, "close", () => this.#handleClose());
    addSocketListener(socket, "error", (event) => this.#handleError(event));
    if (socket.readyState === 1) return this;
    await withTimeout(
      new Promise((resolve, reject) => {
        addSocketListener(socket, "open", resolve, { once: true });
        addSocketListener(
          socket,
          "error",
          () => reject(new Error("CDP WebSocket failed to open")),
          { once: true },
        );
      }),
      timeoutMs,
      "CDP WebSocket open",
    );
    return this;
  }

  async send(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (!this.socket || this.closed) throw new Error("CDP client is closed");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const response = withTimeout(
      new Promise((resolve, reject) => {
        this.pending.set(id, { method, resolve, reject });
      }),
      timeoutMs,
      `CDP ${method}`,
      () => this.pending.delete(id),
    );
    this.socket.send(payload);
    return response;
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method).push(handler);
    return () => {
      const handlers = this.eventHandlers.get(method) ?? [];
      this.eventHandlers.set(
        method,
        handlers.filter((candidate) => candidate !== handler),
      );
    };
  }

  async waitForEvent(
    method,
    predicate = () => true,
    { timeoutMs = this.defaultTimeoutMs } = {},
  ) {
    let off;
    return withTimeout(
      new Promise((resolve) => {
        off = this.on(method, (params) => {
          if (predicate(params)) resolve(params);
        });
      }).finally(() => off?.()),
      timeoutMs,
      `CDP event ${method}`,
      () => off?.(),
    );
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending.entries()) {
      pending.reject(new Error(`CDP client closed before ${pending.method}`));
      this.pending.delete(id);
    }
    if (this.socket?.readyState === 0 || this.socket?.readyState === 1) {
      this.socket.close();
    }
  }

  #handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      this.#handleError(error);
      return;
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${message.error.message ?? "error"}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      for (const handler of this.eventHandlers.get(message.method) ?? []) {
        handler(message.params ?? {});
      }
    }
  }

  #handleClose() {
    this.closed = true;
    for (const [id, pending] of this.pending.entries()) {
      pending.reject(
        new Error(`CDP connection closed before ${pending.method}`),
      );
      this.pending.delete(id);
    }
  }

  #handleError(event) {
    const error =
      event instanceof Error
        ? event
        : new Error(event?.message ?? "CDP WebSocket error");
    for (const [id, pending] of this.pending.entries()) {
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export async function enablePageRuntime(client) {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
}

export async function evaluateExpression(
  client,
  expression,
  { timeoutMs, returnByValue = true } = {},
) {
  const result = await client.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue,
      userGesture: false,
    },
    { timeoutMs },
  );
  if (result.exceptionDetails) {
    throw new Error(
      `Runtime.evaluate failed: ${result.exceptionDetails.text ?? "exception"}`,
    );
  }
  return result.result?.value;
}

export async function captureDomIdentity(client, options = {}) {
  return evaluateExpression(
    client,
    `(() => {
      const text = document.body?.innerText ?? "";
      const html = document.documentElement?.outerHTML ?? "";
      let hash = 2166136261;
      for (let index = 0; index < html.length; index += 1) {
        hash ^= html.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return {
        url: location.href,
        route: location.hash,
        pathname: location.pathname,
        title: document.title,
        readyState: document.readyState,
        activeElement: document.activeElement?.tagName?.toLowerCase() ?? null,
        bodyTextSample: text.slice(0, 512),
        domLength: html.length,
        domHash: hash.toString(16).padStart(8, "0")
      };
    })()`,
    options,
  );
}

export async function captureScreenshot(client, options = {}) {
  const result = await client.send(
    "Page.captureScreenshot",
    {
      format: options.format ?? "png",
      fromSurface: options.fromSurface ?? true,
      captureBeyondViewport: options.captureBeyondViewport ?? false,
    },
    { timeoutMs: options.timeoutMs },
  );
  return result.data;
}

export async function captureCheckpoint(client, label, options = {}) {
  const identity = await captureDomIdentity(client, options);
  return {
    label,
    capturedAt: new Date().toISOString(),
    identity,
    screenshot:
      options.screenshot === true
        ? await captureScreenshot(client, options)
        : null,
  };
}

export async function probeSelectorBounds(client, selector, options = {}) {
  if (!selector) throw new Error("selector is required");
  return evaluateExpression(
    client,
    `(() => {
      const selector = ${JSON.stringify(selector)};
      const element = document.querySelector(selector);
      if (!element) return { selector, exists: false, visible: false };
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        Number(style.opacity || "1") > 0 &&
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true"
      );
      return {
        selector,
        exists: true,
        visible,
        tagName: element.tagName.toLowerCase(),
        text: (element.innerText || element.textContent || "").trim().slice(0, 160),
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left
        },
        center: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        }
      };
    })()`,
    options,
  );
}

export async function dispatchPhysicalInput(
  client,
  point,
  { kind = "touch", timeoutMs } = {},
) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("physical input point must contain finite x and y");
  }
  if (kind === "mouse") {
    await client.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      { timeoutMs },
    );
    await client.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
      { timeoutMs },
    );
    return;
  }
  if (kind !== "touch") throw new Error("input kind must be touch or mouse");
  await client.send(
    "Input.dispatchTouchEvent",
    {
      type: "touchStart",
      touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }],
    },
    { timeoutMs },
  );
  await client.send(
    "Input.dispatchTouchEvent",
    { type: "touchEnd", touchPoints: [] },
    { timeoutMs },
  );
}

export async function activateVisibleSelector(client, selector, options = {}) {
  const probe = await probeSelectorBounds(client, selector, options);
  if (!probe?.visible) {
    throw new Error(`selector is not visible: ${selector}`);
  }
  await dispatchPhysicalInput(client, probe.center, options);
  return probe;
}

export async function waitForRoute(client, expected, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_ROUTE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastIdentity = null;
  do {
    lastIdentity = await captureDomIdentity(client, options);
    if (matchesRoute(lastIdentity.route, expected)) return lastIdentity;
    await sleep(pollMs);
  } while (Date.now() < deadline);
  throw new Error(
    `route did not reach ${formatExpectedRoute(expected)}; last route was ${lastIdentity?.route ?? "unknown"}`,
  );
}

export function assertRouteIdentity(identity, expected, label = "route") {
  if (!matchesRoute(identity?.route, expected)) {
    throw new Error(
      `${label} route mismatch: expected ${formatExpectedRoute(expected)}, got ${identity?.route ?? "unknown"}`,
    );
  }
}

export function startContinuousIdentityCapture(client, options = {}) {
  const intervalMs = options.intervalMs ?? 500;
  const checkpoints = [];
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const checkpoint = await captureCheckpoint(
        client,
        options.label ?? "continuous",
        options,
      );
      checkpoints.push(checkpoint);
      options.onCheckpoint?.(checkpoint);
    } catch (error) {
      checkpoints.push({
        label: options.label ?? "continuous",
        capturedAt: new Date().toISOString(),
        error: error.message,
      });
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref?.();
  return {
    checkpoints,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (inFlight) await sleep(5);
      return checkpoints;
    },
  };
}

export async function runVisibleMachineSaleScenario({
  endpoint,
  tunnelOptions = {},
  fetchImpl,
  webSocketFactory,
  expectedInitialRoute,
  steps = [],
  adapter = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  routePollMs = DEFAULT_ROUTE_POLL_MS,
  inputKind = "touch",
  continuousCapture = true,
  continuousCaptureIntervalMs = 500,
  screenshotCheckpoints = false,
} = {}) {
  const sidecar = await openMachineUiCdpSidecar({ endpoint, ...tunnelOptions });
  let client;
  let capture;
  const checkpoints = [];
  try {
    const target = await discoverMachineUiTarget({
      endpoint: sidecar.endpoint,
      fetchImpl,
      timeoutMs,
    });
    if (
      expectedInitialRoute != null &&
      !matchesRoute(target.route, expectedInitialRoute)
    ) {
      throw new Error(
        `initial CDP target route mismatch: expected ${formatExpectedRoute(expectedInitialRoute)}, got ${target.route}`,
      );
    }
    const webSocketUrl = rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      sidecar.endpoint,
    );
    client = new CdpClient(webSocketUrl, {
      webSocketFactory,
      defaultTimeoutMs: timeoutMs,
    });
    await client.connect({ timeoutMs });
    await enablePageRuntime(client);
    capture = continuousCapture
      ? startContinuousIdentityCapture(client, {
          intervalMs: continuousCaptureIntervalMs,
          screenshot: screenshotCheckpoints,
        })
      : null;

    const initial = await captureCheckpoint(client, "initial", {
      timeoutMs,
      screenshot: screenshotCheckpoints,
    });
    checkpoints.push(initial);
    if (expectedInitialRoute != null) {
      assertRouteIdentity(initial.identity, expectedInitialRoute, "initial");
    }
    await adapter.beforeScenario?.({ client, target, initial, checkpoints });

    for (const step of steps) {
      if (step.routeBefore != null) {
        const beforeRoute = await waitForRoute(client, step.routeBefore, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
        });
        assertRouteIdentity(
          beforeRoute,
          step.routeBefore,
          `${step.name} before`,
        );
      }
      await adapter.beforeStep?.({ client, step, checkpoints });
      let actionResult = null;
      if (typeof step.action === "function") {
        actionResult = await step.action({ client, step, checkpoints });
      } else if (step.selector) {
        actionResult = await activateVisibleSelector(client, step.selector, {
          kind: step.inputKind ?? inputKind,
          timeoutMs: step.timeoutMs ?? timeoutMs,
        });
      } else {
        throw new Error(
          `scenario step ${step.name ?? "unnamed"} has no action`,
        );
      }
      await adapter.afterStep?.({ client, step, actionResult, checkpoints });
      if (step.routeAfter != null) {
        const afterRoute = await waitForRoute(client, step.routeAfter, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
        });
        assertRouteIdentity(afterRoute, step.routeAfter, `${step.name} after`);
      }
      checkpoints.push(
        await captureCheckpoint(client, step.name ?? "step", {
          timeoutMs,
          screenshot: screenshotCheckpoints || step.screenshot === true,
        }),
      );
    }

    const final = await captureCheckpoint(client, "final", {
      timeoutMs,
      screenshot: screenshotCheckpoints,
    });
    checkpoints.push(final);
    const adapterResult = await adapter.afterScenario?.({
      client,
      target,
      final,
      checkpoints,
    });
    return {
      schemaVersion: "machine-ui-cdp-sale-scenario/v1",
      status: "passed",
      target: {
        id: target.id ?? null,
        url: target.url,
        route: target.route,
      },
      webSocketUrl,
      checkpoints: [...(capture?.checkpoints ?? []), ...checkpoints],
      result: adapterResult ?? null,
    };
  } finally {
    await capture?.stop();
    await client?.close();
    await sidecar.close();
  }
}

function normalizeEndpoint(endpoint) {
  const url = new URL(String(endpoint));
  url.pathname = url.pathname.replace(/\/json\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function withTimeout(promise, timeoutMs, label, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function addSocketListener(socket, event, handler, options) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, handler, options);
  } else if (typeof socket.on === "function") {
    socket.on(event, handler);
  } else {
    throw new Error("WebSocket adapter must support addEventListener or on");
  }
}

async function findAvailableLocalPort(host) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function terminateChildProcess(child, processAdapter) {
  if (!child) return;
  if (child.exitCode != null || child.killed) return;
  const exited =
    processAdapter.waitForExit?.(child, 1_000) ?? waitForExit(child);
  child.kill?.("SIGTERM");
  try {
    await withTimeout(exited, 1_000, "SSH tunnel shutdown");
  } catch {
    child.kill?.("SIGKILL");
    await (processAdapter.waitForExit?.(child, 500) ?? waitForExit(child));
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.killed) {
      resolve();
      return;
    }
    child.once?.("exit", resolve);
    child.once?.("close", resolve);
  });
}

function formatExpectedRoute(expected) {
  if (expected instanceof RegExp) return expected.toString();
  if (typeof expected === "function") return "predicate";
  return JSON.stringify(expected);
}

const defaultProcessAdapter = {
  spawn,
};

function parseCliArgs(argv) {
  const options = { steps: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--endpoint") {
      options.endpoint = next();
    } else if (arg === "--remote") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.remote = next();
    } else if (arg === "--identity") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.identityFile = next();
    } else if (arg === "--certificate") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.certificateFile = next();
    } else if (arg === "--ssh-port") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.sshPort = Number(next());
    } else if (arg === "--initial-route") {
      options.expectedInitialRoute = next();
    } else if (arg === "--mouse") {
      options.inputKind = "mouse";
    } else if (arg === "--screenshot") {
      options.screenshotCheckpoints = true;
    } else if (arg === "--step") {
      const [name, selector, routeAfter] = next().split("::");
      options.steps.push({ name, selector, routeAfter });
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runVisibleMachineSaleScenario(
      parseCliArgs(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
