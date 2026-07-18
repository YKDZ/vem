#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  activateVisibleSelector,
  captureCheckpoint,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const MODES = new Set(["full"]);
const VISION_SITE_CONFIGURATION_PATH = "C:\\ProgramData\\VEM\\vision\\site.json";
const VISION_INSTALLED_RECORD_PATH =
  "C:\\ProgramData\\VEM\\vision\\installed.json";
const VISION_FIXTURE_ROOT = "C:\\ProgramData\\VEM\\vision\\fixtures";
const PLATFORM_LOG_REFERENCE = Object.freeze({
  unit: "vem-local-testbed-service-api",
  command: "journalctl -u vem-local-testbed-service-api --no-pager -n 200",
});

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function windowsAbsolute(value, label) {
  const path = required(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(`/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeReport(outPath, report) {
  const path = localPath(outPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function screenshotSink(outPath) {
  const root = join(
    dirname(localPath(outPath)),
    "vision-try-on-acceptance-artifacts",
  );
  mkdirSync(root, { recursive: true });
  return async ({ bytes, sha256, label, format }) => {
    const file = join(
      root,
      `${String(label).replaceAll(/[^a-z0-9-]+/gi, "-")}.${format}`,
    );
    writeFileSync(file, bytes);
    return { ref: file, sha256 };
  };
}

function writeBoundedLogTail(sourcePath, outPath, label, maxBytes = 64 * 1024) {
  if (typeof sourcePath !== "string" || sourcePath === "") return null;
  try {
    const bytes = readFileSync(localPath(sourcePath));
    const root = join(
      dirname(localPath(outPath)),
      "vision-try-on-acceptance-artifacts",
    );
    mkdirSync(root, { recursive: true });
    const destination = join(root, `${label}.tail.log`);
    writeFileSync(destination, bytes.subarray(Math.max(0, bytes.length - maxBytes)));
    return {
      ref: destination,
      source: sourcePath,
      byteLength: Math.min(bytes.length, maxBytes),
    };
  } catch {
    return { ref: null, source: sourcePath, byteLength: 0 };
  }
}

function compactRuntimeTrace(trace, maxEntries = 96) {
  return Array.isArray(trace) ? trace.slice(-maxEntries) : [];
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(handoff.daemon?.ready?.healthzUrl, "daemon healthzUrl");
  if (!healthzUrl.endsWith("/healthz")) {
    throw new Error("daemon healthzUrl must end with /healthz");
  }
  return healthzUrl.slice(0, -"/healthz".length);
}

function daemonHeaders(handoff) {
  return {
    authorization: `Bearer ${required(handoff.daemon?.ready?.ipcToken, "daemon ipcToken")}`,
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function daemonGet(handoff, path) {
  return fetchJson(`${daemonBaseUrl(handoff)}${path}`, {
    headers: daemonHeaders(handoff),
  });
}

async function waitForCondition(name, predicate, timeoutMs, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last?.ok) return last.value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(`${name} did not become true in ${timeoutMs} ms: ${JSON.stringify(last?.value ?? null)}`);
}

function isVisionProtocolTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  );
}

export function parseVisionTryOnAcceptanceArgs(args) {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) {
    throw new Error("--mode must be full");
  }
  return {
    mode,
    guestInputPath: windowsAbsolute(option(args, "guest-input"), "--guest-input"),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
  };
}

export function buildRecordedVisionSiteConfiguration({
  host = "127.0.0.1",
  port = 7892,
} = {}) {
  return {
    schemaVersion: "vending-vision-site-config/v1",
    host,
    port,
    allowed_origins: [
      "http://tauri.localhost",
      "https://tauri.localhost",
      `http://${host}:${port}`,
    ],
    cameras: {
      top: {
        source: "recorded_video",
        role: "presence",
        video_path: "recorded-video/top.mp4",
      },
      front: {
        source: "recorded_video",
        role: "profile_tryon",
        video_path: "recorded-video/front.mp4",
      },
    },
  };
}

function createVisionHello(machineCode) {
  return {
    protocol: "vem.vision.v1",
    type: "vision.hello",
    messageId: "vision-try-on-acceptance",
    timestamp: new Date().toISOString(),
    payload: {
      clientRole: "machine",
      machineCode: machineCode ?? null,
      protocolVersion: 1,
      capabilities: [
        "profile_push",
        "presence_status",
        "person_departed",
        "try_on_session",
      ],
    },
  };
}

async function openVisionSocket(url, timeoutMs = 8_000) {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`connect vision websocket timed out: ${url}`));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`connect vision websocket failed: ${url}`));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

async function nextVisionMessage(socket, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("waiting for vision message timed out"));
    }, timeoutMs);
    const onMessage = (event) => {
      cleanup();
      if (typeof event.data !== "string") {
        reject(new Error("vision websocket returned a non-text frame"));
        return;
      }
      try {
        resolve(JSON.parse(event.data));
      } catch (error) {
        reject(error);
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("vision websocket error"));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    }
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

export function validateVisionProtocolEvidence(evidence) {
  const health = evidence?.health ?? {};
  if (
    !["ok", "degraded"].includes(health.status) ||
    health.protocol !== "vem.vision.v1" ||
    health.modelReady !== true ||
    typeof health.cameraReady !== "boolean"
  ) {
    throw new Error("vision health evidence is invalid");
  }
  const ready = evidence?.ready ?? {};
  if (
    ready.protocol !== "vem.vision.v1" ||
    ready.type !== "vision.ready" ||
    typeof ready.messageId !== "string" ||
    ready.messageId.trim() === "" ||
    !isVisionProtocolTimestamp(ready.timestamp) ||
    typeof ready.payload?.serverName !== "string" ||
    ready.payload.serverName.trim() === "" ||
    ready.payload.modelReady !== true ||
    typeof ready.payload.cameraReady !== "boolean" ||
    !Array.isArray(ready.payload.capabilities)
  ) {
    throw new Error("vision ready handshake is invalid");
  }
  for (const capability of [
    "profile_push",
    "presence_status",
    "person_departed",
    "try_on_session",
  ]) {
    if (!ready.payload.capabilities.includes(capability)) {
      throw new Error(`vision ready handshake is missing ${capability}`);
    }
  }
  const presence = evidence?.presence ?? {};
  if (
    presence.type !== "vision.presence_status" ||
    presence.payload?.personPresent !== true ||
    !isVisionProtocolTimestamp(presence.payload?.detectedAt)
  ) {
    throw new Error("vision presence evidence is invalid");
  }
  const profile = evidence?.profile ?? {};
  if (
    profile.type !== "vision.profile_result" ||
    profile.payload?.profile?.personPresent !== true ||
    profile.payload?.quality?.profileUsable === false ||
    !isVisionProtocolTimestamp(profile.payload?.detectedAt)
  ) {
    throw new Error("vision profile evidence is invalid");
  }
  const departure = evidence?.departure ?? {};
  if (
    departure.type !== "vision.person_departed" ||
    !isVisionProtocolTimestamp(departure.payload?.detectedAt)
  ) {
    throw new Error("vision departure evidence is invalid");
  }
  return {
    healthStatus: health.status,
    readyServerName: ready.payload.serverName,
    readyServerVersion:
      typeof ready.payload.serverVersion === "string"
        ? ready.payload.serverVersion
        : null,
    capabilities: ready.payload.capabilities,
    presenceDetectedAt: presence.payload.detectedAt,
    profileDetectedAt: profile.payload.detectedAt,
    departureDetectedAt: departure.payload.detectedAt,
    profileUsable: profile.payload.quality?.profileUsable !== false,
  };
}

async function collectVisionProtocolEvidence({ machineCode, timeoutMs = 120_000 }) {
  const health = await fetchJson("http://127.0.0.1:7892/health");
  const socket = await openVisionSocket("ws://127.0.0.1:7892/ws");
  const observedMessages = [];
  try {
    socket.send(JSON.stringify(createVisionHello(machineCode)));
    const ready = await nextVisionMessage(socket, 10_000);
    observedMessages.push({
      type: ready?.type ?? null,
      messageId: ready?.messageId ?? null,
      timestamp: ready?.timestamp ?? null,
    });
    const state = {
      health,
      ready,
      presence: null,
      profile: null,
      departure: null,
      observedMessages,
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const message = await nextVisionMessage(socket, Math.max(1_000, deadline - Date.now()));
      observedMessages.push({
        type: message?.type ?? null,
        messageId: message?.messageId ?? null,
        timestamp: message?.timestamp ?? null,
      });
      if (message?.type === "vision.presence_status" && state.presence === null) {
        state.presence = message;
      } else if (message?.type === "vision.profile_result" && state.profile === null) {
        state.profile = message;
      } else if (message?.type === "vision.person_departed" && state.departure === null) {
        state.departure = message;
      }
      if (state.presence && state.profile && state.departure) {
        return state;
      }
    }
    throw new Error(
      `vision protocol did not produce presence/profile/departure within ${timeoutMs} ms`,
    );
  } finally {
    socket.close();
  }
}

async function readRuntimeTrace(client) {
  return evaluateExpression(client, "window.__VEM_MACHINE_RUNTIME_TRACE__ || []");
}

async function readCatalogRecommendationState(client) {
  return evaluateExpression(
    client,
    `(() => {
      const el = document.querySelector("[data-test='catalog-page']");
      return el ? {
        route: location.hash,
        recommendationActive: el.dataset.visionRecommendationActive || "false",
      } : null;
    })()`,
  );
}

async function waitForCatalogRecommendation(client, timeoutMs = 90_000) {
  return waitForCondition(
    "catalog recommendation",
    async () => {
      const state = await readCatalogRecommendationState(client);
      return {
        ok:
          state?.route === "#/catalog" &&
          state?.recommendationActive === "true",
        value: state,
      };
    },
    timeoutMs,
    500,
  );
}

async function readProductDetailState(client) {
  return evaluateExpression(
    client,
    `(() => {
      const page = document.querySelector("[data-test='product-detail-page']");
      const tryOn = document.querySelector("[data-test='try-on-entry']");
      const buy = document.querySelector("[data-test='product-buy']");
      return page ? {
        route: location.hash,
        catalogKey: page.dataset.catalogKey || null,
        variantId: page.dataset.variantId || null,
        tryOnPresent: !!tryOn,
        tryOnDisabled: tryOn ? tryOn.disabled === true : null,
        buyDisabled: buy ? buy.disabled === true : null,
      } : null;
    })()`,
  );
}

async function waitForTryOnSurface(client, timeoutMs = 60_000) {
  return waitForCondition(
    "try-on preview surface",
    async () => {
      const state = await evaluateExpression(
        client,
        `(() => {
          const preview = document.querySelector("[data-test='try-on-preview']");
          const silhouette = document.querySelector("[data-test='try-on-silhouette']");
          const error = document.querySelector("[data-test='try-on-error']");
          return {
            route: location.hash,
            previewUrl: preview?.getAttribute("src") ?? null,
            silhouetteUrl: silhouette?.getAttribute("src") ?? null,
            errorText: error?.textContent?.trim() ?? null,
          };
        })()`,
      );
      return {
        ok:
          typeof state?.previewUrl === "string" &&
          state.previewUrl.startsWith("http://127.0.0.1:7892/try-on/") &&
          typeof state?.silhouetteUrl === "string" &&
          state.silhouetteUrl.includes("/api/media-assets/") &&
          !state.errorText,
        value: state,
      };
    },
    timeoutMs,
    500,
  );
}

async function stopVisionRuntime() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Stop-ScheduledTask -TaskName 'StartVisionServer' -TaskPath '\\VEM\\' -ErrorAction SilentlyContinue",
    "Get-Process vending-vision -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
  ].join("; ");
  await new Promise((resolvePromise, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-Command", command], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`pwsh exited with ${code ?? "signal"} while stopping Vision runtime`));
    });
  });
}

async function waitForVisionDegradation(handoff, timeoutMs = 45_000) {
  return waitForCondition(
    "vision degradation",
    async () => {
      const [visionStatus, saleCapability, healthz, readyz] = await Promise.all([
        daemonGet(handoff, "/v1/vision/status").catch(() => null),
        daemonGet(handoff, "/v1/sale-start-capability").catch(() => null),
        daemonGet(handoff, "/healthz").catch(() => null),
        daemonGet(handoff, "/readyz").catch(() => null),
      ]);
      return {
        ok:
          visionStatus?.online === false &&
          saleCapability?.canStartSale === true &&
          readyz?.ready === true,
        value: { visionStatus, saleCapability, healthz, readyz },
      };
    },
    timeoutMs,
    1_000,
  );
}

async function waitForTryOnButtonDisabled(client, timeoutMs = 30_000) {
  return waitForCondition(
    "try-on degradation button state",
    async () => {
      const state = await readProductDetailState(client);
      return {
        ok: state?.tryOnPresent === true && state?.tryOnDisabled === true,
        value: state,
      };
    },
    timeoutMs,
    500,
  );
}

async function runVisionTryOnAcceptance(options) {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const handoff = readJson(options.handoffPath, "handoff");
  const sink = screenshotSink(options.outPath);
  let client = null;
  const checkpoints = [];
  let stage = "connect-installed-tauri-cdp";
  try {
    const installedRecord = readJson(
      VISION_INSTALLED_RECORD_PATH,
      "installed Vision record",
    );
    const siteConfiguration = readJson(
      VISION_SITE_CONFIGURATION_PATH,
      "Vision site configuration",
    );
    const target = await discoverMachineUiTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: handoff.cdp.targetId,
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, "http://127.0.0.1:9222"),
    );
    await client.connect();
    await enablePageRuntime(client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });

    stage = "collect-vision-protocol";
    const protocolEvidence = await collectVisionProtocolEvidence({
      machineCode: guestInput.machineCode,
    });
    const protocolSummary = validateVisionProtocolEvidence(protocolEvidence);

    stage = "wait-catalog-recommendation";
    const catalogRecommendation = await waitForCatalogRecommendation(client);
    checkpoints.push(
      await captureCheckpoint(client, "catalog-recommendation", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );

    stage = "open-tshirt-product";
    await activateVisibleSelector(
      client,
      '[data-test="catalog-category"][data-category-key="tshirts"]',
      { kind: "touch", timeoutMs: 30_000 },
    );
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
    await activateVisibleSelector(client, '[data-test="catalog-product"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const productDetail = await readProductDetailState(client);
    assert.equal(productDetail?.tryOnPresent, true);
    assert.equal(productDetail?.tryOnDisabled, false);

    stage = "open-try-on";
    await activateVisibleSelector(client, '[data-test="try-on-entry"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/products\/.+\/try-on/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const tryOnSurface = await waitForTryOnSurface(client, 60_000);
    checkpoints.push(
      await captureCheckpoint(client, "try-on-preview", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );

    stage = "return-from-try-on";
    await activateVisibleSelector(client, '[data-test="try-on-exit"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });

    const capabilityBeforeDegradation = await daemonGet(
      handoff,
      "/v1/sale-start-capability",
    );
    if (capabilityBeforeDegradation?.canStartSale !== true) {
      throw new Error("sale start capability must remain available before degradation");
    }

    stage = "stop-vision-runtime";
    await stopVisionRuntime();
    const degradedDaemon = await waitForVisionDegradation(handoff, 45_000);
    const degradedProductDetail = await waitForTryOnButtonDisabled(
      client,
      30_000,
    );
    checkpoints.push(
      await captureCheckpoint(client, "vision-degraded-product", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );

    stage = "prove-sale-survives-degradation";
    await activateVisibleSelector(client, '[data-test="product-buy"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, "#/checkout", { timeoutMs: 30_000, pollMs: 250 });
    checkpoints.push(
      await captureCheckpoint(client, "degraded-checkout", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );

    const runtimeTrace = await readRuntimeTrace(client);
    const report = {
      schemaVersion: "vem-vision-try-on-acceptance/v1",
      ok: true,
      mode: options.mode,
      machineCode: guestInput.machineCode,
      visionInstall: {
        installedRecord,
        siteConfiguration,
        fixtureRoot: VISION_FIXTURE_ROOT,
      },
      health: {
        daemon: {
          healthz: degradedDaemon.healthz,
          readyz: degradedDaemon.readyz,
          visionStatus: degradedDaemon.visionStatus,
          saleCapabilityBeforeDegradation: capabilityBeforeDegradation,
          saleCapabilityAfterDegradation: degradedDaemon.saleCapability,
        },
        vision: {
          protocolSummary,
          observedMessages: protocolEvidence.observedMessages.slice(0, 8),
        },
      },
      ui: {
        catalogRecommendation,
        productDetail,
        tryOnSurface,
        degradedProductDetail,
        finalRoute: "#/checkout",
      },
      runtimeTrace: compactRuntimeTrace(runtimeTrace),
      checkpoints,
      logs: {
        daemonStdout: writeBoundedLogTail(
          handoff?.daemon?.logs?.stdout,
          options.outPath,
          "daemon-stdout",
        ),
        daemonStderr: writeBoundedLogTail(
          handoff?.daemon?.logs?.stderr,
          options.outPath,
          "daemon-stderr",
        ),
        platform: PLATFORM_LOG_REFERENCE,
        milestones: checkpoints.map((checkpoint) => ({
          label: checkpoint.label,
          route: checkpoint.identity.route,
          screenshot: checkpoint.screenshot?.ref ?? null,
        })),
      },
    };
    writeReport(options.outPath, report);
    return report;
  } catch (error) {
    const failureTrace = client ? await readRuntimeTrace(client).catch(() => []) : [];
    const failureCheckpoint = client
      ? await captureCheckpoint(client, `failure-${stage}`, {
          screenshot: true,
          screenshotSink: sink,
        }).catch(() => null)
      : null;
    const failureCheckpoints = failureCheckpoint
      ? [...checkpoints, failureCheckpoint]
      : [...checkpoints];
    const report = {
      schemaVersion: "vem-vision-try-on-acceptance/v1",
      ok: false,
      mode: options.mode,
      stage,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: String(error.stack ?? "").slice(0, 16 * 1024),
            }
          : { name: "Error", message: String(error) },
      runtimeTrace: compactRuntimeTrace(failureTrace, 128),
      checkpoints: failureCheckpoints,
      logs: {
        daemonStdout: writeBoundedLogTail(
          handoff?.daemon?.logs?.stdout,
          options.outPath,
          "daemon-stdout",
        ),
        daemonStderr: writeBoundedLogTail(
          handoff?.daemon?.logs?.stderr,
          options.outPath,
          "daemon-stderr",
        ),
        platform: PLATFORM_LOG_REFERENCE,
      },
    };
    writeReport(options.outPath, report);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
  }
}

async function main() {
  const options = parseVisionTryOnAcceptanceArgs(process.argv.slice(2));
  const result = await runVisionTryOnAcceptance(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
