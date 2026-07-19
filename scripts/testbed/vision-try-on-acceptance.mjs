#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
const VISION_ENTRYPOINT_PATH = "C:\\VEM\\vision\\app\\vending-vision.exe";
const VISION_LAUNCHER_PATH = "C:\\VEM\\bringup\\start_vision.bat";
const VISION_RUNTIME_WORK_DIRECTORY = "C:\\ProgramData\\VEM\\vision\\runtime";
const VISION_SITE_CONFIGURATION_PATH =
  "C:\\ProgramData\\VEM\\vision\\site.json";
const VISION_INSTALLED_RECORD_PATH =
  "C:\\ProgramData\\VEM\\vision\\installed.json";
const VISION_FIXTURE_ROOT = "C:\\ProgramData\\VEM\\vision\\fixtures";
const VISION_TASK_PATH = "\\VEM\\";
const VISION_TASK_NAME = "StartVisionServer";
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

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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

function fileSha256(path) {
  return createHash("sha256")
    .update(readFileSync(localPath(path)))
    .digest("hex");
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
    writeFileSync(
      destination,
      bytes.subarray(Math.max(0, bytes.length - maxBytes)),
    );
    return {
      ref: destination,
      source: sourcePath,
      byteLength: Math.min(bytes.length, maxBytes),
      tail: bytes
        .subarray(Math.max(0, bytes.length - Math.min(maxBytes, 4 * 1024)))
        .toString("utf8"),
    };
  } catch {
    return { ref: null, source: sourcePath, byteLength: 0 };
  }
}

function compactRuntimeTrace(trace, maxEntries = 96) {
  return Array.isArray(trace) ? trace.slice(-maxEntries) : [];
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function daemonBaseUrl(handoff) {
  const healthzUrl = required(
    handoff.daemon?.ready?.healthzUrl,
    "daemon healthzUrl",
  );
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
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
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
  throw new Error(
    `${name} did not become true in ${timeoutMs} ms: ${JSON.stringify(last?.value ?? null)}`,
  );
}

function isVisionProtocolTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  );
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function optionalFrameSourceBinding(value, label) {
  if (value == null) {
    return null;
  }
  return normalizeFrameSourceBinding(value, label);
}

function positiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function sha256Hex(value, label) {
  const normalized = required(String(value ?? ""), label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase sha256 hex digest`);
  }
  return normalized;
}

function windowsPathEquals(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
  );
}

function windowsUserIdentifier(value, label) {
  const user = required(value, label);
  const slash = user.lastIndexOf("\\");
  return slash === -1 ? user : user.slice(slash + 1);
}

function normalizeFrameSourceBinding(
  binding,
  label = "Vision frame-source binding",
) {
  const facts = requiredObject(binding, label);
  return {
    adapter: required(facts.adapter, `${label} adapter`),
    configSha256: sha256Hex(facts.configSha256, `${label} configSha256`),
    top: {
      path: windowsAbsolute(facts.top?.path, `${label} top path`),
      sha256: sha256Hex(facts.top?.sha256, `${label} top sha256`),
    },
    front: {
      path: windowsAbsolute(facts.front?.path, `${label} front path`),
      sha256: sha256Hex(facts.front?.sha256, `${label} front sha256`),
    },
    expectedResults: {
      path: windowsAbsolute(
        facts.expectedResults?.path,
        `${label} expected-results path`,
      ),
      sha256: sha256Hex(
        facts.expectedResults?.sha256,
        `${label} expected-results sha256`,
      ),
    },
  };
}

function validateSourceFrameEvidence(
  value,
  label,
  { role, configSha256, fixtureSha256, sessionId = null } = {},
) {
  const evidence = requiredObject(value, label);
  if (required(evidence.adapter, `${label} adapter`) !== "recorded_video") {
    throw new Error(`${label} must use the recorded_video adapter`);
  }
  if (required(evidence.role, `${label} role`) !== role) {
    throw new Error(`${label} must bind the ${role} source role`);
  }
  const normalized = {
    adapter: evidence.adapter,
    role: evidence.role,
    configSha256: sha256Hex(evidence.configSha256, `${label} configSha256`),
    fixtureSha256: sha256Hex(evidence.fixtureSha256, `${label} fixtureSha256`),
    frameIndex: nonNegativeInteger(evidence.frameIndex, `${label} frameIndex`),
    decodedFrameCount: positiveNumber(
      evidence.decodedFrameCount,
      `${label} decodedFrameCount`,
    ),
    eventId: optionalString(evidence.eventId),
    sessionId: optionalString(evidence.sessionId),
    synthetic: evidence.synthetic === true,
    relabeled: evidence.relabeled === true,
  };
  if (normalized.synthetic || normalized.relabeled) {
    throw new Error(`${label} cannot be synthetic or relabeled`);
  }
  if (normalized.frameIndex >= normalized.decodedFrameCount) {
    throw new Error(
      `${label} frameIndex must be smaller than decodedFrameCount`,
    );
  }
  if (normalized.configSha256 !== configSha256) {
    throw new Error(
      `${label} configSha256 drifted from the installed site configuration`,
    );
  }
  if (normalized.fixtureSha256 !== fixtureSha256) {
    throw new Error(
      `${label} fixtureSha256 drifted from the committed fixture`,
    );
  }
  if (sessionId && normalized.sessionId !== sessionId) {
    throw new Error(`${label} sessionId drifted from the try-on session`);
  }
  return normalized;
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: String(error.stack ?? "").slice(0, 16 * 1024),
    };
  }
  return { name: "Error", message: String(error) };
}

function normalizeUrlPath(value, label) {
  const raw = required(value, label);
  try {
    const normalized = new URL(raw, "http://127.0.0.1");
    return `${normalized.pathname}${normalized.search}`;
  } catch (error) {
    throw new Error(
      `${label} is not a valid URL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function catalogKeyForProductId(productId, label = "seeded try-on productId") {
  return `product:${required(productId, label)}`;
}

export function normalizeSeededVisionAcceptance(raw) {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seededTryOnVariants = Array.isArray(input.seededTryOnVariants)
    ? input.seededTryOnVariants.map((entry, index) => {
        const facts = requiredObject(
          entry,
          `visionAcceptance.seededTryOnVariants[${index}]`,
        );
        return {
          sourceRow:
            Number.isInteger(facts.sourceRow) && facts.sourceRow > 0
              ? facts.sourceRow
              : null,
          productId: optionalString(facts.productId),
          variantId: required(
            optionalString(facts.variantId),
            `visionAcceptance.seededTryOnVariants[${index}].variantId`,
          ),
          sku: optionalString(facts.sku),
          size: optionalString(facts.size),
          silhouetteAssetId: optionalString(facts.silhouetteAssetId),
          silhouettePublicUrl: optionalString(facts.silhouettePublicUrl),
        };
      })
    : [];
  return {
    tryOnCategoryKey: optionalString(input.tryOnCategoryKey),
    selectedCatalogKey: optionalString(input.selectedCatalogKey),
    selectedVariantId: optionalString(input.selectedVariantId),
    tryOnSilhouetteAssetId: optionalString(
      input.selectedSilhouetteAssetId ?? input.tryOnSilhouetteAssetId,
    ),
    tryOnSilhouettePublicUrl: optionalString(
      input.selectedSilhouettePublicUrl ?? input.tryOnSilhouettePublicUrl,
    ),
    seededTryOnVariants,
  };
}

function resolveSelectedSeededEntry(
  runtimeExpectation,
  selectedVariantId,
  label = "selected variantId",
) {
  const runtime = normalizeSeededVisionAcceptance(runtimeExpectation);
  const variantId = required(selectedVariantId, label);
  const matches = runtime.seededTryOnVariants.filter(
    (entry) => entry.variantId === variantId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `${label} must uniquely match exactly one seeded try-on entry`,
    );
  }
  const entry = matches[0];
  return {
    ...entry,
    catalogKey: catalogKeyForProductId(
      entry.productId,
      `${label} seeded productId`,
    ),
  };
}

export function combineCleanupFailure(
  primaryError,
  cleanupError,
  label = "cleanup",
) {
  if (!primaryError) return cleanupError;
  if (!cleanupError) return primaryError;
  return new AggregateError(
    [primaryError, cleanupError],
    `${primaryError.message} (also failed during ${label}: ${cleanupError.message})`,
    { cause: primaryError },
  );
}

function visionFixtureExpectedResultsPath(commit) {
  return `${VISION_FIXTURE_ROOT}\\${commit}\\recorded-video\\expected-results.json`;
}

function normalizedExpectedProtocolEvent(
  value,
  label,
  expectedType,
  expectedSource,
) {
  const event = requiredObject(value, `${label} expected result`);
  const type = required(
    typeof event.type === "string" ? event.type : expectedType,
    `${label} type`,
  );
  const source = required(
    typeof event.source === "string" ? event.source : expectedSource,
    `${label} source`,
  );
  const detectedAt = optionalString(
    typeof event.detectedAt === "string"
      ? event.detectedAt
      : event.payload?.detectedAt,
  );
  if (type !== expectedType) {
    throw new Error(`${label} type must be ${expectedType}`);
  }
  if (detectedAt && !isVisionProtocolTimestamp(detectedAt)) {
    throw new Error(`${label} detectedAt must be an ISO UTC timestamp`);
  }
  return { type, source };
}

export function normalizeVisionExpectedResults(raw) {
  const fixture = requiredObject(raw, "Vision expected-results fixture");
  const publishedExpected =
    fixture.expected && typeof fixture.expected === "object"
      ? fixture.expected
      : null;
  const publishedEvents = Array.isArray(publishedExpected?.top?.protocolEvents)
    ? publishedExpected.top.protocolEvents
    : [];
  const protocol = requiredObject(
    fixture.protocol ??
      fixture.machineProtocol ??
      fixture.expectedProtocol ??
      (publishedExpected
        ? {
            presence: {
              type: publishedEvents[0] ?? "vision.presence_status",
              source: "top",
            },
            profile: { type: "vision.profile_result", source: "front" },
            departure: {
              type: publishedEvents[1] ?? "vision.person_departed",
              source: "top",
            },
          }
        : null),
    "expected protocol block",
  );
  const recommendation = requiredObject(
    fixture.recommendation ??
      fixture.catalogRecommendation ??
      (publishedExpected ? {} : null),
    "expected recommendation block",
  );
  const tryOn = requiredObject(
    fixture.tryOn ??
      fixture.try_on ??
      fixture.tryOnPreview ??
      publishedExpected?.front?.tryOn,
    "expected try-on block",
  );
  const capabilities = Array.isArray(protocol.ready?.capabilities)
    ? protocol.ready.capabilities.map((value) =>
        required(String(value), "ready capability"),
      )
    : ["profile_push", "presence_status", "person_departed", "try_on_session"];
  const orderedCatalogKeys = Array.isArray(recommendation.orderedCatalogKeys)
    ? recommendation.orderedCatalogKeys.map((value) =>
        required(value, "expected ordered catalog key"),
      )
    : null;
  return {
    schemaVersion:
      typeof fixture.schemaVersion === "string" ? fixture.schemaVersion : null,
    protocol: {
      ready: {
        protocol: required(
          protocol.ready?.protocol ?? "vem.vision.v1",
          "expected ready protocol",
        ),
        capabilities,
      },
      presence: normalizedExpectedProtocolEvent(
        protocol.presence,
        "presence",
        "vision.presence_status",
        "top",
      ),
      profile: normalizedExpectedProtocolEvent(
        protocol.profile,
        "profile",
        "vision.profile_result",
        "front",
      ),
      departure: normalizedExpectedProtocolEvent(
        protocol.departure,
        "departure",
        "vision.person_departed",
        "top",
      ),
    },
    recommendation: {
      orderedCatalogKeys,
      selectedCatalogKey: optionalString(
        recommendation.selectedCatalogKey ?? recommendation.topCatalogKey,
      ),
      selectedVariantId: optionalString(recommendation.selectedVariantId),
      minimumScore: positiveNumber(
        recommendation.minimumScore ?? recommendation.score ?? 0.01,
        "expected recommendation minimumScore",
      ),
    },
    tryOn: {
      silhouettePathFragment: required(
        tryOn.silhouettePathFragment ?? "/api/media-assets/",
        "expected try-on silhouette path fragment",
      ),
      previewPathPrefix: required(
        tryOn.previewPathPrefix ?? "http://127.0.0.1:7892/try-on/",
        "expected try-on preview path prefix",
      ),
      selectedCatalogKey: optionalString(
        tryOn.selectedCatalogKey ?? recommendation.selectedCatalogKey,
      ),
      selectedVariantId: optionalString(
        tryOn.selectedVariantId ?? recommendation.selectedVariantId,
      ),
    },
  };
}

export function compareObservedVisionProtocolToExpected({
  expectedResults,
  protocolEvidence,
  installedBinding = null,
  freshnessWindowMs = 5 * 60 * 1000,
}) {
  const expected = normalizeVisionExpectedResults(expectedResults);
  const summary = validateVisionProtocolEvidence(
    protocolEvidence,
    installedBinding,
  );
  if (summary.healthStatus !== "ok") {
    throw new Error(
      "Vision happy-path protocol evidence must report health status ok",
    );
  }
  if (
    protocolEvidence.ready?.protocol !== expected.protocol.ready.protocol ||
    !expected.protocol.ready.capabilities.every((capability) =>
      summary.capabilities.includes(capability),
    )
  ) {
    throw new Error(
      "Vision ready handshake does not match expected-results capabilities",
    );
  }
  const observed = [
    {
      label: "presence",
      type: protocolEvidence.presence.type,
      detectedAt: protocolEvidence.presence.payload?.detectedAt,
    },
    {
      label: "profile",
      type: protocolEvidence.profile.type,
      detectedAt: protocolEvidence.profile.payload?.detectedAt,
    },
    {
      label: "departure",
      type: protocolEvidence.departure.type,
      detectedAt: protocolEvidence.departure.payload?.detectedAt,
    },
  ];
  const expectedSequence = [
    expected.protocol.presence,
    expected.protocol.profile,
    expected.protocol.departure,
  ];
  for (let index = 0; index < observed.length; index += 1) {
    const actual = observed[index];
    const expectedEvent = expectedSequence[index];
    if (actual.type !== expectedEvent.type) {
      throw new Error(
        `${actual.label} does not match expected-results event type`,
      );
    }
  }
  const observationStartedAt = required(
    protocolEvidence.observation?.startedAt,
    "protocol observation startedAt",
  );
  const observationCompletedAt = required(
    protocolEvidence.observation?.completedAt,
    "protocol observation completedAt",
  );
  if (
    !isVisionProtocolTimestamp(observationStartedAt) ||
    !isVisionProtocolTimestamp(observationCompletedAt)
  ) {
    throw new Error("protocol observation timestamps are invalid");
  }
  const chronology = [
    protocolEvidence.ready.timestamp,
    protocolEvidence.presence.payload.detectedAt,
    protocolEvidence.profile.payload.detectedAt,
    protocolEvidence.departure.payload.detectedAt,
  ];
  const observationWindow = [
    Date.parse(observationStartedAt),
    Date.parse(observationCompletedAt),
  ];
  for (const timestamp of chronology.slice(1)) {
    const parsed = Date.parse(timestamp);
    if (
      parsed < observationWindow[0] - freshnessWindowMs ||
      parsed > observationWindow[1] + 60_000
    ) {
      throw new Error(
        "Vision protocol detectedAt does not look fresh for this acceptance run",
      );
    }
  }
  for (let index = 1; index < chronology.length; index += 1) {
    if (Date.parse(chronology[index - 1]) >= Date.parse(chronology[index])) {
      throw new Error("Vision protocol chronology is not strictly increasing");
    }
  }
  return {
    ...summary,
    expectedSchemaVersion: expected.schemaVersion,
    expectedSequence,
    observationStartedAt,
    observationCompletedAt,
  };
}

export function validateRecommendationProjection({
  beforeProducts,
  afterProducts,
  pageText,
  expectedResults,
  runtimeExpectation = null,
}) {
  const expected = normalizeVisionExpectedResults(expectedResults);
  const runtime = normalizeSeededVisionAcceptance(runtimeExpectation);
  const beforeCatalogKeys = beforeProducts.map((product) => product.catalogKey);
  const afterCatalogKeys = afterProducts.map((product) => product.catalogKey);
  if (Array.isArray(expected.recommendation.orderedCatalogKeys)) {
    assert.equal(
      afterCatalogKeys.length,
      expected.recommendation.orderedCatalogKeys.length,
      "catalog recommendation size drifted from expected-results",
    );
  }
  const selected = afterProducts[0];
  if (!selected) {
    throw new Error("catalog recommendation did not expose any product");
  }
  const seededSelection =
    runtime.seededTryOnVariants.length > 0
      ? resolveSelectedSeededEntry(
          runtime,
          selected.preferredVariantId,
          "recommended variantId",
        )
      : null;
  if (
    runtime.selectedCatalogKey &&
    selected.catalogKey !== runtime.selectedCatalogKey
  ) {
    throw new Error(
      "top recommended catalog item does not match seeded runtime expectation",
    );
  }
  if (
    runtime.selectedVariantId &&
    selected.preferredVariantId !== runtime.selectedVariantId
  ) {
    throw new Error(
      "recommended variant does not match seeded runtime expectation",
    );
  }
  if (seededSelection && selected.catalogKey !== seededSelection.catalogKey) {
    throw new Error(
      "recommended catalogKey does not match the seeded productId for the selected variantId",
    );
  }
  if (selected.recommendationScore < expected.recommendation.minimumScore) {
    throw new Error("recommended score did not exceed the expected threshold");
  }
  if (beforeCatalogKeys.join("\n") === afterCatalogKeys.join("\n")) {
    throw new Error("catalog recommendation order did not actually change");
  }
  const leakage = JSON.stringify({ pageText, afterProducts });
  for (const disallowed of [
    "identity",
    "faceEmbedding",
    "rawImageBase64",
    "ageRange",
    "gender",
  ]) {
    if (leakage.includes(disallowed)) {
      throw new Error(
        `catalog recommendation leaked identity field ${disallowed}`,
      );
    }
  }
  return {
    beforeCatalogKeys,
    afterCatalogKeys,
    selectedCatalogKey: selected.catalogKey,
    selectedVariantId: selected.preferredVariantId,
    selectedScore: selected.recommendationScore,
    seededSelection,
  };
}

export function validateTryOnPresentation({
  selectedProduct,
  tryOnState,
  mjpegEvidence,
  expectedResults,
  runtimeExpectation = null,
  silhouetteEvidence = null,
  installedBinding = null,
}) {
  const expected = normalizeVisionExpectedResults(expectedResults);
  const runtime = normalizeSeededVisionAcceptance(runtimeExpectation);
  const seededSelection =
    runtime.seededTryOnVariants.length > 0
      ? resolveSelectedSeededEntry(
          runtime,
          selectedProduct.variantId,
          "selected product variantId",
        )
      : null;
  if (
    runtime.selectedCatalogKey &&
    selectedProduct.catalogKey !== runtime.selectedCatalogKey
  ) {
    throw new Error(
      "selected product catalogKey does not match seeded try-on binding",
    );
  }
  if (
    runtime.selectedVariantId &&
    selectedProduct.variantId !== runtime.selectedVariantId
  ) {
    throw new Error(
      "selected product variantId does not match seeded try-on binding",
    );
  }
  if (
    seededSelection &&
    selectedProduct.catalogKey !== seededSelection.catalogKey
  ) {
    throw new Error(
      "selected product catalogKey does not match the seeded productId for the selected variantId",
    );
  }
  const expectedRoute = `#/products/${selectedProduct.catalogKey}/try-on?variantId=${selectedProduct.variantId}`;
  if (tryOnState.route !== expectedRoute) {
    throw new Error("try-on route is not bound to the selected catalog item");
  }
  if (
    typeof tryOnState.previewUrl !== "string" ||
    !tryOnState.previewUrl.startsWith(expected.tryOn.previewPathPrefix)
  ) {
    throw new Error(
      "try-on preview URL is not bound to the expected loopback session",
    );
  }
  if (
    typeof tryOnState.silhouetteUrl !== "string" ||
    !tryOnState.silhouetteUrl.includes(expected.tryOn.silhouettePathFragment)
  ) {
    throw new Error(
      "try-on silhouette URL is not bound to the selected variant",
    );
  }
  const expectedSilhouettePath = seededSelection?.silhouettePublicUrl
    ? normalizeUrlPath(
        seededSelection.silhouettePublicUrl,
        "seeded try-on silhouette publicUrl",
      )
    : seededSelection?.silhouetteAssetId
      ? `/api/media-assets/${seededSelection.silhouetteAssetId}/content`
      : runtime.tryOnSilhouettePublicUrl
        ? normalizeUrlPath(
            runtime.tryOnSilhouettePublicUrl,
            "seeded try-on silhouette publicUrl",
          )
        : runtime.tryOnSilhouetteAssetId
          ? `/api/media-assets/${runtime.tryOnSilhouetteAssetId}/content`
          : null;
  if (
    expectedSilhouettePath &&
    normalizeUrlPath(tryOnState.silhouetteUrl, "try-on silhouetteUrl") !==
      expectedSilhouettePath
  ) {
    throw new Error(
      "try-on silhouette URL is not bound to the seeded media asset",
    );
  }
  if (
    !silhouetteEvidence ||
    silhouetteEvidence.ok !== true ||
    silhouetteEvidence.httpStatus !== 200 ||
    !/^image\//i.test(String(silhouetteEvidence.contentType ?? ""))
  ) {
    throw new Error(
      "try-on silhouette did not return a successful image response",
    );
  }
  if (
    expectedSilhouettePath &&
    normalizeUrlPath(
      silhouetteEvidence.finalUrl,
      "try-on silhouette finalUrl",
    ) !== expectedSilhouettePath
  ) {
    throw new Error(
      "try-on silhouette redirect finalUrl drifted from the seeded media asset",
    );
  }
  if (
    tryOnState.silhouetteLoaded !== true ||
    tryOnState.silhouetteNaturalWidth < 1 ||
    tryOnState.silhouetteNaturalHeight < 1
  ) {
    throw new Error(
      "try-on silhouette image did not load with natural dimensions",
    );
  }
  if (
    typeof mjpegEvidence.contentType !== "string" ||
    !/^multipart\/x-mixed-replace|^image\/jpeg/i.test(mjpegEvidence.contentType)
  ) {
    throw new Error("try-on preview did not return MJPEG/JPEG content");
  }
  if (mjpegEvidence.frameByteLength < 64) {
    throw new Error("try-on preview did not deliver a decodable frame");
  }
  if (mjpegEvidence.width < 1 || mjpegEvidence.height < 1) {
    throw new Error("try-on preview frame did not decode to pixels");
  }
  if (mjpegEvidence.nonBlackPixelCount < 1) {
    throw new Error("try-on preview frame decoded but remained fully black");
  }
  const sourceFrame =
    installedBinding?.frameSourceBinding &&
    mjpegEvidence.sourceFrame &&
    validateSourceFrameEvidence(
      mjpegEvidence.sourceFrame,
      "try-on source frame",
      {
        role: "front",
        configSha256: installedBinding.frameSourceBinding.configSha256,
        fixtureSha256: installedBinding.frameSourceBinding.front.sha256,
        sessionId: mjpegEvidence.sessionId,
      },
    );
  return {
    sessionId: mjpegEvidence.sessionId,
    contentType: mjpegEvidence.contentType,
    width: mjpegEvidence.width,
    height: mjpegEvidence.height,
    nonBlackPixelCount: mjpegEvidence.nonBlackPixelCount,
    sourceFrame,
    silhouetteHttpStatus: silhouetteEvidence.httpStatus,
    silhouetteNaturalWidth: tryOnState.silhouetteNaturalWidth,
    silhouetteNaturalHeight: tryOnState.silhouetteNaturalHeight,
  };
}

export function validateVisionInstalledBinding(binding) {
  const facts = requiredObject(binding, "Vision installed binding");
  const installedRecord = requiredObject(
    facts.installedRecord,
    "Vision installed record",
  );
  if (installedRecord.schemaVersion !== "vem-vision-installed/v1") {
    throw new Error("Vision installed record schema is invalid");
  }
  if (!/^[a-f0-9]{40}$/.test(String(installedRecord.commit ?? ""))) {
    throw new Error("Vision installed record commit is invalid");
  }
  if (
    !windowsPathEquals(installedRecord.appDirectory, "C:\\VEM\\vision\\app")
  ) {
    throw new Error("Vision installed record appDirectory drifted");
  }
  if (installedRecord.runtime !== "vending-vision.exe") {
    throw new Error("Vision installed record runtime drifted");
  }
  if (
    !windowsPathEquals(
      installedRecord.runtimeWorkDirectory,
      VISION_RUNTIME_WORK_DIRECTORY,
    )
  ) {
    throw new Error("Vision installed record runtime work directory drifted");
  }
  if (
    !windowsPathEquals(installedRecord.executablePath, VISION_ENTRYPOINT_PATH)
  ) {
    throw new Error("Vision installed record executablePath drifted");
  }
  const siteConfiguration = requiredObject(
    installedRecord.siteConfiguration,
    "Vision installed siteConfiguration",
  );
  if (
    !windowsPathEquals(siteConfiguration.path, VISION_SITE_CONFIGURATION_PATH)
  ) {
    throw new Error("Vision installed record site configuration path drifted");
  }
  const siteConfigurationSha256 = sha256Hex(
    facts.siteConfigurationSha256,
    "Vision site configuration digest",
  );
  if (
    sha256Hex(
      siteConfiguration.sha256,
      "Vision installed record site configuration sha256",
    ) !== siteConfigurationSha256
  ) {
    throw new Error(
      "Vision installed record site configuration digest drifted",
    );
  }
  const downloadManifest = requiredObject(
    installedRecord.downloadManifest,
    "Vision installed download manifest",
  );
  if (
    !windowsAbsolute(downloadManifest.path, "Vision download manifest path")
  ) {
    throw new Error("Vision download manifest path is invalid");
  }
  const downloadManifestSha256 = sha256Hex(
    facts.downloadManifestSha256,
    "Vision download manifest digest",
  );
  if (
    sha256Hex(
      downloadManifest.sha256,
      "Vision installed record download manifest sha256",
    ) !== downloadManifestSha256
  ) {
    throw new Error("Vision download manifest digest drifted");
  }
  sha256Hex(
    downloadManifest.runtimeArchive?.sha256,
    "Vision runtime archive sha256",
  );
  sha256Hex(
    downloadManifest.fixtureArchive?.sha256,
    "Vision fixture archive sha256",
  );
  const frameSourceBinding = normalizeFrameSourceBinding(
    {
      adapter: "recorded_video",
      configSha256: siteConfigurationSha256,
      top: installedRecord.fixtureSet?.top,
      front: installedRecord.fixtureSet?.front,
      expectedResults: installedRecord.fixtureSet?.expectedResults,
    },
    "Vision installed fixture binding",
  );
  const fixtureManifestPath = windowsAbsolute(
    installedRecord.fixtureSet?.manifestPath,
    "Vision fixture manifest path",
  );
  if (
    sha256Hex(
      installedRecord.fixtureSet?.manifestSha256,
      "Vision fixture manifest sha256",
    ) !==
    sha256Hex(facts.fixtureManifestSha256, "Vision fixture manifest digest")
  ) {
    throw new Error("Vision fixture manifest digest drifted");
  }
  const siteConfigurationObject = requiredObject(
    facts.siteConfiguration,
    "Vision site configuration",
  );
  if (siteConfigurationObject.cameras?.top?.source !== "recorded_video") {
    throw new Error(
      "Vision site configuration top camera must use recorded_video",
    );
  }
  if (siteConfigurationObject.cameras?.front?.source !== "recorded_video") {
    throw new Error(
      "Vision site configuration front camera must use recorded_video",
    );
  }
  if (siteConfigurationObject.cameras?.top?.role !== "presence") {
    throw new Error("Vision site configuration top role drifted");
  }
  if (siteConfigurationObject.cameras?.front?.role !== "profile_tryon") {
    throw new Error("Vision site configuration front role drifted");
  }
  if (
    !windowsPathEquals(
      siteConfigurationObject.cameras?.top?.video_path,
      frameSourceBinding.top.path,
    ) ||
    !windowsPathEquals(
      siteConfigurationObject.cameras?.front?.video_path,
      frameSourceBinding.front.path,
    )
  ) {
    throw new Error(
      "Vision site configuration is not bound to the committed top/front fixtures",
    );
  }
  if (!windowsPathEquals(facts.executablePath, VISION_ENTRYPOINT_PATH)) {
    throw new Error(
      "Vision listener is not bound to the fixed installed executable",
    );
  }
  if (
    sha256Hex(facts.executableSha256, "Vision executable hash") !==
    installedRecord.executableSha256
  ) {
    throw new Error("Vision executable hash drifted from the installed record");
  }
  if (
    !Number.isInteger(facts.processId) ||
    facts.processId < 1 ||
    facts.listenerProcessId !== facts.processId ||
    facts.listenerOwnerCount !== 1
  ) {
    throw new Error(
      "Vision loopback listener must resolve to exactly one installed process",
    );
  }
  if (
    required(facts.listenerBindingSource, "Vision listener binding source") !==
    "Get-NetTCPConnection"
  ) {
    throw new Error("Vision listener binding source drifted");
  }
  const commandLine = required(facts.commandLine, "Vision process commandLine");
  const normalizedCommandLine = commandLine.replaceAll('"', "").toLowerCase();
  if (
    !normalizedCommandLine.includes(VISION_ENTRYPOINT_PATH.toLowerCase()) ||
    !normalizedCommandLine.includes("--config") ||
    !normalizedCommandLine.includes(
      VISION_SITE_CONFIGURATION_PATH.toLowerCase(),
    )
  ) {
    throw new Error(
      "Vision process command line is not bound to the fixed --config site path",
    );
  }
  if (!windowsPathEquals(facts.taskCommand, "C:\\Windows\\System32\\cmd.exe")) {
    throw new Error("Vision scheduled task command drifted");
  }
  if (
    required(facts.taskArguments, "Vision scheduled task arguments").includes(
      VISION_LAUNCHER_PATH,
    ) === false
  ) {
    throw new Error("Vision scheduled task arguments drifted");
  }
  if (!windowsPathEquals(facts.taskWorkingDirectory, "C:\\VEM\\vision\\app")) {
    throw new Error("Vision scheduled task workingDirectory drifted");
  }
  const taskUser = windowsUserIdentifier(
    facts.taskUser,
    "Vision scheduled task user",
  );
  if (taskUser.toLowerCase() !== "VEMKiosk".toLowerCase()) {
    throw new Error("Vision scheduled task user drifted");
  }
  if (
    windowsUserIdentifier(
      facts.processOwner,
      "Vision process owner",
    ).toLowerCase() !== taskUser.toLowerCase()
  ) {
    throw new Error(
      "Vision process owner drifted from the scheduled task user",
    );
  }
  if (
    !windowsPathEquals(
      fixtureManifestPath,
      `${VISION_FIXTURE_ROOT}\\${installedRecord.commit}\\recorded-video\\fixture-manifest.json`,
    )
  ) {
    throw new Error("Vision fixture manifest path drifted");
  }
  if (
    sha256Hex(facts.fixtureTopSha256, "Vision top fixture sha256") !==
      frameSourceBinding.top.sha256 ||
    sha256Hex(facts.fixtureFrontSha256, "Vision front fixture sha256") !==
      frameSourceBinding.front.sha256 ||
    sha256Hex(
      facts.fixtureExpectedResultsSha256,
      "Vision expected-results sha256",
    ) !== frameSourceBinding.expectedResults.sha256
  ) {
    throw new Error(
      "Vision fixture digests drifted from the committed fixture manifest",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(facts.executableSha256 ?? ""))) {
    throw new Error("Vision executable hash is invalid");
  }
  return {
    installedCommit: installedRecord.commit,
    executablePath: facts.executablePath,
    executableSha256: facts.executableSha256,
    processId: facts.processId,
    processOwner: facts.processOwner,
    commandLine: facts.commandLine,
    taskUser: facts.taskUser,
    listenerProcessId: facts.listenerProcessId,
    listenerOwnerCount: facts.listenerOwnerCount,
    listenerBindingSource: facts.listenerBindingSource,
    siteConfigurationSha256,
    frameSourceBinding,
  };
}

export function parseVisionTryOnAcceptanceArgs(args) {
  const mode = required(option(args, "mode"), "--mode");
  if (!MODES.has(mode)) {
    throw new Error("--mode must be full");
  }
  return {
    mode,
    guestInputPath: windowsAbsolute(
      option(args, "guest-input"),
      "--guest-input",
    ),
    handoffPath: windowsAbsolute(option(args, "handoff"), "--handoff"),
    outPath: windowsAbsolute(option(args, "out"), "--out"),
    fixtureKey: required(option(args, "fixture-key"), "--fixture-key"),
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
    allowed_origins: ["http://tauri.localhost", `http://${host}:${port}`],
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

export function validateVisionProtocolEvidence(
  evidence,
  installedBinding = null,
) {
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
  const healthFrameSource = optionalFrameSourceBinding(
    health.frameSource,
    "Vision health frame-source binding",
  );
  const readyFrameSource = optionalFrameSourceBinding(
    ready.payload?.frameSource,
    "Vision ready frame-source binding",
  );
  const frameSourceBinding =
    healthFrameSource ??
    readyFrameSource ??
    installedBinding?.frameSourceBinding ??
    null;
  if (!frameSourceBinding) {
    throw new Error(
      "Vision frame-source binding is unavailable for protocol evidence",
    );
  }
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
  if (
    healthFrameSource &&
    readyFrameSource &&
    JSON.stringify(healthFrameSource) !== JSON.stringify(readyFrameSource)
  ) {
    throw new Error("vision health and ready frame-source bindings drifted");
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
  if (installedBinding?.frameSourceBinding) {
    if (
      JSON.stringify(frameSourceBinding) !==
      JSON.stringify(installedBinding.frameSourceBinding)
    ) {
      throw new Error(
        "vision frame-source binding drifted from the installed recorded-video fixture",
      );
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
    profile.payload?.quality?.profileUsable !== true ||
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
    frameSourceBinding,
    presenceDetectedAt: presence.payload.detectedAt,
    profileDetectedAt: profile.payload.detectedAt,
    departureDetectedAt: departure.payload.detectedAt,
    profileUsable: true,
  };
}

export async function collectVisionProtocolEvidence({
  machineCode,
  timeoutMs = 120_000,
  openSocket = openVisionSocket,
  readMessage = nextVisionMessage,
  fetchHealth = fetchJson,
  now = () => new Date().toISOString(),
  closeSocket,
}) {
  const observationStartedAt = now();
  const health = await fetchHealth("http://127.0.0.1:7892/health");
  const socket = await openSocket("ws://127.0.0.1:7892/ws");
  const observedMessages = [];
  try {
    socket.send(JSON.stringify(createVisionHello(machineCode)));
    const ready = await readMessage(socket, 10_000);
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
      const message = await readMessage(
        socket,
        Math.max(1_000, deadline - Date.now()),
      );
      observedMessages.push({
        type: message?.type ?? null,
        messageId: message?.messageId ?? null,
        timestamp: message?.timestamp ?? null,
      });
      if (
        message?.type === "vision.presence_status" &&
        state.presence === null &&
        message?.payload?.personPresent === true
      ) {
        state.presence = message;
      } else if (
        message?.type === "vision.profile_result" &&
        state.profile === null
      ) {
        state.profile = message;
      } else if (
        message?.type === "vision.person_departed" &&
        state.departure === null
      ) {
        state.departure = message;
      }
      if (state.presence && state.profile && state.departure) {
        return {
          ...state,
          observation: {
            startedAt: observationStartedAt,
            completedAt: now(),
          },
        };
      }
    }
    throw new Error(
      `vision protocol did not produce presence/profile/departure within ${timeoutMs} ms`,
    );
  } finally {
    if (typeof closeSocket === "function") {
      await closeSocket(socket);
    } else if (typeof socket?.close === "function") {
      socket.close();
    }
  }
}

async function readRuntimeTrace(client) {
  return evaluateExpression(
    client,
    "window.__VEM_MACHINE_RUNTIME_TRACE__ || []",
  );
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

async function readCatalogProducts(client) {
  return evaluateExpression(
    client,
    `(() => {
      const page = document.querySelector("[data-test='catalog-page']");
      const products = Array.from(
        document.querySelectorAll("[data-test='catalog-product']"),
      ).map((element) => ({
        catalogKey: element.getAttribute("data-catalog-key") ?? "",
        variantId: element.getAttribute("data-variant-id") ?? "",
        preferredVariantId:
          element.getAttribute("data-preferred-variant-id") ?? "",
        recommendationScore: Number(
          element.getAttribute("data-recommendation-score") ?? "0",
        ),
        visibleText: element.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      }));
      return {
        route: location.hash,
        recommendationActive:
          page?.getAttribute("data-vision-recommendation-active") ?? "false",
        pageText: page?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        products,
      };
    })()`,
  );
}

async function waitForCatalogProducts(client, timeoutMs = 30_000) {
  return waitForCondition(
    "catalog products",
    async () => {
      const state = await readCatalogProducts(client);
      return {
        ok:
          state?.route === "#/catalog" &&
          Array.isArray(state?.products) &&
          state.products.length > 0,
        value: state,
      };
    },
    timeoutMs,
    250,
  );
}

async function waitForCatalogRecommendationProjection(
  client,
  baselineOrder,
  timeoutMs = 90_000,
) {
  return waitForCondition(
    "catalog recommendation projection",
    async () => {
      const state = await readCatalogProducts(client);
      const currentOrder = Array.isArray(state?.products)
        ? state.products.map((product) => product.catalogKey)
        : [];
      return {
        ok:
          state?.route === "#/catalog" &&
          state?.recommendationActive === "true" &&
          currentOrder.length > 0 &&
          currentOrder.join("\n") !== baselineOrder.join("\n") &&
          state.products.some(
            (product) =>
              Number.isFinite(product.recommendationScore) &&
              product.recommendationScore > 0,
          ),
        value: state,
      };
    },
    timeoutMs,
    500,
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
            silhouetteLoaded: silhouette?.complete === true,
            silhouetteNaturalWidth: Number(silhouette?.naturalWidth ?? 0),
            silhouetteNaturalHeight: Number(silhouette?.naturalHeight ?? 0),
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
          state.silhouetteLoaded === true &&
          state.silhouetteNaturalWidth > 0 &&
          state.silhouetteNaturalHeight > 0 &&
          !state.errorText,
        value: state,
      };
    },
    timeoutMs,
    500,
  );
}

async function readImageHttpEvidence(url) {
  try {
    const response = await fetch(url);
    const body = await response.arrayBuffer();
    return {
      ok: response.ok,
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      byteLength: body.byteLength,
      finalUrl: response.url,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      contentType: null,
      byteLength: 0,
      finalUrl: null,
      error: String(error),
    };
  }
}

async function collectVisionInstalledBinding() {
  const installedRecord = readJson(
    VISION_INSTALLED_RECORD_PATH,
    "installed Vision record",
  );
  const siteConfiguration = readJson(
    VISION_SITE_CONFIGURATION_PATH,
    "installed Vision site configuration",
  );
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskName '${VISION_TASK_NAME}' -TaskPath '${VISION_TASK_PATH}' -ErrorAction Stop`,
    "$action = @($task.Actions | Select-Object -First 1)",
    "$listener = @(Get-NetTCPConnection -State Listen -LocalPort 7892 -ErrorAction Stop | Where-Object { [string]$_.LocalAddress -ceq '127.0.0.1' })",
    'if ($listener.Count -ne 1) { throw "Vision must have exactly one 127.0.0.1:7892 listener" }',
    "$visionPid = [int]$listener[0].OwningProcess",
    "$process = Get-Process -Id $visionPid -ErrorAction Stop",
    '$processWmi = Get-CimInstance Win32_Process -Filter "ProcessId = $visionPid" -ErrorAction Stop',
    "$owner = Invoke-CimMethod -InputObject $processWmi -MethodName GetOwner -ErrorAction Stop",
    "$path = [string]$process.Path",
    "$commandLine = [string]$processWmi.CommandLine",
    "[Console]::Out.Write((@{ processId = $visionPid; listenerProcessId = $visionPid; listenerOwnerCount = $listener.Count; listenerBindingSource = 'Get-NetTCPConnection'; executablePath = $path; commandLine = $commandLine; processOwner = [string]$owner.User; taskUser = [string]$task.Principal.UserId; taskCommand = if ($action.Count -gt 0) { [string]$action[0].Execute } else { $null }; taskArguments = if ($action.Count -gt 0) { [string]$action[0].Arguments } else { $null }; taskWorkingDirectory = if ($action.Count -gt 0) { [string]$action[0].WorkingDirectory } else { $null } } | ConvertTo-Json -Compress))",
  ].join("; ");
  const runtimeBinding = await new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("pwsh", ["-NoProfile", "-Command", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        try {
          resolvePromise(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      } else {
        reject(
          new Error(
            `pwsh exited with ${code ?? "signal"} while collecting Vision binding: ${stderr || stdout}`,
          ),
        );
      }
    });
  });
  return {
    installedRecord,
    siteConfiguration,
    ...runtimeBinding,
    executableSha256: fileSha256(VISION_ENTRYPOINT_PATH),
    siteConfigurationSha256: fileSha256(VISION_SITE_CONFIGURATION_PATH),
    downloadManifestSha256: fileSha256(installedRecord.downloadManifest.path),
    fixtureManifestSha256: fileSha256(installedRecord.fixtureSet.manifestPath),
    fixtureTopSha256: fileSha256(installedRecord.fixtureSet.top.path),
    fixtureFrontSha256: fileSha256(installedRecord.fixtureSet.front.path),
    fixtureExpectedResultsSha256: fileSha256(
      installedRecord.fixtureSet.expectedResults.path,
    ),
  };
}

async function stopVisionRuntime() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `Stop-ScheduledTask -TaskName '${VISION_TASK_NAME}' -TaskPath '${VISION_TASK_PATH}' -ErrorAction SilentlyContinue`,
    "Get-Process vending-vision -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
  ].join("; ");
  await new Promise((resolvePromise, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-Command", command], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `pwsh exited with ${code ?? "signal"} while stopping Vision runtime`,
          ),
        );
    });
  });
}

async function startInstalledVisionRuntime() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `Start-ScheduledTask -TaskName '${VISION_TASK_NAME}' -TaskPath '${VISION_TASK_PATH}' -ErrorAction Stop`,
  ].join("; ");
  await new Promise((resolvePromise, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-Command", command], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `pwsh exited with ${code ?? "signal"} while starting Vision runtime`,
          ),
        );
    });
  });
}

async function probeLoopbackPortRelease(port, host = "127.0.0.1") {
  return await new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once("error", (error) => {
      finish({
        released: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => finish({ released: true }));
    });
  });
}

export async function waitForVisionPortRelease(
  timeoutMs = 20_000,
  { port = 7892, host = "127.0.0.1" } = {},
) {
  await waitForCondition(
    "Vision port release",
    async () => {
      const probe = await probeLoopbackPortRelease(port, host);
      return {
        ok: probe.released === true,
        value: probe,
      };
    },
    timeoutMs,
    250,
  );
}

async function terminateVisionChild(child, timeoutMs = 10_000) {
  if (!child) return;
  child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      sleep(timeoutMs).then(() => {
        throw new Error("vision mock did not exit after SIGTERM");
      }),
    ]);
  }
}

export async function startVisionMockScenario(scenario, timeoutMs = 20_000) {
  const portWasAvailable = (await probeLoopbackPortRelease(7892, "127.0.0.1"))
    .released;
  const child = spawn(
    process.execPath,
    [
      "--conditions=vem-source",
      "--import",
      "tsx",
      "apps/vision-mock/src/server.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VISION_MOCK_PORT: "7892",
        VISION_MOCK_PATH: "/ws",
        VISION_MOCK_SCENARIO: scenario,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  try {
    await waitForCondition(
      `vision mock scenario ${scenario}`,
      async () => {
        if (child.exitCode !== null) {
          return {
            ok: false,
            value: {
              error: `vision mock exited early with code ${child.exitCode}`,
            },
          };
        }
        if (child.signalCode !== null) {
          return {
            ok: false,
            value: {
              error: `vision mock exited early with signal ${child.signalCode}`,
            },
          };
        }
        try {
          const health = await fetchJson("http://127.0.0.1:7892/health");
          return {
            ok: health?.mockScenario === scenario && health?.status === "ok",
            value: health,
          };
        } catch (error) {
          return { ok: false, value: { error: String(error) } };
        }
      },
      timeoutMs,
      500,
    );
    return child;
  } catch (error) {
    let startupError =
      error instanceof Error ? error : new Error(String(error));
    try {
      await terminateVisionChild(child, timeoutMs);
      if (portWasAvailable) {
        await waitForVisionPortRelease(timeoutMs, {
          port: 7892,
          host: "127.0.0.1",
        });
      }
    } catch (cleanupError) {
      startupError = combineCleanupFailure(
        startupError,
        cleanupError instanceof Error
          ? cleanupError
          : new Error(String(cleanupError)),
        "vision mock startup cleanup",
      );
    }
    throw startupError;
  }
}

export async function stopVisionChild(
  child,
  { timeoutMs = 10_000, port = 7892, host = "127.0.0.1" } = {},
) {
  if (!child) return;
  await terminateVisionChild(child, timeoutMs);
  await waitForVisionPortRelease(timeoutMs, { port, host });
}

async function waitForVisionDegradation(handoff, timeoutMs = 45_000) {
  return waitForCondition(
    "vision degradation",
    async () => {
      const [visionStatus, saleCapability, healthz, readyz] = await Promise.all(
        [
          daemonGet(handoff, "/v1/vision/status").catch(() => null),
          daemonGet(handoff, "/v1/sale-start-capability").catch(() => null),
          daemonGet(handoff, "/healthz").catch(() => null),
          daemonGet(handoff, "/readyz").catch(() => null),
        ],
      );
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

async function waitForVisionOnline(handoff, timeoutMs = 45_000) {
  return waitForCondition(
    "vision online",
    async () => {
      const [visionStatus, saleCapability] = await Promise.all([
        daemonGet(handoff, "/v1/vision/status").catch(() => null),
        daemonGet(handoff, "/v1/sale-start-capability").catch(() => null),
      ]);
      return {
        ok:
          visionStatus?.online === true &&
          saleCapability?.canStartSale === true,
        value: { visionStatus, saleCapability },
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

async function waitForTryOnButtonEnabled(client, timeoutMs = 30_000) {
  return waitForCondition(
    "try-on available button state",
    async () => {
      const state = await readProductDetailState(client);
      return {
        ok:
          state?.tryOnPresent === true &&
          state?.tryOnDisabled === false &&
          state?.buyDisabled === false,
        value: state,
      };
    },
    timeoutMs,
    500,
  );
}

async function waitForTryOnFailure(client, timeoutMs = 30_000) {
  return waitForCondition(
    "try-on failure surface",
    async () => {
      const state = await evaluateExpression(
        client,
        `(() => {
          const error = document.querySelector("[data-test='try-on-error']");
          const preview = document.querySelector("[data-test='try-on-preview']");
          return {
            route: location.hash,
            errorText: error?.textContent?.replace(/\\s+/g, " ").trim() ?? null,
            previewUrl: preview?.getAttribute("src") ?? null,
          };
        })()`,
      );
      return {
        ok:
          String(state?.route ?? "").includes("/try-on") &&
          typeof state?.errorText === "string" &&
          state.errorText.length > 0,
        value: state,
      };
    },
    timeoutMs,
    500,
  );
}

async function readMjpegFrameEvidence(client, previewUrl, timeoutMs = 30_000) {
  return waitForCondition(
    "decoded MJPEG frame",
    async () => {
      const result = await evaluateExpression(
        client,
        `(async () => {
          try {
            const response = await fetch(${JSON.stringify(previewUrl)});
            if (!response.ok || !response.body) {
              return { ok: false, reason: "http", status: response.status };
            }
            const reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            const maxBytes = 512 * 1024;
            while (total < maxBytes) {
              const { done, value } = await reader.read();
              if (done || !value) break;
              chunks.push(value);
              total += value.byteLength;
              let jpeg = null;
              const merged = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.byteLength;
              }
              let start = -1;
              for (let i = 0; i < merged.length - 1; i += 1) {
                if (merged[i] === 0xff && merged[i + 1] === 0xd8) { start = i; break; }
              }
              if (start >= 0) {
                for (let i = start + 2; i < merged.length - 1; i += 1) {
                  if (merged[i] === 0xff && merged[i + 1] === 0xd9) {
                    jpeg = merged.slice(start, i + 2);
                    break;
                  }
                }
              }
              if (!jpeg) continue;
              const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
              const canvas = document.createElement("canvas");
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              const context = canvas.getContext("2d");
              if (!context) {
                return { ok: false, reason: "context" };
              }
              context.drawImage(bitmap, 0, 0);
              const imageData = context.getImageData(0, 0, canvas.width, canvas.height).data;
              let nonBlackPixelCount = 0;
              for (let i = 0; i < imageData.length; i += 4) {
                if (
                  imageData[i] !== 0 ||
                  imageData[i + 1] !== 0 ||
                  imageData[i + 2] !== 0
                ) {
                  nonBlackPixelCount += 1;
                  if (nonBlackPixelCount >= 8) break;
                }
              }
              return {
                ok: true,
                contentType: response.headers.get("content-type"),
                frameByteLength: jpeg.byteLength,
                width: canvas.width,
                height: canvas.height,
                nonBlackPixelCount,
                sessionId: ${JSON.stringify(previewUrl)}.split("/").pop()?.replace(/\\.mjpeg$/i, "") ?? null,
                sourceFrame: {
                  adapter: response.headers.get("x-vem-frame-source-adapter"),
                  role: response.headers.get("x-vem-frame-source-role"),
                  configSha256: response.headers.get("x-vem-frame-source-config-sha256"),
                  fixtureSha256: response.headers.get("x-vem-frame-source-file-sha256"),
                  frameIndex: Number(response.headers.get("x-vem-frame-source-frame-index") ?? "-1"),
                  decodedFrameCount: Number(response.headers.get("x-vem-frame-source-decoded-frame-count") ?? "0"),
                  sessionId: response.headers.get("x-vem-frame-source-session-id"),
                },
              };
            }
            return { ok: false, reason: "no-jpeg" };
          } catch (error) {
            return { ok: false, reason: String(error) };
          }
        })()`,
      );
      return { ok: result?.ok === true, value: result };
    },
    timeoutMs,
    500,
  );
}

async function runVisionTryOnAcceptance(options) {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const handoff = readJson(options.handoffPath, "handoff");
  const sink = screenshotSink(options.outPath);
  const runtimeExpectation = normalizeSeededVisionAcceptance(
    guestInput.visionAcceptance,
  );
  const allocatedFixture = guestInput.fixtureAllocation?.[options.fixtureKey];
  if (!allocatedFixture?.slotCode || !allocatedFixture?.inventoryId) {
    throw new Error(`fixture allocation is absent for ${options.fixtureKey}`);
  }
  if (
    options.fixtureKey !== "visionTryOn" ||
    allocatedFixture.slotCode !== "A3"
  ) {
    throw new Error(
      "Vision/try-on must use the dedicated A3 fixture allocation",
    );
  }
  let client = null;
  let injectedVisionMock = null;
  const checkpoints = [];
  let stage = "connect-installed-tauri-cdp";
  let report = null;
  let pendingError = null;
  let realVisionStopped = false;
  let restoredRuntimeVerification = null;
  try {
    const installedBinding = await collectVisionInstalledBinding();
    const installedBindingSummary =
      validateVisionInstalledBinding(installedBinding);
    const expectedResults = normalizeVisionExpectedResults(
      readJson(
        visionFixtureExpectedResultsPath(
          installedBindingSummary.installedCommit,
        ),
        "Vision expected-results fixture",
      ),
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
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        "http://127.0.0.1:9222",
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });

    stage = "open-tshirt-category-baseline";
    await activateVisibleSelector(
      client,
      '[data-test="catalog-category"][data-category-key="tshirts"]',
      { kind: "touch", timeoutMs: 30_000 },
    );
    const baselineCatalogProjection = await waitForCatalogProducts(client);

    stage = "reset-installed-vision-fixture-source";
    await stopVisionRuntime();
    realVisionStopped = true;
    await waitForVisionPortRelease();
    await startInstalledVisionRuntime();
    await waitForCondition(
      "restarted Vision health",
      async () => {
        const health = await fetchJson("http://127.0.0.1:7892/health").catch(
          () => null,
        );
        return { ok: health?.status === "ok", value: health };
      },
      45_000,
      100,
    );
    realVisionStopped = false;

    stage = "collect-vision-protocol";
    const protocolEvidence = await collectVisionProtocolEvidence({
      machineCode: guestInput.machineCode,
    });
    const protocolSummary = compareObservedVisionProtocolToExpected({
      expectedResults,
      protocolEvidence,
      installedBinding: installedBindingSummary,
    });

    stage = "wait-catalog-recommendation-projection";
    const catalogRecommendation = await waitForCatalogRecommendationProjection(
      client,
      baselineCatalogProjection.products.map((product) => product.catalogKey),
    );
    const recommendationSummary = validateRecommendationProjection({
      beforeProducts: baselineCatalogProjection.products,
      afterProducts: catalogRecommendation.products,
      pageText: catalogRecommendation.pageText,
      expectedResults,
      runtimeExpectation,
    });
    checkpoints.push(
      await captureCheckpoint(client, "catalog-recommendation", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );

    stage = "open-expected-recommended-product";
    await activateVisibleSelector(
      client,
      `[data-test="catalog-product"][data-catalog-key="${recommendationSummary.selectedCatalogKey}"]`,
      {
        kind: "touch",
        timeoutMs: 30_000,
      },
    );
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const productDetail = await readProductDetailState(client);
    assert.equal(
      productDetail?.catalogKey,
      recommendationSummary.selectedCatalogKey,
    );
    assert.equal(
      productDetail?.variantId,
      recommendationSummary.selectedVariantId,
    );
    assert.equal(productDetail?.tryOnPresent, true);
    assert.equal(productDetail?.tryOnDisabled, false);
    assert.equal(productDetail?.buyDisabled, false);

    stage = "open-try-on";
    await activateVisibleSelector(client, '[data-test="try-on-entry"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await waitForRoute(client, /^#\/products\/.+\/try-on/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const tryOnSurface = await waitForTryOnSurface(client, 60_000);
    const silhouetteEvidence = await readImageHttpEvidence(
      tryOnSurface.silhouetteUrl,
    );
    const mjpegEvidence = await readMjpegFrameEvidence(
      client,
      tryOnSurface.previewUrl,
    );
    const tryOnSummary = validateTryOnPresentation({
      selectedProduct: {
        catalogKey: recommendationSummary.selectedCatalogKey,
        variantId: recommendationSummary.selectedVariantId,
      },
      tryOnState: tryOnSurface,
      mjpegEvidence,
      expectedResults,
      runtimeExpectation,
      silhouetteEvidence,
      installedBinding: installedBindingSummary,
    });
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
      throw new Error(
        "sale start capability must remain available before degradation",
      );
    }

    stage = "stop-real-vision-runtime";
    await stopVisionRuntime();
    realVisionStopped = true;
    await waitForVisionPortRelease();
    const degradedDaemon = await waitForVisionDegradation(handoff, 45_000);
    const degradedProductDetail = await waitForTryOnButtonDisabled(
      client,
      30_000,
    );
    assert.equal(degradedProductDetail?.buyDisabled, false);
    checkpoints.push(
      await captureCheckpoint(client, "vision-degraded-product", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );

    stage = "inject-online-try-on-failure";
    injectedVisionMock = await startVisionMockScenario(
      "try_on_unavailable_start",
    );
    const onlineMockDaemon = await waitForVisionOnline(handoff, 45_000);
    const restoredProductDetail = await waitForTryOnButtonEnabled(
      client,
      30_000,
    );
    await activateVisibleSelector(client, '[data-test="try-on-entry"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/products\/.+\/try-on/, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const tryOnFailure = await waitForTryOnFailure(client, 30_000);
    checkpoints.push(
      await captureCheckpoint(client, "try-on-degraded", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );
    await activateVisibleSelector(client, '[data-test="try-on-exit"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const degradedTryOnProductDetail = await waitForTryOnButtonDisabled(
      client,
      30_000,
    );
    assert.equal(degradedTryOnProductDetail?.buyDisabled, false);

    stage = "prove-sale-survives-experience-degradation";
    await activateVisibleSelector(client, '[data-test="product-buy"]', {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, "#/checkout", {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    checkpoints.push(
      await captureCheckpoint(client, "degraded-checkout", {
        screenshot: true,
        screenshotSink: sink,
      }),
    );

    const runtimeTrace = await readRuntimeTrace(client);
    report = {
      schemaVersion: "vem-vision-try-on-acceptance/v1",
      ok: true,
      mode: options.mode,
      machineCode: guestInput.machineCode,
      visionInstall: {
        installedRecord: installedBinding.installedRecord,
        installedBinding: installedBindingSummary,
        siteConfiguration,
        fixtureRoot: VISION_FIXTURE_ROOT,
        expectedResults,
        runtimeExpectation,
        fixtureAllocation: allocatedFixture,
      },
      health: {
        daemon: {
          healthz: degradedDaemon.healthz,
          readyz: degradedDaemon.readyz,
          visionStatus: degradedDaemon.visionStatus,
          saleCapabilityBeforeDegradation: capabilityBeforeDegradation,
          saleCapabilityAfterDegradation: degradedDaemon.saleCapability,
          onlineTryOnFailure: onlineMockDaemon,
        },
        vision: {
          protocolSummary,
          observedMessages: protocolEvidence.observedMessages.slice(0, 8),
          restoredRuntime: restoredRuntimeVerification,
        },
      },
      ui: {
        catalogRecommendation,
        recommendationSummary,
        productDetail,
        tryOnSurface,
        silhouetteEvidence,
        tryOnSummary,
        degradedProductDetail,
        restoredProductDetail,
        degradedTryOnProductDetail,
        tryOnFailure,
        finalRoute: "#/checkout",
      },
      degradations: {
        visionDown: {
          experienceCapabilityDegraded: true,
          saleStartStillAvailable:
            degradedDaemon.saleCapability?.canStartSale === true,
        },
        tryOnUnavailableWhileVisionOnline: {
          experienceCapabilityDegraded: true,
          saleStartStillAvailable:
            onlineMockDaemon.saleCapability?.canStartSale === true,
          visionOnline: onlineMockDaemon.visionStatus?.online === true,
        },
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
  } catch (error) {
    pendingError = error instanceof Error ? error : new Error(String(error));
    const failureTrace = client
      ? await readRuntimeTrace(client).catch(() => [])
      : [];
    const failureCheckpoint = client
      ? await captureCheckpoint(client, `failure-${stage}`, {
          screenshot: true,
          screenshotSink: sink,
        }).catch(() => null)
      : null;
    const failureCheckpoints = failureCheckpoint
      ? [...checkpoints, failureCheckpoint]
      : [...checkpoints];
    report = {
      schemaVersion: "vem-vision-try-on-acceptance/v1",
      ok: false,
      mode: options.mode,
      stage,
      error: serializeError(pendingError),
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
  }

  const cleanupErrors = [];
  try {
    await stopVisionChild(injectedVisionMock);
  } catch (error) {
    cleanupErrors.push(
      new Error(
        `vision mock shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  try {
    await client?.close();
  } catch (error) {
    cleanupErrors.push(
      new Error(
        `machine UI CDP shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (realVisionStopped) {
    try {
      await startInstalledVisionRuntime();
      const daemonVision = await waitForVisionOnline(handoff, 45_000);
      const restoredBinding = await collectVisionInstalledBinding();
      const restoredBindingSummary =
        validateVisionInstalledBinding(restoredBinding);
      const restoredProtocolEvidence = await collectVisionProtocolEvidence({
        machineCode: guestInput.machineCode,
        timeoutMs: 45_000,
      });
      const restoredProtocolSummary = validateVisionProtocolEvidence(
        restoredProtocolEvidence,
        restoredBindingSummary,
      );
      restoredRuntimeVerification = {
        daemonVision,
        installedBinding: restoredBindingSummary,
        protocolSummary: restoredProtocolSummary,
      };
      if (report?.health?.vision) {
        report.health.vision.restoredRuntime = restoredRuntimeVerification;
      }
    } catch (error) {
      cleanupErrors.push(
        new Error(
          `vision runtime restore failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  if (cleanupErrors.length > 0) {
    const cleanupError =
      cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(
            cleanupErrors,
            "vision try-on acceptance cleanup failed",
          );
    pendingError = combineCleanupFailure(
      pendingError,
      cleanupError,
      "vision try-on acceptance cleanup",
    );
    report = {
      ...(report ?? {
        schemaVersion: "vem-vision-try-on-acceptance/v1",
        mode: options.mode,
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
        },
      }),
      ok: false,
      stage: `cleanup:${stage}`,
      error: serializeError(pendingError),
      cleanupErrors: cleanupErrors.map((error) => serializeError(error)),
    };
  }

  writeReport(options.outPath, report);
  if (pendingError) throw pendingError;
  return report;
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
