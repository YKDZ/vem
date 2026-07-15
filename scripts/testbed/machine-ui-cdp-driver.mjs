#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const STRICT_TAURI_HOST = "tauri.localhost";
const DEFAULT_REMOTE_CDP_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_ROUTE_POLL_MS = 100;
const MAX_URL_LENGTH = 2_048;
const MAX_LABEL_LENGTH = 160;
const FORBIDDEN_CUSTOMER_ROUTES = [
  /^#\/home(?:\/|$)/i,
  /^#\/maintenance(?:\/|$)/i,
  /^#\/offline(?:\/|$)/i,
];

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
  if (typeof expected === "string") return route === expected;
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(route);
  }
  if (typeof expected === "function") return expected(route);
  throw new Error("expected route must be a string, RegExp, or predicate");
}

export function routeFromTauriUrl(value) {
  return new URL(String(value)).hash;
}

export function validateExpectedTargetBinding(binding) {
  if (!binding || typeof binding !== "object") {
    throw new Error("expectedTargetBinding is required");
  }
  for (const field of ["targetId", "processId", "sessionId"]) {
    if (typeof binding[field] !== "string" || binding[field].trim() === "") {
      throw new Error(`expectedTargetBinding.${field} is required`);
    }
  }
  return {
    targetId: binding.targetId.trim(),
    processId: binding.processId.trim(),
    sessionId: binding.sessionId.trim(),
  };
}

export function rewriteWebSocketDebuggerUrl(
  webSocketDebuggerUrl,
  forwardedEndpoint,
) {
  const original = new URL(String(webSocketDebuggerUrl));
  const forwarded = normalizeEndpointUrl(forwardedEndpoint);
  if (original.protocol !== "ws:" && original.protocol !== "wss:") {
    throw new Error("debugger websocket URL must use ws or wss");
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
  expectedTargetBinding,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!endpoint) throw new Error("endpoint is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const binding = validateExpectedTargetBinding(expectedTargetBinding);
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

  const candidates = targets.filter((candidate) =>
    isStrictTauriHashRouteUrl(candidate?.url),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `CDP target discovery requires exactly one strict tauri target; found ${candidates.length}`,
    );
  }
  const target = candidates[0];
  if (target.id !== binding.targetId) {
    throw new Error(
      `CDP target binding is stale: expected ${binding.targetId}, found ${String(target.id)}`,
    );
  }
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP target is missing webSocketDebuggerUrl");
  }
  return {
    ...target,
    route: routeFromTauriUrl(target.url),
    binding,
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
  startupTimeoutMs = DEFAULT_TIMEOUT_MS,
  startupPollMs = 25,
  shutdownTimeoutMs = 1_000,
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
  const tunnelSpec = `${formatSshHost(localHost)}:${selectedLocalPort}:${formatSshHost(remoteCdpHost)}:${remoteCdpPort}`;
  const args = [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    tunnelSpec,
    ...(sshPort ? ["-p", String(sshPort)] : []),
    ...(identityFile ? ["-i", identityFile] : []),
    ...(certificateFile ? ["-o", `CertificateFile=${certificateFile}`] : []),
    ...sshArgs,
    remote,
  ];
  let child;
  try {
    child = processAdapter.spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(`SSH tunnel spawn failed: ${error.message}`, {
      cause: error,
    });
  }
  if (!child || typeof child.once !== "function") {
    throw new Error("SSH process adapter returned an invalid child process");
  }

  let stderr = "";
  child.stderr?.on?.("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_096);
  });
  child.stderr?.resume?.();
  const endpointUrl = `http://${formatUrlHost(localHost)}:${selectedLocalPort}`;
  const startup = watchChildStartup(child, () => stderr);
  try {
    await Promise.race([
      processAdapter.waitForReady
        ? processAdapter.waitForReady({
            child,
            endpoint: endpointUrl,
            host: localHost,
            port: selectedLocalPort,
            timeoutMs: startupTimeoutMs,
            pollMs: startupPollMs,
          })
        : waitForTcpEndpoint({
            host: localHost,
            port: selectedLocalPort,
            timeoutMs: startupTimeoutMs,
            pollMs: startupPollMs,
          }),
      startup.failure,
    ]);
  } catch (error) {
    startup.stop();
    await terminateChildProcess(child, processAdapter, shutdownTimeoutMs).catch(
      () => {},
    );
    throw error;
  }
  startup.stop();

  let closed = false;
  return {
    endpoint: endpointUrl,
    process: child,
    async close() {
      if (closed) return;
      closed = true;
      await terminateChildProcess(child, processAdapter, shutdownTimeoutMs);
    },
  };
}

export class CdpClient {
  constructor(webSocketUrl, options = {}) {
    const url = new URL(String(webSocketUrl));
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("CDP WebSocket URL must use ws or wss");
    }
    this.webSocketUrl = url.toString();
    this.webSocketFactory =
      options.webSocketFactory ??
      ((value) => {
        if (typeof WebSocket !== "function") {
          throw new Error("WebSocket is unavailable");
        }
        return new WebSocket(value);
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
    requireBrowserWebSocket(socket);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(event));
    socket.addEventListener("close", () => this.#handleClose());
    socket.addEventListener("error", (event) => this.#handleError(event));
    if (socket.readyState === 1) return this;
    await waitForSocketEvent(socket, "open", {
      timeoutMs,
      errorLabel: "CDP WebSocket failed to open",
    });
    return this;
  }

  async send(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (!this.socket || this.closed || this.socket.readyState !== 1) {
      throw new Error("CDP client is closed");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return;
      rejectResponse(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(id, {
      method,
      resolve: resolveResponse,
      reject: rejectResponse,
      timer,
    });
    try {
      this.socket.send(payload);
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw new Error(`CDP ${method} send failed: ${error.message}`, {
        cause: error,
      });
    }
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

  async close({ timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed && this.socket?.readyState === 3) return;
    this.closed = true;
    this.#rejectPending(new Error("CDP client closed"));
    const socket = this.socket;
    if (!socket || socket.readyState === 3) return;
    const closed = waitForSocketEvent(socket, "close", {
      timeoutMs,
      listenForError: false,
    });
    if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    await closed;
  }

  #handleMessage(event) {
    let message;
    try {
      if (typeof event?.data !== "string") {
        throw new Error("browser WebSocket message data must be a string");
      }
      message = JSON.parse(event.data);
    } catch (error) {
      this.#handleError(error);
      return;
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
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
        try {
          handler(message.params ?? {});
        } catch (error) {
          this.#handleError(error);
        }
      }
    }
  }

  #handleClose() {
    this.closed = true;
    this.#rejectPending(new Error("CDP connection closed"));
  }

  #handleError(event) {
    const error =
      event instanceof Error
        ? event
        : new Error(event?.message ?? "CDP WebSocket error");
    this.#rejectPending(error);
  }

  #rejectPending(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`${error.message} before ${pending.method}`, {
          cause: error,
        }),
      );
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
  const identity = await evaluateExpression(
    client,
    `(() => {
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
        domLength: html.length,
        domHash: hash.toString(16).padStart(8, "0")
      };
    })()`,
    options,
  );
  return boundIdentity(identity);
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
  if (typeof result.data !== "string") {
    throw new Error("Page.captureScreenshot returned no image data");
  }
  const bytes = Buffer.from(result.data, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let ref = null;
  if (options.screenshotSink) {
    const sinkResult = await options.screenshotSink({
      bytes,
      sha256,
      format: options.format ?? "png",
      label: options.label ?? "screenshot",
    });
    ref = typeof sinkResult === "string" ? sinkResult : sinkResult?.ref;
    if (typeof ref !== "string" || ref.trim() === "" || ref.length > 1_024) {
      throw new Error("screenshot sink must return a bounded nonempty ref");
    }
  }
  return {
    sha256,
    byteLength: bytes.length,
    format: options.format ?? "png",
    ref,
  };
}

export async function captureCheckpoint(client, label, options = {}) {
  const capturedAt = nowIso(options.clock);
  const identity = await captureDomIdentity(client, options);
  return {
    type: "checkpoint",
    label: boundedString(label, MAX_LABEL_LENGTH),
    capturedAt,
    identity,
    screenshot:
      options.screenshot === true
        ? await captureScreenshot(client, { ...options, label })
        : null,
  };
}

export async function probeSelectorBounds(client, selector, options = {}) {
  if (typeof selector !== "string" || selector.trim() === "") {
    throw new Error("selector is required");
  }
  return evaluateExpression(
    client,
    `(() => {
      const selector = ${JSON.stringify(selector)};
      const element = document.querySelector(selector);
      if (!element) return { selector, exists: false, actionable: false };
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      const inViewport = (
        rect.left >= 0 && rect.top >= 0 &&
        rect.right <= innerWidth && rect.bottom <= innerHeight
      );
      const hit = inViewport ? document.elementFromPoint(center.x, center.y) : null;
      const hitTarget = hit === element || element.contains(hit);
      const actionable = (
        rect.width > 0 && rect.height > 0 && inViewport && hitTarget &&
        style.visibility !== "hidden" && style.display !== "none" &&
        style.pointerEvents !== "none" && Number(style.opacity || "1") > 0 &&
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-disabled") !== "true"
      );
      return {
        selector,
        exists: true,
        actionable,
        inViewport,
        pointerEvents: style.pointerEvents,
        hitTarget,
        bounds: {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left
        },
        center
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
  if (kind !== "touch" && kind !== "mouse") {
    throw new Error("input kind must be touch or mouse");
  }

  const method =
    kind === "touch" ? "Input.dispatchTouchEvent" : "Input.dispatchMouseEvent";
  let primaryError;
  try {
    await client.send(
      method,
      kind === "touch"
        ? {
            type: "touchStart",
            touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }],
          }
        : { type: "mousePressed", x, y, button: "left", clickCount: 1 },
      { timeoutMs },
    );
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await client.send(
        method,
        kind === "touch"
          ? { type: "touchEnd", touchPoints: [] }
          : { type: "mouseReleased", x, y, button: "left", clickCount: 1 },
        { timeoutMs },
      );
    } catch (releaseError) {
      if (!primaryError) primaryError = releaseError;
    }
  }
  if (primaryError) throw primaryError;
  return { method, kind, x, y, released: true };
}

export async function activateVisibleSelector(client, selector, options = {}) {
  const probe = await probeSelectorBounds(client, selector, options);
  if (!probe?.actionable) {
    throw new Error(`selector is not physically actionable: ${selector}`);
  }
  const input = await dispatchPhysicalInput(client, probe.center, options);
  return {
    selector,
    center: probe.center,
    bounds: probe.bounds,
    input,
  };
}

export async function waitForRoute(client, expected, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_ROUTE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastIdentity = null;
  do {
    options.assertHealthy?.();
    lastIdentity = await captureDomIdentity(client, options);
    assertAllowedRoute(lastIdentity.route, options.forbiddenRoutes);
    if (matchesRoute(lastIdentity.route, expected)) return lastIdentity;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  options.assertHealthy?.();
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
  let inFlight = null;
  let failure = null;
  let ordinal = options.startOrdinal ?? 0;

  const capture = () => {
    if (stopped || inFlight || failure) return;
    inFlight = captureCheckpoint(client, options.label ?? "continuous", options)
      .then((checkpoint) => {
        checkpoint.ordinal = ordinal++;
        assertAllowedRoute(checkpoint.identity.route, options.forbiddenRoutes);
        checkpoints.push(checkpoint);
      })
      .catch((error) => {
        failure = new Error(`continuous capture failed: ${error.message}`, {
          cause: error,
        });
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(capture, intervalMs);
  timer.unref?.();
  return {
    checkpoints,
    throwIfFailed() {
      if (failure) throw failure;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      if (failure) throw failure;
      return checkpoints;
    },
  };
}

export async function runVisibleMachineSaleScenario(options = {}) {
  const {
    endpoint,
    tunnelOptions = {},
    fetchImpl,
    webSocketFactory,
    expectedTargetBinding,
    expectedInitialRoute,
    sequenceName,
    steps,
    adapter = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    routePollMs = DEFAULT_ROUTE_POLL_MS,
    inputKind = "touch",
    continuousCapture = true,
    continuousCaptureIntervalMs = 500,
    screenshotCheckpoints = false,
    forbiddenRoutes = FORBIDDEN_CUSTOMER_ROUTES,
    clock,
  } = options;
  const sequence = validateScenarioSequence({ sequenceName, steps });
  const binding = validateExpectedTargetBinding(expectedTargetBinding);
  if (expectedInitialRoute == null) {
    throw new Error("expectedInitialRoute is required");
  }

  const sidecar = await openMachineUiCdpSidecar({ endpoint, ...tunnelOptions });
  let client;
  let capture;
  let unsubscribeAdapterRoutes;
  let scenarioError;
  let scenarioResult;
  const evidence = [];
  let ordinal = 0;
  let fatalError = null;
  const record = (entry) => {
    const item = {
      ...entry,
      capturedAt: entry.capturedAt ?? nowIso(clock),
      ordinal: ordinal++,
    };
    evidence.push(item);
    return item;
  };
  const classifyRouteEvent = (event, source = "adapter") => {
    try {
      const identity = boundIdentity(event?.identity ?? event);
      assertAllowedRoute(identity.route, forbiddenRoutes);
      record({ type: "route-changed", source, identity });
    } catch (error) {
      fatalError = new Error(`route capture failed: ${error.message}`, {
        cause: error,
      });
    }
  };
  const assertHealthy = () => {
    capture?.throwIfFailed();
    if (fatalError) throw fatalError;
  };

  try {
    const target = await discoverMachineUiTarget({
      endpoint: sidecar.endpoint,
      expectedTargetBinding: binding,
      fetchImpl,
      timeoutMs,
    });
    if (!matchesRoute(target.route, expectedInitialRoute)) {
      throw new Error(
        `initial CDP target route mismatch: expected ${formatExpectedRoute(expectedInitialRoute)}, got ${target.route}`,
      );
    }
    assertAllowedRoute(target.route, forbiddenRoutes);
    const webSocketUrl = rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      sidecar.endpoint,
    );
    client = new CdpClient(webSocketUrl, {
      webSocketFactory,
      defaultTimeoutMs: timeoutMs,
    });
    await client.connect({ timeoutMs });

    // Route listeners are installed before protocol enablement or scenario actions.
    const offWithinDocument = client.on(
      "Page.navigatedWithinDocument",
      (params) => classifyRouteEvent({ url: params.url }, "cdp"),
    );
    const offFrameNavigated = client.on("Page.frameNavigated", (params) => {
      if (params.frame?.parentId == null) {
        classifyRouteEvent({ url: params.frame?.url }, "cdp");
      }
    });
    const offCdpRoutes = () => {
      offWithinDocument();
      offFrameNavigated();
    };
    unsubscribeAdapterRoutes = offCdpRoutes;
    if (adapter.subscribeRouteChanges) {
      const offAdapter = adapter.subscribeRouteChanges((event) =>
        classifyRouteEvent(event, "adapter"),
      );
      if (typeof offAdapter !== "function") {
        throw new Error(
          "subscribeRouteChanges must return an unsubscribe function",
        );
      }
      unsubscribeAdapterRoutes = () => {
        offAdapter();
        offCdpRoutes();
      };
    }

    await enablePageRuntime(client);
    assertHealthy();
    capture = continuousCapture
      ? startContinuousIdentityCapture(client, {
          intervalMs: continuousCaptureIntervalMs,
          screenshot: screenshotCheckpoints,
          screenshotSink: adapter.screenshotSink,
          forbiddenRoutes,
          timeoutMs,
          clock,
          startOrdinal: 1_000_000,
        })
      : null;

    const initial = await captureCheckpoint(client, "initial", {
      timeoutMs,
      screenshot: screenshotCheckpoints,
      screenshotSink: adapter.screenshotSink,
      clock,
    });
    assertAllowedRoute(initial.identity.route, forbiddenRoutes);
    assertRouteIdentity(initial.identity, expectedInitialRoute, "initial");
    record(initial);

    for (const step of sequence) {
      assertHealthy();
      if (step.type === "customer-activation") {
        const before = await waitForRoute(client, step.routeBefore, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
          forbiddenRoutes,
          assertHealthy,
        });
        assertRouteIdentity(before, step.routeBefore, `${step.name} before`);
        const activation = await activateVisibleSelector(
          client,
          step.selector,
          {
            kind: step.inputKind ?? inputKind,
            timeoutMs: step.timeoutMs ?? timeoutMs,
          },
        );
        if (!activation.input.method.startsWith("Input.")) {
          throw new Error(`${step.name} emitted no physical Input evidence`);
        }
        record({
          type: "customer-activation",
          label: step.name,
          selector: step.selector,
          input: activation.input,
          routeBefore: before.route,
        });
        assertHealthy();
        const after = await waitForRoute(client, step.routeAfter, {
          timeoutMs: step.timeoutMs ?? timeoutMs,
          pollMs: routePollMs,
          forbiddenRoutes,
          assertHealthy,
        });
        assertRouteIdentity(after, step.routeAfter, `${step.name} after`);
      } else {
        await step.run({
          client,
          step,
          record,
          expectedTargetBinding: binding,
        });
        assertHealthy();
      }
      const checkpoint = await captureCheckpoint(client, step.name, {
        timeoutMs: step.timeoutMs ?? timeoutMs,
        screenshot: screenshotCheckpoints || step.screenshot === true,
        screenshotSink: adapter.screenshotSink,
        clock,
      });
      assertAllowedRoute(checkpoint.identity.route, forbiddenRoutes);
      record(checkpoint);
    }

    const final = await captureCheckpoint(client, "final", {
      timeoutMs,
      screenshot: screenshotCheckpoints,
      screenshotSink: adapter.screenshotSink,
      clock,
    });
    assertAllowedRoute(final.identity.route, forbiddenRoutes);
    record(final);
    assertHealthy();
    const continuous = capture ? await capture.stop() : [];
    capture = null;
    scenarioResult = {
      schemaVersion: "machine-ui-cdp-sale-scenario/v2",
      status: "passed",
      sequenceName: boundedString(sequenceName, MAX_LABEL_LENGTH),
      target: {
        id: target.id,
        route: target.route,
        binding,
      },
      evidence: sortChronologically([...evidence, ...continuous]),
    };
  } catch (error) {
    scenarioError = error;
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => unsubscribeAdapterRoutes?.()),
      capture?.stop() ?? Promise.resolve(),
      client?.close() ?? Promise.resolve(),
      sidecar.close(),
    ]);
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (!scenarioError && failures.length > 0) {
      scenarioError = new AggregateError(
        failures.map((result) => result.reason),
        "machine UI CDP cleanup failed",
      );
    }
  }
  if (scenarioError) throw scenarioError;
  return scenarioResult;
}

function validateScenarioSequence({ sequenceName, steps }) {
  if (typeof sequenceName !== "string" || sequenceName.trim() === "") {
    throw new Error("sequenceName is required");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("scenario requires a nonempty step sequence");
  }
  let customerActivations = 0;
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== "object") {
      throw new Error(`scenario step ${index + 1} must be an object`);
    }
    if (typeof step.name !== "string" || step.name.trim() === "") {
      throw new Error(`scenario step ${index + 1} requires a name`);
    }
    if (step.type === "customer-activation") {
      customerActivations += 1;
      for (const field of ["selector", "routeBefore", "routeAfter"]) {
        if (step[field] == null || step[field] === "") {
          throw new Error(`${step.name} customer activation requires ${field}`);
        }
      }
      if (step.run || step.action) {
        throw new Error(
          `${step.name} customer activation cannot use a custom action`,
        );
      }
    } else if (step.type === "observation" || step.type === "infrastructure") {
      if (typeof step.run !== "function") {
        throw new Error(`${step.name} ${step.type} step requires run`);
      }
    } else {
      throw new Error(
        `${step.name} has unsupported step type ${String(step.type)}`,
      );
    }
  }
  if (customerActivations === 0) {
    throw new Error("sale scenario requires at least one customer activation");
  }
  return steps;
}

function assertAllowedRoute(
  route,
  forbiddenRoutes = FORBIDDEN_CUSTOMER_ROUTES,
) {
  if (typeof route !== "string" || !route.startsWith("#/")) {
    throw new Error(`invalid machine route: ${String(route)}`);
  }
  if (forbiddenRoutes.some((candidate) => matchesRoute(route, candidate))) {
    throw new Error(`forbidden customer route observed: ${route}`);
  }
}

function boundIdentity(identity) {
  if (!identity || typeof identity !== "object") {
    throw new Error("DOM identity capture returned no object");
  }
  let url;
  try {
    url = new URL(String(identity.url));
  } catch {
    throw new Error("DOM identity capture returned an invalid URL");
  }
  if (!isStrictTauriHashRouteUrl(url.toString())) {
    throw new Error(`DOM identity URL is not a strict tauri route: ${url}`);
  }
  return {
    url: boundedString(url.toString(), MAX_URL_LENGTH),
    route: url.hash,
    pathname: boundedString(identity.pathname ?? url.pathname, 256),
    title: boundedString(identity.title ?? "", MAX_LABEL_LENGTH),
    readyState: boundedString(identity.readyState ?? "unknown", 32),
    activeElement:
      identity.activeElement == null
        ? null
        : boundedString(identity.activeElement, 64),
    domLength: Number.isSafeInteger(identity.domLength)
      ? identity.domLength
      : null,
    domHash:
      typeof identity.domHash === "string"
        ? boundedString(identity.domHash, 128)
        : null,
  };
}

function sortChronologically(items) {
  return items.sort((left, right) => {
    const time = String(left.capturedAt).localeCompare(
      String(right.capturedAt),
    );
    return time || Number(left.ordinal ?? 0) - Number(right.ordinal ?? 0);
  });
}

function normalizeEndpoint(endpoint) {
  const url = normalizeEndpointUrl(endpoint);
  url.pathname = url.pathname.replace(/\/json\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeEndpointUrl(endpoint) {
  const url = new URL(String(endpoint));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("forwarded endpoint must use http or https");
  }
  return url;
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

function requireBrowserWebSocket(socket) {
  if (
    !socket ||
    typeof socket.addEventListener !== "function" ||
    typeof socket.removeEventListener !== "function" ||
    typeof socket.send !== "function" ||
    typeof socket.close !== "function"
  ) {
    throw new Error(
      "WebSocket adapter must implement the browser WebSocket EventTarget interface",
    );
  }
}

async function waitForSocketEvent(
  socket,
  eventName,
  { timeoutMs, errorLabel, listenForError = true },
) {
  let eventHandler;
  let errorHandler;
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        eventHandler = resolve;
        errorHandler = () => reject(new Error(errorLabel ?? "WebSocket error"));
        socket.addEventListener(eventName, eventHandler, { once: true });
        if (listenForError) {
          socket.addEventListener("error", errorHandler, { once: true });
        }
      }),
      timeoutMs,
      `CDP WebSocket ${eventName}`,
    );
  } finally {
    socket.removeEventListener(eventName, eventHandler);
    if (listenForError) socket.removeEventListener("error", errorHandler);
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

async function waitForTcpEndpoint({ host, port, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      await new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `SSH tunnel readiness timed out: ${lastError?.message ?? "unreachable"}`,
  );
}

function watchChildStartup(child, getStderr) {
  let onError;
  let onExit;
  const failure = new Promise((_, reject) => {
    onError = (error) =>
      reject(
        new Error(`SSH tunnel process error: ${error.message}`, {
          cause: error,
        }),
      );
    onExit = (code, signal) => {
      const detail = getStderr().trim();
      reject(
        new Error(
          `SSH tunnel exited before readiness (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ""}`,
        ),
      );
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return {
    failure,
    stop() {
      child.removeListener?.("error", onError);
      child.removeListener?.("exit", onExit);
    },
  };
}

async function terminateChildProcess(child, processAdapter, timeoutMs) {
  if (!child || child.exitCode != null) return;
  const wait = (limit) =>
    processAdapter.waitForExit?.(child, limit) ?? waitForExit(child, limit);
  child.kill?.("SIGTERM");
  try {
    await wait(timeoutMs);
  } catch {
    if (child.exitCode != null) return;
    child.kill?.("SIGKILL");
    await wait(timeoutMs);
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) return;
  let onExit;
  let onError;
  await withTimeout(
    new Promise((resolve, reject) => {
      onExit = resolve;
      onError = reject;
      child.once("exit", onExit);
      child.once("error", onError);
    }),
    timeoutMs,
    "child process exit",
  ).finally(() => {
    child.removeListener?.("exit", onExit);
    child.removeListener?.("error", onError);
  });
}

function formatSshHost(host) {
  return String(host).includes(":") ? `[${host}]` : String(host);
}

function formatUrlHost(host) {
  return String(host).includes(":") ? `[${host}]` : String(host);
}

function boundedString(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function nowIso(clock) {
  const value = clock?.() ?? new Date();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function formatExpectedRoute(expected) {
  if (expected instanceof RegExp) return expected.toString();
  if (typeof expected === "function") return "predicate";
  return JSON.stringify(expected);
}

const defaultProcessAdapter = { spawn };

function parseCliArgs(argv) {
  const options = { steps: [], expectedTargetBinding: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--endpoint") options.endpoint = next();
    else if (arg === "--remote") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.remote = next();
    } else if (arg === "--identity") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.identityFile = next();
    } else if (arg === "--certificate") {
      options.tunnelOptions ??= {};
      options.tunnelOptions.certificateFile = next();
    } else if (arg === "--target-id") {
      options.expectedTargetBinding.targetId = next();
    } else if (arg === "--process-id") {
      options.expectedTargetBinding.processId = next();
    } else if (arg === "--session-id") {
      options.expectedTargetBinding.sessionId = next();
    } else if (arg === "--sequence") options.sequenceName = next();
    else if (arg === "--initial-route") options.expectedInitialRoute = next();
    else if (arg === "--mouse") options.inputKind = "mouse";
    else if (arg === "--screenshot") options.screenshotCheckpoints = true;
    else if (arg === "--step") {
      const [name, selector, routeBefore, routeAfter] = next().split("::");
      options.steps.push({
        type: "customer-activation",
        name,
        selector,
        routeBefore,
        routeAfter,
      });
    } else throw new Error(`unknown argument: ${arg}`);
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
