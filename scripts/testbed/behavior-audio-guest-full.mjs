#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { validateBehaviorAudioAcceptanceEvidence } from "./behavior-audio-acceptance.mjs";
import {
  ensureControlledVisionMock,
  shutdownControlledVisionMock,
  waitForControlledVisionRuntimeClient,
  waitForSaleStartReady,
} from "./fast-route-stress-sale.mjs";
import {
  activateVisibleSelector,
  captureScreenshot,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

const MODE = "full";
const SHORT_EMPTY_MS = 1_000;
const SUSTAINED_EMPTY_MS = 3_500;
const TRACE_TIMEOUT_MS = 30_000;

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

function localPath(path) {
  return process.platform === "win32"
    ? path
    : resolve(
        `/mnt/${path[0].toLowerCase()}/${path.slice(3).replaceAll("\\", "/")}`,
      );
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(localPath(path), "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function writeText(path, value) {
  const target = localPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, String(value), { mode: 0o600 });
}

async function captureScreenshotArtifact(client, path) {
  return captureScreenshot(client, {
    format: "png",
    label: "behavior-audio-final",
    screenshotSink: async ({ bytes }) => {
      writeFileSync(path, bytes, { mode: 0o600 });
      return { ref: path };
    },
  });
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function optionalOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : required(args[index + 1], `--${name}`);
}

export function parseBehaviorAudioGuestArgs(args) {
  const allowed = new Set([
    "--mode",
    "--guest-input",
    "--handoff",
    "--out",
    "--fixture-key",
  ]);
  for (const value of args) {
    if (value.startsWith("--") && !allowed.has(value)) {
      throw new Error(`unsupported behavior-audio option: ${value}`);
    }
  }
  const mode = required(option(args, "mode"), "--mode");
  if (mode !== MODE) throw new Error("--mode must be full");
  return {
    mode,
    guestInputPath: windowsAbsolute(
      option(args, "guest-input"),
      "--guest-input",
    ),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
    fixtureKey: optionalOption(args, "fixture-key"),
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${url} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function controlPlaneRequest(guestInput, path, body = {}) {
  const controlPlane = guestInput?.hostControlPlane;
  if (!controlPlane?.endpoint || !controlPlane?.token) {
    throw new Error(
      "guest input is missing hostControlPlane endpoint and token",
    );
  }
  return fetchJson(`${controlPlane.endpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${controlPlane.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function visionControlPort(guestInput) {
  const port = Number(
    guestInput?.hostControlPlane?.visionMockControlPort ??
      guestInput?.visionMockControlPort,
  );
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("guest input is missing vision mock control port");
  }
  return port;
}

async function injectVisionPresence(guestInput, state, dependencies) {
  if (state !== "approach" && state !== "empty")
    throw new Error("Vision presence state is invalid");
  const port = visionControlPort(guestInput);
  return dependencies.fetchJson(`http://127.0.0.1:${port}/control/presence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state }),
  });
}

function traceId(trace) {
  return trace.reduce(
    (maximum, entry) => Math.max(maximum, Number(entry?.id) || 0),
    0,
  );
}

function traceEntryAfter(trace, boundary, predicate) {
  return trace.find(
    (entry) => Number(entry?.id) > boundary && predicate(entry),
  );
}

async function waitForTraceEntry(
  readTrace,
  boundary,
  predicate,
  dependencies,
  label,
) {
  const deadline = dependencies.now() + TRACE_TIMEOUT_MS;
  let last = [];
  do {
    last = await readTrace();
    const entry = traceEntryAfter(last, boundary, predicate);
    if (entry) return { entry, trace: last };
    await dependencies.sleep(100);
  } while (dependencies.now() < deadline);
  throw new Error(
    `${label} was not observed in Machine runtimeTrace: ${JSON.stringify(last.slice(-12))}`,
  );
}

async function waitForAudioLifecycle(
  readTrace,
  boundary,
  transitionPredicate,
  dependencies,
  label,
) {
  const transition = await waitForTraceEntry(
    readTrace,
    boundary,
    (entry) =>
      entry?.type === "journey_transition" && transitionPredicate(entry),
    dependencies,
    `${label} transition`,
  );
  const transitionId = required(
    transition.entry.transitionId,
    `${label} transitionId`,
  );
  const terminal = await waitForTraceEntry(
    readTrace,
    Number(transition.entry.id),
    (entry) =>
      entry?.type === "audio_terminal" &&
      entry?.transitionId === transitionId &&
      entry?.outcome === "completed",
    dependencies,
    `${label} native audio terminal`,
  );
  const lifecycle = terminal.trace.filter(
    (entry) => entry?.transitionId === transitionId,
  );
  const started = lifecycle.filter((entry) => entry?.type === "audio_started");
  if (started.length !== 1 || started[0]?.message !== "native") {
    throw new Error(`${label} did not use exactly one native audio start`);
  }
  return {
    transitionId,
    terminalTraceId: Number(terminal.entry.id),
    trace: terminal.trace,
  };
}

function categoryKeyFromTransition(transitionId) {
  const match = /^category:category-entry-([a-z0-9_-]+)-\d+$/i.exec(
    transitionId,
  );
  if (!match)
    throw new Error(`category transition id is invalid: ${transitionId}`);
  return match[1];
}

function categorySelector(key) {
  const normalized = required(key, "supported category key");
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`supported category key is invalid: ${normalized}`);
  }
  return `[data-test="catalog-category"][data-category-key="${normalized}"]:not(:disabled)`;
}

async function readSupportedCategoryKeys(client, dependencies) {
  const keys = await dependencies.evaluateExpression(
    client,
    `(() => Array.from(document.querySelectorAll('[data-test="catalog-category"]:not(:disabled)'))
      .map((element) => element.dataset.categoryKey || '')
      .filter(Boolean))()`,
  );
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("installed Catalog has no enabled product categories");
  }
  const normalized = keys.map((key) => required(key, "supported category key"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(
      "installed Catalog exposes duplicate enabled product categories",
    );
  }
  for (const key of normalized) categorySelector(key);
  return normalized;
}

function runtimeBinding(handoff, cdpIdentity) {
  const machine = handoff?.machine ?? {};
  return {
    processId: Number(machine.processId),
    executablePath: required(
      machine.executablePath,
      "handoff machine executablePath",
    ),
    principal: required(machine.principal, "handoff machine principal"),
    sessionId: Number(machine.sessionId),
    cdpTargetId: required(cdpIdentity?.targetId, "CDP targetId"),
    cdpSessionId: required(cdpIdentity?.sessionId, "CDP sessionId"),
  };
}

function captureSummary(stopReport) {
  const capture = stopReport?.capture;
  if (
    !capture ||
    !Number.isInteger(capture.nonSilentFrameCount) ||
    !Number.isInteger(capture.peakAbsoluteSample)
  ) {
    throw new Error("host default-audio stop report is incomplete");
  }
  return {
    nonSilentFrameCount: capture.nonSilentFrameCount,
    peakAbsoluteSample: capture.peakAbsoluteSample,
    startedAt: required(capture.startedAt, "audio capture startedAt"),
    completedAt: required(capture.completedAt, "audio capture completedAt"),
  };
}

function defaultDependencies() {
  return {
    readJson,
    writeJson,
    writeText,
    captureScreenshotArtifact,
    readTrace: (client) =>
      evaluateExpression(client, "window.__VEM_MACHINE_RUNTIME_TRACE__ || []"),
    fetchJson,
    controlPlaneRequest,
    ensureControlledVisionMock,
    waitForControlledVisionRuntimeClient,
    discoverTarget: discoverMachineUiTarget,
    createClient: (url) => new CdpClient(url),
    enablePageRuntime,
    waitForRoute,
    waitForSaleStartReady,
    activateVisibleSelector,
    evaluateExpression,
    rewriteWebSocketDebuggerUrl,
    sleep,
    now: () => Date.now(),
    randomUUID,
    artifactRoot: (outPath) =>
      join(dirname(localPath(outPath)), "behavior-audio-artifacts"),
    makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  };
}

export async function runBehaviorAudioGuestFull(options, injected = {}) {
  const dependencies = { ...defaultDependencies(), ...injected };
  const report = {
    schemaVersion: "vem-behavior-audio-guest-full/v1",
    ok: false,
    mode: options.mode,
    boundaries: {
      visionMock: false,
      machineCdp: false,
      windowsAudioCapture: false,
    },
    artifacts: null,
    behaviorAudio: null,
    error: null,
  };
  let guestInput = null;
  let handoff = null;
  let client = null;
  let vision = null;
  let audioCaptureId = null;
  let audioStopped = false;
  let runtimeTrace = [];
  let artifactRoot = null;

  try {
    guestInput = dependencies.readJson(options.guestInputPath, "guest input");
    handoff = dependencies.readJson(
      options.handoffPath,
      "installed runtime handoff",
    );
    artifactRoot = dependencies.artifactRoot(options.outPath);
    dependencies.makeDirectory(artifactRoot);
    const visionPort = visionControlPort(guestInput);
    vision = await dependencies.ensureControlledVisionMock(visionPort);
    await dependencies.waitForControlledVisionRuntimeClient(visionPort);
    report.boundaries.visionMock = true;

    const target = await dependencies.discoverTarget({
      endpoint: "http://127.0.0.1:9222",
      expectedTargetId: required(
        handoff?.cdp?.targetId,
        "handoff cdp targetId",
      ),
    });
    client = dependencies.createClient(
      dependencies.rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await dependencies.enablePageRuntime(client);
    await dependencies.waitForRoute(client, "#/catalog", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await dependencies.waitForSaleStartReady(handoff, client);
    report.boundaries.machineCdp = true;

    const cdpIdentity = await client.observeIdentity();
    const runtime = runtimeBinding(handoff, cdpIdentity);
    const sessionId = required(
      handoff?.commissioningSerialSession?.sessionId,
      "commissioning serial session id",
    );
    const operationId = `behavior-audio-${dependencies.randomUUID()}`;
    const audioStart = await dependencies.controlPlaneRequest(
      guestInput,
      "/v1/audio-captures/start",
      {
        sessionId,
        runId: required(guestInput.runId, "runId"),
        lifecycleReference: `vm-lifecycle://${required(guestInput.runId, "runId").toLowerCase()}.behavior-audio`,
        transactionId: `transaction://${required(guestInput.runId, "runId").toLowerCase()}.behavior-audio`,
        targetIdentity: required(
          guestInput.hostControlPlane?.targetIdentity,
          "hostControlPlane.targetIdentity",
        ),
        runtime,
        operationId,
      },
    );
    audioCaptureId = required(audioStart?.audioCaptureId, "audio capture id");
    dependencies.writeJson(
      join(artifactRoot, "audio-capture-start.json"),
      audioStart.startReport,
    );
    report.boundaries.windowsAudioCapture = true;

    const readTrace = async () => {
      runtimeTrace = await dependencies.readTrace(client);
      return runtimeTrace;
    };
    let boundary = traceId(await readTrace());
    await injectVisionPresence(guestInput, "approach", dependencies);
    const initialWelcome = await waitForAudioLifecycle(
      readTrace,
      boundary,
      (entry) => String(entry.transitionId).endsWith(":welcome"),
      dependencies,
      "initial welcome",
    );
    const checkpoints = [
      {
        label: "stable-arrival-settled",
        traceId: initialWelcome.terminalTraceId,
      },
    ];
    await injectVisionPresence(guestInput, "approach", dependencies);
    await dependencies.sleep(500);
    runtimeTrace = await readTrace();
    if (
      runtimeTrace.filter(
        (entry) =>
          entry?.type === "audio_started" &&
          String(entry?.transitionId).endsWith(":welcome"),
      ).length !== 1
    ) {
      throw new Error("duplicate initial Vision approach replayed welcome");
    }
    checkpoints.push({
      label: "initial-duplicate-approach-settled",
      traceId: traceId(runtimeTrace),
    });

    await injectVisionPresence(guestInput, "empty", dependencies);
    await dependencies.sleep(SHORT_EMPTY_MS);
    await injectVisionPresence(guestInput, "approach", dependencies);
    await dependencies.sleep(500);
    runtimeTrace = await readTrace();
    const transientWelcomes = runtimeTrace.filter(
      (entry) =>
        entry?.type === "audio_started" &&
        String(entry?.transitionId).endsWith(":welcome"),
    );
    if (transientWelcomes.length !== 1)
      throw new Error("transient Vision empty rearmed welcome");
    checkpoints.push({
      label: "transient-empty-recovered",
      traceId: traceId(runtimeTrace),
    });

    boundary = traceId(runtimeTrace);
    await injectVisionPresence(guestInput, "empty", dependencies);
    await dependencies.sleep(SUSTAINED_EMPTY_MS);
    const departure = await waitForTraceEntry(
      readTrace,
      boundary,
      (entry) =>
        entry?.type === "journey_transition" &&
        String(entry?.transitionId).endsWith(":departed"),
      dependencies,
      "sustained Vision departure",
    );
    checkpoints.push({
      label: "sustained-empty-departed",
      traceId: Number(departure.entry.id),
    });

    boundary = traceId(departure.trace);
    await injectVisionPresence(guestInput, "approach", dependencies);
    const rearmedWelcome = await waitForAudioLifecycle(
      readTrace,
      boundary,
      (entry) => String(entry.transitionId).endsWith(":welcome"),
      dependencies,
      "rearmed welcome",
    );
    checkpoints.push({
      label: "rearmed-arrival-settled",
      traceId: rearmedWelcome.terminalTraceId,
    });

    const supportedCategoryKeys = await readSupportedCategoryKeys(
      client,
      dependencies,
    );
    const categories = [];
    for (const expectedKey of supportedCategoryKeys) {
      boundary = traceId(await readTrace());
      await dependencies.activateVisibleSelector(
        client,
        categorySelector(expectedKey),
        { kind: "touch", timeoutMs: 30_000 },
      );
      const category = await waitForAudioLifecycle(
        readTrace,
        boundary,
        (entry) =>
          String(entry.transitionId).startsWith(
            `category:category-entry-${expectedKey}-`,
          ),
        dependencies,
        `category ${expectedKey} entry`,
      );
      const categoryKey = categoryKeyFromTransition(category.transitionId);
      if (categoryKey !== expectedKey) {
        throw new Error(
          `Catalog category ${expectedKey} emitted ${categoryKey}`,
        );
      }
      checkpoints.push({
        label: `category-${categoryKey}-entry`,
        traceId: category.terminalTraceId,
      });
      await dependencies.activateVisibleSelector(
        client,
        '[data-test="catalog-product"]',
        { kind: "touch", timeoutMs: 30_000 },
      );
      await dependencies.waitForRoute(client, /^#\/products\//, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      runtimeTrace = await readTrace();
      checkpoints.push({
        label: `category-${categoryKey}-detail`,
        traceId: traceId(runtimeTrace),
      });
      await dependencies.activateVisibleSelector(
        client,
        '[data-test="product-buy"]',
        { kind: "touch", timeoutMs: 30_000 },
      );
      await dependencies.waitForRoute(client, "#/checkout", {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      runtimeTrace = await readTrace();
      checkpoints.push({
        label: `category-${categoryKey}-checkout`,
        traceId: traceId(runtimeTrace),
      });
      categories.push({
        key: categoryKey,
        transitionId: category.transitionId,
        sourceUrl: `/audio/voice/product/${categoryKey}.mp3`,
        entryCheckpointLabel: `category-${categoryKey}-entry`,
        detailCheckpointLabel: `category-${categoryKey}-detail`,
        checkoutCheckpointLabel: `category-${categoryKey}-checkout`,
      });
      await dependencies.activateVisibleSelector(client, ".checkout-back", {
        kind: "touch",
        timeoutMs: 30_000,
      });
      await dependencies.waitForRoute(client, /^#\/products\//, {
        timeoutMs: 30_000,
        pollMs: 250,
      });
      await dependencies.activateVisibleSelector(
        client,
        ".detail-back-button",
        {
          kind: "touch",
          timeoutMs: 30_000,
        },
      );
      await dependencies.waitForRoute(client, "#/catalog", {
        timeoutMs: 30_000,
        pollMs: 250,
      });
    }

    const audioStop = await dependencies.controlPlaneRequest(
      guestInput,
      `/v1/audio-captures/${audioCaptureId}/stop`,
      {
        saleCorrelationId: `behavior-audio://${guestInput.runId}`,
        orderId: dependencies.randomUUID(),
        orderNo: `BEHAVIOR-AUDIO-${guestInput.runId}`,
        commandId: dependencies.randomUUID(),
        commandNo: `BEHAVIOR-AUDIO-COMMAND-${guestInput.runId}`,
      },
    );
    audioStopped = true;
    dependencies.writeJson(
      join(artifactRoot, "audio-capture-stop.json"),
      audioStop.stopReport,
    );
    for (const artifact of audioStop.evidencePayloads ?? []) {
      writeFileSync(
        join(artifactRoot, artifact.fileName),
        Buffer.from(artifact.bytesBase64, "base64"),
        { mode: 0o600 },
      );
    }
    const capture = captureSummary(audioStop.stopReport);
    const requiredCueIds = [
      initialWelcome.transitionId,
      rearmedWelcome.transitionId,
      ...categories.map((category) => category.transitionId),
    ];
    const acceptance = {
      schemaVersion: "behavior-audio-production-acceptance/v1",
      result: "passed",
      boundaries: {
        vision: "controlled_mock_protocol",
        cdp: "installed_canonical_machine_cdp",
        audio: "windows_default_output_capture",
      },
      diagnostics: [],
      audio: {
        source: "windows_default_output",
        capture,
        cueWindows: requiredCueIds.map((transitionId) => ({
          transitionId,
          kind: "passed",
        })),
      },
      runtimeTrace,
      checkpoints,
      scenario: {
        welcome: {
          initialTransitionId: initialWelcome.transitionId,
          departureTransitionId: departure.entry.transitionId,
          rearmedTransitionId: rearmedWelcome.transitionId,
        },
        supportedCategoryKeys,
        categories,
      },
    };
    runtimeTrace = await readTrace();
    acceptance.runtimeTrace = runtimeTrace;
    validateBehaviorAudioAcceptanceEvidence(acceptance);
    const screenshotPath = join(artifactRoot, "behavior-audio-final.png");
    const screenshot = await dependencies.captureScreenshotArtifact(
      client,
      screenshotPath,
    );
    dependencies.writeJson(
      join(artifactRoot, "runtime-trace.json"),
      runtimeTrace,
    );
    const logPath = join(artifactRoot, "behavior-audio-summary.log");
    dependencies.writeText(
      logPath,
      `${JSON.stringify({
        runId: guestInput.runId,
        welcomeTransitions: [
          initialWelcome.transitionId,
          rearmedWelcome.transitionId,
        ],
        categoryTransitions: categories.map((entry) => entry.transitionId),
        nativeAudio: capture,
      })}\n`,
    );
    report.ok = true;
    report.behaviorAudio = acceptance;
    report.artifacts = {
      directory: artifactRoot,
      audioStartReport: join(artifactRoot, "audio-capture-start.json"),
      audioStopReport: join(artifactRoot, "audio-capture-stop.json"),
      runtimeTrace: join(artifactRoot, "runtime-trace.json"),
      log: logPath,
      screenshot: { path: screenshotPath, ...screenshot },
    };
  } catch (error) {
    report.error =
      error instanceof Error
        ? {
            message: error.message,
            stack: String(error.stack ?? "").slice(0, 16_384),
          }
        : { message: String(error) };
    report.behaviorAudio = report.behaviorAudio ?? {
      result: "failed",
      runtimeTrace,
    };
  } finally {
    if (guestInput && audioCaptureId && !audioStopped) {
      await dependencies
        .controlPlaneRequest(
          guestInput,
          `/v1/audio-captures/${audioCaptureId}/cancel`,
        )
        .catch((error) => {
          report.cleanupError =
            error instanceof Error ? error.message : String(error);
        });
    }
    await client?.close().catch((error) => {
      report.cleanupError =
        error instanceof Error ? error.message : String(error);
    });
    if (vision?.started) {
      await shutdownControlledVisionMock(vision.child).catch((error) => {
        report.cleanupError =
          error instanceof Error ? error.message : String(error);
      });
    }
    dependencies.writeJson(options.outPath, report);
  }
  return report;
}

export function validateBehaviorAudioGuestReport(report) {
  if (
    report?.schemaVersion !== "vem-behavior-audio-guest-full/v1" ||
    report?.ok !== true
  ) {
    throw new Error("behavior audio guest runner did not pass");
  }
  if (
    report?.boundaries?.visionMock !== true ||
    report?.boundaries?.machineCdp !== true ||
    report?.boundaries?.windowsAudioCapture !== true
  ) {
    throw new Error("behavior audio guest boundaries are incomplete");
  }
  for (const name of ["audioStartReport", "audioStopReport", "runtimeTrace"]) {
    required(report?.artifacts?.[name], `behavior audio artifact ${name}`);
  }
  const summary = validateBehaviorAudioAcceptanceEvidence(report.behaviorAudio);
  return { schemaVersion: report.schemaVersion, ...summary };
}

async function main() {
  const report = await runBehaviorAudioGuestFull(
    parseBehaviorAudioGuestArgs(process.argv.slice(2)),
  );
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
