import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { collectInstalledAiOwnerAttempts } from "./ai-virtual-try-on-installed-entry.mjs";
import {
  activateVisibleSelector,
  CdpClient,
  enablePageRuntime,
} from "./machine-ui-cdp-driver.mjs";
import {
  activateAfterFreshVisionPresenceArrival,
  buildVisionInstalledRuntimeBinding,
  buildRecordedVisionSiteConfiguration,
  combineCleanupFailure,
  collectInstalledAiTryOnAttempt,
  collectInstalledAiTryOnAttemptForTest,
  collectVisionProtocolEvidence,
  compareObservedVisionProtocolToExpected as compareRawObservedVisionProtocolToExpected,
  createVisionEventFence,
  INSTALL_TRY_ON_LIFECYCLE_OBSERVER_EXPRESSION,
  isVmFastCoreVisionRecommendationSkip,
  normalizeSeededVisionAcceptance,
  normalizeVisionExpectedResults,
  parseVisionTryOnAcceptanceArgs,
  runFastTryOnOwnerAttempts,
  readVisionV2ContractIdentity,
  READ_TRY_ON_LIFECYCLE_EXPRESSION,
  startVisionMockScenario,
  stopVisionChild,
  validateRecommendationProjection,
  validateRecommendationPresentation,
  validateSeededRecommendationVariants,
  validateSizeControlPresentation,
  validateTryOnPresentation,
  validateVisionInstalledBinding,
  validateVisionEventFence,
  validateVisionProtocolEvidence as validateRawVisionProtocolEvidence,
  validateVisionRuntimeEvidence as validateRawVisionRuntimeEvidence,
  waitForClearedVisionRecommendationBaseline,
  waitForFreshVisionPresenceArrival,
  waitForVisionInstalledBindingObservation,
  waitForVisionPortRelease,
} from "./vision-try-on-acceptance.mjs";

const VISION_V2_IDENTITY = readVisionV2ContractIdentity();

describe("try-on presence-window coordination", () => {
  const snapshot = (entries, runtimeGenerationId = "installed-run-1") => ({
    runtimeGenerationId,
    entries,
  });
  const welcome = (id, number) => ({
    id,
    type: "journey_transition",
    transitionId: `vision:presence-${number}:welcome`,
  });
  const departed = (id, number) => ({
    id,
    type: "journey_transition",
    transitionId: `vision:presence-${number}:departed`,
  });
  it("waits for an arrival after the captured runtime-trace cursor", async () => {
    const snapshots = [
      {
        runtimeGenerationId: "installed-run-1",
        entries: [
          {
            id: 41,
            type: "journey_transition",
            transitionId: "vision:presence-4:welcome",
          },
        ],
      },
      {
        runtimeGenerationId: "installed-run-1",
        entries: [
          {
            id: 41,
            type: "journey_transition",
            transitionId: "vision:presence-4:welcome",
          },
          {
            id: 42,
            type: "journey_transition",
            transitionId: "vision:presence-5:welcome",
          },
        ],
      },
    ];

    const arrival = await waitForFreshVisionPresenceArrival(
      {
        readRuntimeTraceSnapshot: async () =>
          snapshots.shift() ?? snapshots.at(-1),
      },
      { timeoutMs: 100, pollMs: 1 },
    );

    assert.equal(arrival.baselineTraceId, 41);
    assert.equal(arrival.entry.id, 42);
    assert.equal(arrival.entry.transitionId, "vision:presence-5:welcome");
  });

  it("does not admit an arrival that already departed in the same trace snapshot", async () => {
    const departedSnapshot = {
      runtimeGenerationId: "installed-run-1",
      entries: [
        {
          id: 42,
          type: "journey_transition",
          transitionId: "vision:presence-5:welcome",
        },
        {
          id: 43,
          type: "journey_transition",
          transitionId: "vision:presence-6:departed",
        },
      ],
    };
    const snapshots = [
      { runtimeGenerationId: "installed-run-1", entries: [] },
      departedSnapshot,
    ];

    await assert.rejects(
      waitForFreshVisionPresenceArrival(
        {
          readRuntimeTraceSnapshot: async () =>
            snapshots.shift() ?? departedSnapshot,
        },
        { timeoutMs: 10, pollMs: 1 },
      ),
      /fresh Vision presence arrival did not become true/,
    );
  });

  it("fails closed for stale, duplicate, other-journey, drifted, and departed arrivals", async () => {
    const invalidTraces = [
      [snapshot([welcome(9, 1)]), snapshot([welcome(9, 1)])],
      [snapshot([welcome(9, 1)]), snapshot([welcome(9, 1), welcome(10, 1)])],
      [
        snapshot([]),
        snapshot([
          {
            id: 1,
            type: "journey_transition",
            transitionId: "checkout:welcome",
          },
        ]),
      ],
      [snapshot([]), snapshot([welcome(1, 1)], "other-generation")],
      [snapshot([]), snapshot([welcome(1, 1), departed(2, 2)])],
    ];
    for (const snapshots of invalidTraces) {
      let index = 0;
      await assert.rejects(
        activateAfterFreshVisionPresenceArrival(
          {
            readRuntimeTraceSnapshot: async () =>
              snapshots[Math.min(index++, snapshots.length - 1)],
            activate: async () => assert.fail("invalid trace must not click"),
          },
          { timeoutMs: 10, pollMs: 1 },
        ),
        /generation changed|fresh Vision presence arrival did not become true|timed out/,
      );
    }
  });
});

function cdpValue(value, id) {
  return { id, result: { result: { value } } };
}

class AcceptanceFakeWebSocket {
  constructor(handler) {
    this.handler = handler;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type, handler, options = {}) {
    const values = this.listeners.get(type) ?? [];
    values.push({ handler, once: options.once === true });
    this.listeners.set(type, values);
  }

  removeEventListener(type, handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (entry) => entry.handler !== handler,
      ),
    );
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    const response = this.handler(message, this);
    if (response)
      queueMicrotask(() =>
        this.emit("message", { data: JSON.stringify(response) }),
      );
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    const values = [...(this.listeners.get(type) ?? [])];
    for (const value of values) value.handler(event);
    this.listeners.set(
      type,
      values.filter((value) => !value.once),
    );
  }
}

async function withTryOnOwnerTouchHarness(
  { firstArrivalId, secondArrivalId },
  callback,
) {
  const welcome = (id) => ({
    id,
    type: "journey_transition",
    transitionId: `vision:presence-${id}:welcome`,
  });
  const first = welcome(firstArrivalId);
  const second = welcome(secondArrivalId);
  const snapshot = (entries) => ({ runtimeGenerationId: "run-1", entries });
  const snapshots = [
    snapshot([]),
    snapshot([first]),
    snapshot([first]),
    snapshot([first]),
    snapshot([first, second]),
    snapshot([first, second]),
  ];
  const trace = [];
  let snapshotIndex = 0;
  const readRuntimeTraceSnapshot = async () => {
    const value = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
    trace.push(`read:${value.entries.at(-1)?.id ?? 0}`);
    return value;
  };
  let pendingSelector = null;
  const socket = new AcceptanceFakeWebSocket((message) => {
    if (message.method === "Runtime.evaluate") {
      pendingSelector = message.params.expression.includes("try-on-retry")
        ? "retry"
        : "initial";
      return cdpValue(
        {
          exists: true,
          actionable: true,
          inViewport: true,
          hitTarget: true,
          pointerEvents: "auto",
          bounds: { x: 10, y: 20, width: 40, height: 60 },
          center: { x: 30, y: 50 },
        },
        message.id,
      );
    }
    if (
      message.method === "Input.dispatchTouchEvent" &&
      message.params.type === "touchStart"
    )
      trace.push(`touch:${pendingSelector}`);
    return { id: message.id, result: {} };
  });
  const client = new CdpClient("ws://127.0.0.1/devtools/page/owner", {
    webSocketFactory: () => socket,
    defaultTimeoutMs: 250,
  });
  try {
    await client.connect();
    await enablePageRuntime(client);
    return await callback({ client, readRuntimeTraceSnapshot, trace });
  } finally {
    await client.close();
  }
}

describe("Fast try-on production owner", () => {
  it("admits a fresh active arrival independently before initial and retry touches", async () => {
    await withTryOnOwnerTouchHarness(
      { firstArrivalId: 1, secondArrivalId: 2 },
      async ({ client, readRuntimeTraceSnapshot, trace }) => {
        const result = await runFastTryOnOwnerAttempts({
          client,
          collectInitial: async () => "initial-result",
          collectRetry: async () => "retry-result",
          readRuntimeTraceSnapshot,
          timeoutMs: 100,
          pollMs: 1,
        });

        assert.deepEqual(
          result.admissions.map((admission) => admission.entry.id),
          [1, 2],
        );
        assert.deepEqual(result.results, ["initial-result", "retry-result"]);
        assert.deepEqual(trace, [
          "read:0",
          "read:1",
          "read:1",
          "touch:initial",
          "read:1",
          "read:2",
          "read:2",
          "touch:retry",
        ]);
      },
    );
  });
});

describe("AI try-on production owner", () => {
  it("passes a fresh active arrival gate to initial and retry collectors before touch", async () => {
    await withTryOnOwnerTouchHarness(
      { firstArrivalId: 11, secondArrivalId: 12 },
      async ({ client, readRuntimeTraceSnapshot, trace }) => {
        const collectAttempt = async (options) => {
          const admitted = await activateAfterFreshVisionPresenceArrival(
            {
              activate: async () =>
                await activateVisibleSelector(
                  client,
                  options.activationSelector,
                  { kind: "touch", timeoutMs: 100, pollMs: 1 },
                ),
              readRuntimeTraceSnapshot: options.readRuntimeTraceSnapshot,
            },
            { timeoutMs: 100, pollMs: 1 },
          );
          return {
            admission: admitted.admission,
            attemptId:
              options.activationSelector === '[data-test="try-on-ai"]'
                ? "ai-initial"
                : "ai-retry",
          };
        };
        const result = await collectInstalledAiOwnerAttempts({
          collectAttempt,
          initialOptions: { client },
          readRuntimeTraceSnapshot,
          retryOptions: { client },
        });

        assert.deepEqual(
          [result.initial, result.retry].map((attempt) => ({
            admissionId: attempt.admission.entry.id,
            attemptId: attempt.attemptId,
          })),
          [
            { admissionId: 11, attemptId: "ai-initial" },
            { admissionId: 12, attemptId: "ai-retry" },
          ],
        );
        assert.deepEqual(trace, [
          "read:0",
          "read:11",
          "read:11",
          "touch:initial",
          "read:11",
          "read:12",
          "read:12",
          "touch:retry",
        ]);
      },
    );
  });
});

async function withInstalledAiHarness(options, callback) {
  const attemptId = "0198f44e-21bd-7c62-8f52-b7c86cc2d101";
  const lifecycleAttemptId = options.lifecycleAttemptId ?? attemptId;
  const resultAttemptId = options.resultAttemptId ?? attemptId;
  const route = "#/try-on?catalogKey=product-shirts&variantId=variant-long";
  const networkPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const server = createHttpServer((request, response) => {
    if (
      new URL(request.url, "http://127.0.0.1").pathname !==
      `/v2/try-on/results/${resultAttemptId}`
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": options.contentType ?? "image/png",
      "content-length": String(networkPng.byteLength),
    });
    response.end(networkPng);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const root = mkdtempSync(join(tmpdir(), "vem-installed-ai-cdp-negative-"));
  const delayedNetworkTimers = [];
  let outsideRoot = null;
  const evidenceName =
    options.sidecarAttemptId === null
      ? null
      : `${options.sidecarAttemptId ?? attemptId}.regional-evidence.json`;
  if (evidenceName) {
    const evidencePath = join(root, evidenceName);
    if (options.sidecarSymlink) {
      outsideRoot = mkdtempSync(join(tmpdir(), "vem-ai-sidecar-outside-"));
      const outside = join(outsideRoot, "outside.json");
      writeFileSync(outside, "{}\n");
      symlinkSync(outside, evidencePath);
    } else {
      writeFileSync(evidencePath, "{}\n");
    }
  }
  if (options.extraSidecar)
    writeFileSync(join(root, "extra.regional-evidence.json"), "{}\n");
  const resultUrl = `http://127.0.0.1:${server.address().port}/v2/try-on/results/${resultAttemptId}?token=result-token`;
  const lifecycle = [
    "starting",
    "accepted",
    "acquiring",
    "generating",
    "completed",
  ].map((phase) => ({
    attemptId: lifecycleAttemptId,
    phase,
    ...(phase === "acquiring"
      ? {
          acquisitionPreview:
            "http://127.0.0.1/v2/try-on/acquisition/preview.mjpeg?token=acceptance-token",
        }
      : {}),
  }));
  const socket = new AcceptanceFakeWebSocket((message, activeSocket) => {
    if (message.method !== "Runtime.evaluate")
      if (
        message.method === "Input.dispatchTouchEvent" &&
        message.params.type === "touchStart"
      ) {
        const emitNetworkResponse = () => {
          activeSocket.emit("message", {
            data: JSON.stringify({
              method: "Network.responseReceived",
              params: {
                requestId: "ai-result-request",
                type: "Image",
                response: {
                  url: options.networkWrongUrl
                    ? `${resultUrl}/wrong-attempt`
                    : resultUrl,
                  status: 200,
                  mimeType:
                    options.networkMimeType ??
                    options.contentType ??
                    "image/png",
                  fromDiskCache: options.fromDiskCache === true,
                  fromServiceWorker: false,
                  headers:
                    options.missingContentTypeHeader === true
                      ? {}
                      : options.duplicateCaseContentTypeHeaders === true
                        ? {
                            "Content-Type": "image/png",
                            "content-type": "image/png",
                          }
                        : options.conflictingContentTypeHeader === true
                          ? { "Content-Type": "image/png, text/plain" }
                          : {
                              [options.lowercaseContentTypeHeader
                                ? "content-type"
                                : "Content-Type"]:
                                options.responseHeaderContentType ??
                                options.contentType ??
                                "image/png",
                            },
                },
              },
            }),
          });
          if (options.duplicateSameRequestId)
            activeSocket.emit("message", {
              data: JSON.stringify({
                method: "Network.responseReceived",
                params: {
                  requestId: "ai-result-request",
                  type: "Image",
                  response: {
                    url: resultUrl,
                    status: 200,
                    mimeType: "image/png",
                    fromDiskCache: false,
                    fromServiceWorker: false,
                    headers: { "Content-Type": "image/png" },
                  },
                },
              }),
            });
          if (options.servedFromMemoryCache)
            activeSocket.emit("message", {
              data: JSON.stringify({
                method: "Network.requestServedFromCache",
                params: { requestId: "ai-result-request" },
              }),
            });
          activeSocket.emit("message", {
            data: JSON.stringify({
              method: options.loadingFailed
                ? "Network.loadingFailed"
                : "Network.loadingFinished",
              params: {
                requestId: "ai-result-request",
                encodedDataLength: options.oversizedEncodedData
                  ? 9 * 1024 * 1024
                  : networkPng.byteLength,
              },
            }),
          });
          if (options.duplicateNetworkResponse)
            activeSocket.emit("message", {
              data: JSON.stringify({
                method: "Network.responseReceived",
                params: {
                  requestId: "ai-result-request-duplicate",
                  type: "Image",
                  response: {
                    url: resultUrl,
                    status: 200,
                    mimeType: "image/png",
                    fromDiskCache: false,
                    fromServiceWorker: false,
                    headers: { "Content-Type": "image/png" },
                  },
                },
              }),
            });
          if (options.duplicateNetworkResponse)
            activeSocket.emit("message", {
              data: JSON.stringify({
                method: "Network.loadingFinished",
                params: { requestId: "ai-result-request-duplicate" },
              }),
            });
          if (options.redirected)
            activeSocket.emit("message", {
              data: JSON.stringify({
                method: "Network.requestWillBeSent",
                params: {
                  requestId: "ai-result-request",
                  redirectResponse: { status: 302 },
                },
              }),
            });
        };
        if (options.slowResponseMs)
          delayedNetworkTimers.push(
            setTimeout(emitNetworkResponse, options.slowResponseMs),
          );
        else queueMicrotask(emitNetworkResponse);
        return { id: message.id, result: {} };
      } else return { id: message.id, result: {} };
    const expression = message.params.expression;
    if (expression === INSTALL_TRY_ON_LIFECYCLE_OBSERVER_EXPRESSION)
      return cdpValue(true, message.id);
    if (expression === READ_TRY_ON_LIFECYCLE_EXPRESSION)
      return cdpValue(lifecycle, message.id);
    if (expression.includes("document.documentElement?.outerHTML"))
      return cdpValue(
        {
          route,
          url: `http://tauri.localhost/${route}`,
          pathname: "/",
          title: "Machine",
          readyState: "complete",
          activeElement: "body",
          domLength: 42,
          domHash: "deadbeef",
        },
        message.id,
      );
    if (expression.includes("const selector ="))
      return cdpValue(
        {
          exists: true,
          actionable: true,
          inViewport: true,
          hitTarget: true,
          pointerEvents: "auto",
          bounds: { x: 10, y: 20, width: 40, height: 60 },
          center: { x: 30, y: 50 },
        },
        message.id,
      );
    if (expression.includes("[data-test='try-on-view']"))
      return cdpValue(
        {
          route,
          attemptId,
          state: "completed",
          resultUrl,
          resultLoaded: true,
          resultNaturalWidth: 320,
          resultNaturalHeight: 480,
          retryVisible: true,
          returnVisible: true,
          errorText: null,
        },
        message.id,
      );
    if (expression.includes("createImageBitmap")) {
      return cdpValue(
        options.decodeFailure
          ? { ok: false, reason: "decode" }
          : {
              ok: true,
              width: 320,
              height: 480,
              nonBlackPixelCount: 8,
              rgbaSha256: "a".repeat(64),
            },
        message.id,
      );
    }
    throw new Error(`unexpected Runtime.evaluate expression: ${expression}`);
  });
  const client = new CdpClient("ws://127.0.0.1/devtools/page/negative", {
    webSocketFactory: () => socket,
    defaultTimeoutMs: 250,
  });
  try {
    await client.connect();
    await enablePageRuntime(client);
    return await callback({ attemptId, client, root, route, socket });
  } finally {
    for (const timer of delayedNetworkTimers) clearTimeout(timer);
    await client.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
    if (outsideRoot) rmSync(outsideRoot, { recursive: true, force: true });
  }
}

const validateVisionProtocolEvidence = validateRawVisionProtocolEvidence;
const validateVisionRuntimeEvidence = validateRawVisionRuntimeEvidence;
const compareObservedVisionProtocolToExpected =
  compareRawObservedVisionProtocolToExpected;

function runMachineVisionAuthority(...args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      "scripts/testbed/run-machine-vision-lifecycle-authority.mjs",
      ...args,
    ]);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stderr });
    });
  });
}

function baseExpectedResults() {
  return {
    schemaVersion: "vending-vision-expected-results/v1",
    protocol: {
      ready: { protocol: VISION_V2_IDENTITY.protocol },
      presence: {
        type: "vision.presence_status",
        source: "top",
      },
      profile: {
        type: "vision.profile_result",
        source: "front",
      },
      departure: {
        type: "vision.person_departed",
        source: "top",
      },
    },
    recommendation: {
      minimumScore: 0.6,
    },
    tryOn: {},
  };
}

function frameSourceBinding() {
  return {
    adapter: "recorded_video",
    configSha256: "a".repeat(64),
    top: {
      path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\top.mp4",
      sha256: "b".repeat(64),
    },
    front: {
      path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\front.mp4",
      sha256: "c".repeat(64),
    },
    expectedResults: {
      path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\expected-results.json",
      sha256: "d".repeat(64),
    },
  };
}

function sourceFrame(role, fixtureSha256, overrides = {}) {
  return {
    adapter: "recorded_video",
    role,
    configSha256: "a".repeat(64),
    fixtureSha256,
    frameIndex: 3,
    decodedFrameCount: 4,
    synthetic: false,
    relabeled: false,
    ...overrides,
  };
}

describe("vision try-on acceptance script", () => {
  it("enables the VM Fast recommendation skip only for the exact marker", () => {
    assert.equal(
      isVmFastCoreVisionRecommendationSkip({
        VEM_VM_ACCEPTANCE_SKIP_VISION_RECOMMENDATION: "1",
      }),
      true,
    );
    for (const value of [undefined, "", "true", "0", "1 "]) {
      assert.equal(
        isVmFastCoreVisionRecommendationSkip({
          VEM_VM_ACCEPTANCE_SKIP_VISION_RECOMMENDATION: value,
        }),
        false,
      );
    }
  });

  it("captures an AI try-on through a production CdpClient touch and waits for its matching regional sidecar", async () => {
    const attemptId = "0198f44e-21bd-7c62-8f52-b7c86cc2d001";
    const route = "#/try-on?catalogKey=product-shirts&variantId=variant-long";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const server = createHttpServer((request, response) => {
      if (
        new URL(request.url, "http://127.0.0.1").pathname !==
        `/v2/try-on/results/${attemptId}`
      ) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(png.byteLength),
      });
      response.end(png);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const root = mkdtempSync(join(tmpdir(), "vem-installed-ai-cdp-"));
    writeFileSync(
      join(root, `${attemptId}.regional-evidence.json`),
      '{"kind":"regional-evidence","schemaVersion":"vem-ai-regional-evidence/v1"}\n',
    );
    const resultUrl = `http://127.0.0.1:${server.address().port}/v2/try-on/results/${attemptId}?token=result-token`;
    const lifecycle = [
      "starting",
      "accepted",
      "acquiring",
      "generating",
      "completed",
    ].map((phase) => ({
      attemptId,
      phase,
      ...(phase === "acquiring"
        ? {
            acquisitionPreview:
              "http://127.0.0.1/v2/try-on/acquisition/preview.mjpeg?token=acceptance-token",
          }
        : {}),
    }));
    const socket = new AcceptanceFakeWebSocket((message, activeSocket) => {
      if (message.method !== "Runtime.evaluate") {
        if (
          message.method === "Input.dispatchTouchEvent" &&
          message.params.type === "touchStart"
        ) {
          queueMicrotask(() => {
            for (const [method, params] of [
              [
                "Network.responseReceived",
                {
                  requestId: "ai-result-request",
                  type: "Image",
                  response: {
                    url: resultUrl,
                    status: 200,
                    mimeType: "image/png",
                    fromDiskCache: false,
                    fromServiceWorker: false,
                    headers: { "Content-Type": "image/png" },
                  },
                },
              ],
              [
                "Network.loadingFinished",
                {
                  requestId: "ai-result-request",
                  encodedDataLength: png.byteLength,
                },
              ],
            ])
              activeSocket.emit("message", {
                data: JSON.stringify({ method, params }),
              });
          });
        }
        if (message.method === "Network.getResponseBody")
          return {
            id: message.id,
            result: { body: png.toString("base64"), base64Encoded: true },
          };
        return { id: message.id, result: {} };
      }
      const expression = message.params.expression;
      if (expression === INSTALL_TRY_ON_LIFECYCLE_OBSERVER_EXPRESSION)
        return cdpValue(true, message.id);
      if (expression === READ_TRY_ON_LIFECYCLE_EXPRESSION)
        return cdpValue(lifecycle, message.id);
      if (expression.includes("document.documentElement?.outerHTML"))
        return cdpValue(
          {
            route,
            url: `http://tauri.localhost/${route}`,
            pathname: "/",
            title: "Machine",
            readyState: "complete",
            activeElement: "body",
            domLength: 42,
            domHash: "deadbeef",
          },
          message.id,
        );
      if (expression.includes('const selector = "[data-test=\\"try-on-ai\\"]"'))
        return cdpValue(
          {
            selector: '[data-test="try-on-ai"]',
            exists: true,
            actionable: true,
            inViewport: true,
            hitTarget: true,
            pointerEvents: "auto",
            bounds: { x: 10, y: 20, width: 40, height: 60 },
            center: { x: 30, y: 50 },
          },
          message.id,
        );
      if (expression.includes("[data-test='try-on-view']"))
        return cdpValue(
          {
            route,
            catalogKey: "product-shirts",
            variantId: "variant-long",
            attemptId,
            state: "completed",
            phaseText: "completed",
            resultUrl,
            resultLoaded: true,
            resultNaturalWidth: 320,
            resultNaturalHeight: 480,
            retryVisible: true,
            returnVisible: true,
            errorText: null,
          },
          message.id,
        );
      if (expression.includes("createImageBitmap"))
        return cdpValue(
          {
            ok: true,
            width: 320,
            height: 480,
            nonBlackPixelCount: 8,
            rgbaSha256: "a".repeat(64),
          },
          message.id,
        );
      throw new Error(`unexpected Runtime.evaluate expression: ${expression}`);
    });
    const client = new CdpClient("ws://127.0.0.1/devtools/page/ai", {
      webSocketFactory: () => socket,
      defaultTimeoutMs: 500,
    });
    try {
      await client.connect();
      await enablePageRuntime(client);
      const collected = await collectInstalledAiTryOnAttempt({
        client,
        expectedTryOnRoute: route,
        regionalEvidenceRoot: root,
        timeoutMs: 1_000,
        pollMs: 5,
      });
      assert.equal(collected.attemptId, attemptId);
      assert.equal(collected.regionalEvidence.byteLength > 0, true);
      assert.match(collected.regionalEvidence.sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(
        Object.keys(collected.regionalEvidence.physicalIdentity).sort(),
        [
          "changedNs",
          "device",
          "inode",
          "linkCount",
          "mode",
          "modifiedNs",
          "size",
        ],
      );
      assert.deepEqual(
        socket.sent
          .filter((message) => message.method === "Input.dispatchTouchEvent")
          .map((message) => message.params.type),
        ["touchStart", "touchEnd"],
      );
      assert.deepEqual(
        socket.sent.filter(
          (message) => message.method === "Network.getResponseBody",
        ),
        [],
      );
      assert.equal(
        socket.sent.some(
          (message) =>
            message.method === "Runtime.evaluate" &&
            /\.click\s*\(/.test(message.params.expression),
        ),
        false,
      );
    } finally {
      await client.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [label, options, reason] of [
    [
      "cross-attempt lifecycle",
      { lifecycleAttemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2d999" },
      /real starting lifecycle state/,
    ],
    [
      "cross-attempt result URL",
      { resultAttemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2d998" },
      /result URL is not bound/,
    ],
    [
      "wrong-attempt sidecar",
      { sidecarAttemptId: "wrong" },
      /did not become true/,
    ],
    ["extra sidecar", { extraSidecar: true }, /did not become true/],
    ["linked sidecar", { sidecarSymlink: true }, /regular file/],
    [
      "bad image content type",
      { contentType: "text/plain" },
      /Network response is invalid/,
    ],
    [
      "image decode failure",
      { decodeFailure: true },
      /decoded Fast V2 result image did not become true/,
    ],
    [
      "wrong Network request URL",
      { networkWrongUrl: true },
      /Network response did not become true/,
    ],
    [
      "Network loading failure",
      { loadingFailed: true },
      /Network response did not become true/,
    ],
    [
      "duplicate Network response",
      { duplicateNetworkResponse: true },
      /Network response did not become true/,
    ],
    [
      "redirected Network response",
      { redirected: true },
      /Network response is invalid/,
    ],
    [
      "cached Network response",
      { fromDiskCache: true },
      /Network response is invalid/,
    ],
    [
      "duplicate responseReceived for one requestId",
      { duplicateSameRequestId: true },
      /Network response is invalid/,
    ],
    [
      "memory-cached Network response",
      { servedFromMemoryCache: true },
      /Network response is invalid/,
    ],
    [
      "missing Content-Type header",
      { missingContentTypeHeader: true },
      /Content-Type header is invalid/,
    ],
    [
      "conflicting Content-Type header",
      { conflictingContentTypeHeader: true },
      /Content-Type header is invalid/,
    ],
    [
      "text Content-Type header despite PNG mimeType",
      {
        networkMimeType: "image/png",
        responseHeaderContentType: "text/plain",
      },
      /Content-Type header is invalid/,
    ],
    [
      "case-duplicate Content-Type header",
      { duplicateCaseContentTypeHeaders: true },
      /Content-Type header is invalid/,
    ],
    [
      "oversized encoded response",
      { oversizedEncodedData: true },
      /encoded size is invalid/,
    ],
  ]) {
    it(`rejects ${label} while collecting an installed AI attempt`, async () => {
      await withInstalledAiHarness(options, async ({ client, root, route }) => {
        await assert.rejects(
          collectInstalledAiTryOnAttempt({
            client,
            expectedTryOnRoute: route,
            regionalEvidenceRoot: root,
            timeoutMs: 100,
            pollMs: 2,
          }),
          reason,
        );
      });
    });
  }

  it("accepts a lowercase canonical Content-Type header", async () => {
    await withInstalledAiHarness(
      { lowercaseContentTypeHeader: true },
      async ({ client, root, route }) => {
        const result = await collectInstalledAiTryOnAttempt({
          client,
          expectedTryOnRoute: route,
          regionalEvidenceRoot: root,
          timeoutMs: 100,
          pollMs: 2,
        });
        assert.equal(result.resultEvidence.network.contentType, "image/png");
      },
    );
  });

  it("binds the acquisition screenshot to the attempt returned by the readiness waiter", async () => {
    await withInstalledAiHarness({}, async ({ client, root, route }) => {
      const captures = [];
      const result = await collectInstalledAiTryOnAttempt({
        client,
        expectedTryOnRoute: route,
        regionalEvidenceRoot: root,
        timeoutMs: 100,
        pollMs: 2,
        captureAttemptScreenshot: async ({ attemptId, stage }) => {
          captures.push({ attemptId, stage });
          return {
            byteLength: 1,
            path: `${stage}.png`,
            sha256: "a".repeat(64),
            stage,
          };
        },
      });
      assert.deepEqual(captures, [
        { attemptId: result.attemptId, stage: "acquisition" },
        { attemptId: result.attemptId, stage: "result" },
      ]);
    });
  });

  it("bounds a slow Network response by the single capture deadline and removes handlers", async () => {
    const started = performance.now();
    await withInstalledAiHarness(
      { slowResponseMs: 150 },
      async ({ client, root, route }) => {
        await assert.rejects(
          collectInstalledAiTryOnAttempt({
            client,
            expectedTryOnRoute: route,
            regionalEvidenceRoot: root,
            timeoutMs: 50,
            pollMs: 2,
          }),
          /timed out|did not become true/,
        );
        for (const method of [
          "Network.responseReceived",
          "Network.loadingFinished",
          "Network.loadingFailed",
          "Network.requestWillBeSent",
          "Network.requestServedFromCache",
        ])
          assert.equal(client.eventHandlers.get(method)?.length ?? 0, 0);
      },
    );
    assert.equal(performance.now() - started < 140, true);
  });

  it("times out without a matching regional sidecar", async () => {
    await withInstalledAiHarness(
      { sidecarAttemptId: null },
      async ({ client, root, route }) => {
        await assert.rejects(
          collectInstalledAiTryOnAttempt({
            client,
            expectedTryOnRoute: route,
            regionalEvidenceRoot: root,
            timeoutMs: 50,
            pollMs: 2,
          }),
          /did not become true|timed out/,
        );
      },
    );
  });

  it("accepts the page response through CDP Network when the cross-origin DOM canvas is tainted", async () => {
    await withInstalledAiHarness(
      { canvasSecurityError: true },
      async ({ client, root, route }) => {
        const result = await collectInstalledAiTryOnAttempt({
          client,
          expectedTryOnRoute: route,
          regionalEvidenceRoot: root,
          timeoutMs: 100,
          pollMs: 2,
        });
        assert.equal(result.resultEvidence.httpStatus, 200);
      },
    );
  });

  for (const [label, mutate] of [
    [
      "member atomic replacement after identity check",
      ({ path }) => {
        const replacement = `${path}.replacement`;
        writeFileSync(replacement, '{"replacement":true}\n');
        renameSync(replacement, path);
      },
    ],
    [
      "member in-place rewrite after read",
      ({ path }) => writeFileSync(path, '{"rewritten":true}\n'),
    ],
    [
      "member atomic replacement before final return",
      ({ path }) => {
        const replacement = `${path}.replacement`;
        writeFileSync(replacement, '{"late":true}\n');
        renameSync(replacement, path);
      },
    ],
  ]) {
    it(`rejects ${label} in regional evidence collection`, async () => {
      const prior = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      try {
        await withInstalledAiHarness({}, async ({ client, root, route }) => {
          const hookName = label.includes("identity check")
            ? "afterIdentityCheck"
            : label.includes("after read")
              ? "afterRead"
              : "beforeReturn";
          await assert.rejects(
            collectInstalledAiTryOnAttemptForTest(
              {
                client,
                expectedTryOnRoute: route,
                regionalEvidenceRoot: root,
                timeoutMs: 100,
                pollMs: 2,
              },
              { [hookName]: mutate },
            ),
            /regional evidence.*changed|identity/,
          );
        });
      } finally {
        if (prior == null) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
    });
  }

  for (const [label, hookName, mutate] of [
    [
      "member in-place rewrite after identity check",
      "afterIdentityCheck",
      ({ path }) => writeFileSync(path, '{"earlyRewrite":true}\n'),
    ],
    [
      "member atomic replacement after read",
      "afterRead",
      ({ path }) => {
        const replacement = `${path}.after-read`;
        writeFileSync(replacement, '{"afterRead":true}\n');
        renameSync(replacement, path);
      },
    ],
    [
      "member in-place rewrite before final return",
      "beforeReturn",
      ({ path }) => writeFileSync(path, '{"lateRewrite":true}\n'),
    ],
  ]) {
    it(`rejects ${label} in regional evidence collection`, async () => {
      const prior = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      try {
        await withInstalledAiHarness({}, async ({ client, root, route }) => {
          await assert.rejects(
            collectInstalledAiTryOnAttemptForTest(
              {
                client,
                expectedTryOnRoute: route,
                regionalEvidenceRoot: root,
                timeoutMs: 100,
                pollMs: 2,
              },
              { [hookName]: mutate },
            ),
            /regional evidence.*changed|identity/,
          );
        });
      } finally {
        if (prior == null) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
    });
  }

  it("rejects regional root atomic replacement before final return", async () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    let movedRoot = null;
    try {
      await withInstalledAiHarness({}, async ({ client, root, route }) => {
        movedRoot = `${root}.moved`;
        await assert.rejects(
          collectInstalledAiTryOnAttemptForTest(
            {
              client,
              expectedTryOnRoute: route,
              regionalEvidenceRoot: root,
              timeoutMs: 100,
              pollMs: 2,
            },
            {
              beforeReturn() {
                renameSync(root, movedRoot);
                mkdirSync(root);
              },
            },
          ),
          /regional evidence.*changed|identity|ENOENT/,
        );
      });
    } finally {
      if (movedRoot) rmSync(movedRoot, { recursive: true, force: true });
      if (prior == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("executes the production Machine Vitest lifecycle authority", async () => {
    const result = await runMachineVisionAuthority();
    assert.equal(result.exitCode, 0, result.stderr);
  });

  it("executes fixture tests and rejects every non-passing Vitest status", async () => {
    const passing = await runMachineVisionAuthority("--fixture", "passed");
    assert.equal(passing.exitCode, 0, passing.stderr);

    for (const fixture of ["skipped", "failed", "pending", "todo"]) {
      const result = await runMachineVisionAuthority("--fixture", fixture);
      assert.notEqual(
        result.exitCode,
        0,
        `${fixture} fixture must fail the authority guard`,
      );
      assert.match(result.stderr, new RegExp(fixture));
    }
  });

  it("rejects an additional requested suite that Vitest silently omits", async () => {
    const missing = "src/does-not-exist.spec.ts";
    const result = await runMachineVisionAuthority(
      "--spec",
      "src/native/vision.spec.ts",
      "--spec",
      missing,
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /missing suites/i);
    assert.match(result.stderr, /apps\/machine\/src\/does-not-exist\.spec\.ts/);
  });

  it("binds CLI routes and selectors to the current Machine customer contract", () => {
    const machineRoot = new URL("../../apps/machine/src/", import.meta.url);
    const routes = readFileSync(
      new URL("router/routes.ts", machineRoot),
      "utf8",
    );
    const productDetail = readFileSync(
      new URL("views/ProductDetailView.vue", machineRoot),
      "utf8",
    );
    const tryOnView = readFileSync(
      new URL("views/TryOnView.vue", machineRoot),
      "utf8",
    );

    assert.match(
      routes,
      /path:\s*["']\/try-on["'][\s\S]*name:\s*["']try-on["']/,
    );
    assert.match(
      productDetail,
      /data-test="try-on-fast"[\s\S]*@click="startFastTryOn"/,
    );
    assert.match(
      productDetail,
      /name:\s*"try-on"[\s\S]*query:\s*\{[\s\S]*catalogKey:[\s\S]*variantId:/,
    );
    for (const selector of [
      "try-on-view",
      "try-on-acquisition-preview",
      "try-on-manual-capture",
      "try-on-cancel",
      "try-on-result-image",
      "try-on-retry",
      "try-on-return",
    ]) {
      assert.match(tryOnView, new RegExp(`data-test="${selector}"`));
    }
    assert.match(tryOnView, /:data-state="tryOn\.phase"/);
    assert.match(tryOnView, /:src="tryOn\.previewUrl"/);
    assert.doesNotMatch(
      tryOnView,
      /<canvas\b|fetch\(|getUserMedia|captureStream/,
    );
  });

  function installedBindingObservation(processIds, listenerProcessIds) {
    return {
      canonicalProcesses: processIds.map((processId) => ({
        processId,
        parentProcessId: 100,
        creationDate: "20260722120000.000000+000",
        commandLine: `C:\\VEM\\vision\\app\\vending-vision.exe --pid ${processId}`,
      })),
      listeners: listenerProcessIds.map((owningProcess) => ({
        localAddress: "127.0.0.1",
        localPort: 7892,
        owningProcess,
      })),
      task: { path: "\\", name: "VEMVisionRuntime", state: "Running" },
    };
  }

  function installedBindingWithWorkerChildren({
    workerParentProcessId = 7012,
    workerCommandLine = "C:\\VEM\\vision\\app\\vending-vision.exe --multiprocessing-fork",
    listenerProcessIds = [7012],
    sibling = null,
  } = {}) {
    const main = {
      processId: 7012,
      parentProcessId: 100,
      creationDate: "20260722120000.000000+000",
      executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
      commandLine:
        "C:\\VEM\\vision\\app\\vending-vision.exe --config C:\\ProgramData\\VEM\\vision\\site.json",
    };
    const workers = [7013, 7014].map((processId) => ({
      processId,
      parentProcessId: workerParentProcessId,
      creationDate: "20260722120000.000000+000",
      executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
      commandLine: workerCommandLine,
    }));
    return {
      canonicalProcesses: [main, ...workers, ...(sibling ? [sibling] : [])],
      listeners: listenerProcessIds.map((owningProcess) => ({
        localAddress: "127.0.0.1",
        localPort: 7892,
        owningProcess,
      })),
      task: { path: "\\", name: "VEMVisionRuntime", state: "Running" },
    };
  }

  async function pollInstalledBinding(observations, timeoutMs = 8_000) {
    let index = 0;
    let clock = 0;
    return waitForVisionInstalledBindingObservation({
      collectObservation: async () =>
        observations[Math.min(index++, observations.length - 1)],
      timeoutMs,
      pollMs: 250,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
  }

  it("waits through 0->2->1 canonical Vision processes before accepting the listener owner", async () => {
    const binding = await pollInstalledBinding([
      installedBindingObservation([], []),
      installedBindingObservation([4201, 4202], [4201]),
      installedBindingObservation([4202], [4202]),
    ]);
    assert.equal(binding.canonicalProcesses[0].processId, 4202);
    assert.equal(binding.listeners[0].owningProcess, 4202);
  });

  it("accepts the current Vision main with direct multiprocessing worker children", async () => {
    const binding = await pollInstalledBinding([
      installedBindingWithWorkerChildren(),
    ]);
    assert.equal(binding.listeners[0].owningProcess, 7012);
    assert.deepEqual(
      binding.canonicalProcesses.map((process) => process.processId),
      [7012, 7013, 7014],
    );
  });

  it("carries the listener main and direct worker children from collector into the validator", () => {
    const observation = installedBindingWithWorkerChildren();
    observation.processOwner = "VEMKiosk";
    observation.task = {
      path: "\\",
      name: "VEMVisionRuntime",
      state: "Running",
      user: "DOM\\VEMKiosk",
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      arguments:
        '-NoProfile -ExecutionPolicy Bypass -File "C:\\VEM\\bringup\\launch-vem-vision.ps1"',
      workingDirectory: "C:\\VEM\\vision\\app",
    };
    const runtimeBinding = buildVisionInstalledRuntimeBinding(observation);
    assert.equal(runtimeBinding.processId, 7012);
    assert.deepEqual(runtimeBinding.visionProcessIds, [7012, 7013, 7014]);
    assert.equal(
      runtimeBinding.visionProcessCommandLines[0],
      observation.canonicalProcesses[0].commandLine,
    );
  });

  for (const [label, observation] of [
    [
      "an unknown canonical sibling",
      installedBindingWithWorkerChildren({
        sibling: {
          processId: 7015,
          parentProcessId: 100,
          creationDate: "20260722120000.000000+000",
          commandLine:
            "C:\\VEM\\vision\\app\\vending-vision.exe --other-instance",
        },
      }),
    ],
    [
      "a worker with another parent",
      installedBindingWithWorkerChildren({ workerParentProcessId: 7000 }),
    ],
    [
      "a child without the multiprocessing token",
      installedBindingWithWorkerChildren({
        workerCommandLine: "C:\\VEM\\vision\\app\\vending-vision.exe --child",
      }),
    ],
    [
      "multiple loopback listeners",
      installedBindingWithWorkerChildren({ listenerProcessIds: [7012, 7013] }),
    ],
    [
      "a duplicate canonical PID",
      installedBindingWithWorkerChildren({
        sibling: {
          processId: 7013,
          parentProcessId: 7012,
          creationDate: "20260722120000.000000+000",
          executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
          commandLine:
            "C:\\VEM\\vision\\app\\vending-vision.exe --multiprocessing-fork",
        },
      }),
    ],
  ]) {
    it(`rejects ${label} around the installed Vision main`, async () => {
      await assert.rejects(
        pollInstalledBinding([observation], 750),
        /Vision installed binding did not stabilize/,
      );
    });
  }

  it("binds installed acceptance only to the current root Vision runtime task", () => {
    const source = readFileSync(
      new URL("./vision-try-on-acceptance.mjs", import.meta.url),
      "utf8",
    );
    const collectBinding = source.slice(
      source.indexOf("async function collectVisionInstalledBinding()"),
      source.indexOf("async function stopVisionRuntime()"),
    );
    assert.match(source, /const VISION_TASK_PATH = "\\\\"/);
    assert.match(source, /const VISION_TASK_NAME = "VEMVisionRuntime"/);
    assert.match(
      collectBinding,
      /Get-ScheduledTask -TaskName '\$\{VISION_TASK_NAME\}' -TaskPath '\$\{VISION_TASK_PATH\}'/,
    );
    assert.match(
      collectBinding,
      /\$mainProcess = @\(\$visionProcesses \| Where-Object \{ \[int\]\$_\.processId -eq \[int\]\$listenerDetails\[0\]\.owningProcess \}\)/,
    );
    assert.match(
      collectBinding,
      /\$ownerProcesses = @\(Get-CimInstance Win32_Process -Filter "ProcessId = \$\(\$mainProcess\[0\]\.processId\)" -ErrorAction Stop\)/,
    );
    assert.match(
      collectBinding,
      /ownerProcesses\[0\]\.CreationDate[\s\S]*ownerProcesses\[0\]\.ExecutablePath[\s\S]*Invoke-CimMethod -InputObject \$ownerProcesses\[0\]/,
    );
    assert.doesNotMatch(collectBinding, /StartVisionServer/);
  });

  it("times out with process, listener, and task diagnostics when two canonical Vision processes persist", async () => {
    await assert.rejects(
      pollInstalledBinding(
        [installedBindingObservation([4201, 4202], [4201])],
        750,
      ),
      /count=\{canonical:2,listener:1\}[\s\S]*PID=4201[\s\S]*ParentProcessId=100[\s\S]*CreationDate=[\s\S]*CommandLine=[\s\S]*listener=[\s\S]*task=/,
    );
  });

  it("times out when an extra non-listening canonical Vision instance remains", async () => {
    await assert.rejects(
      pollInstalledBinding(
        [installedBindingObservation([4201, 4202], [4202])],
        750,
      ),
      /Vision installed binding did not stabilize/,
    );
  });

  it("waits for managed Vision tasks and processes to stop before restarting it", () => {
    const source = readFileSync(
      new URL("./vision-try-on-acceptance.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /const POWERSHELL_EXECUTABLE =[\s\S]*process\.platform === "win32"[\s\S]*"powershell\.exe"[\s\S]*process\.env\.PWSH \?\? "pwsh"/,
    );
    assert.doesNotMatch(source, /spawn\("pwsh"/);
    assert.match(
      source,
      /MANAGED_VISION_TASK_NAMES = \["VEMVisionRuntime", "StartVisionServer"\]/,
    );
    assert.match(
      source,
      /\$tasks = @\(Get-ScheduledTask[\s\S]*TaskName -in \$managedTaskNames/,
    );
    assert.match(
      source,
      /while \(\[DateTime\]::UtcNow -lt \$deadline\)[\s\S]*\$runningTasks = @\(Get-ScheduledTask[\s\S]*\$remaining = @\(& \$getOwnedVisionProcessIds\)[\s\S]*\$runningTasks\.Count -eq 0 -and \$remaining\.Count -eq 0/,
    );
    assert.match(
      source,
      /task\.State -eq 'Running'\) \{ throw 'Vision scheduled task is still running before start'/,
    );
    assert.match(
      source,
      /`\$canonicalExecutablePath = \[IO\.Path\]::GetFullPath\('\$\{VISION_ENTRYPOINT_PATH\}'\)`/,
    );
    assert.match(
      source,
      /try \{ & taskkill\.exe \/PID \(\[int\]\$processId\) \/T \/F \*>\s*\$null \} catch \{ \}/,
    );
    assert.match(source, /runPowerShell\(command, "stopping Vision runtime"\)/);
    assert.match(source, /runPowerShell\(command, "starting Vision runtime"\)/);
  });

  it("proves matched, manual, online-unmatched, and unavailable recommendation states", () => {
    const source = readFileSync(
      new URL("./vision-try-on-acceptance.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /startVisionMockScenario\("success"\)/);
    assert.doesNotMatch(source, /recommendation_unmatched/);
    assert.match(
      source,
      /observe-fenced-recorded-video-chronology-in-machine-catalog/,
    );
    assert.match(source, /collectVisionProtocolEvidence\([\s\S]*eventFence/);
    assert.match(source, /profileEventId: \(\) => observedProfileEventId/);
    assert.match(source, /state\?\.profileEventId === catalogProfileEventId/);
    assert.match(
      source,
      /"online_unmatched"[\s\S]*onlineUnmatchedProduct\.variantId/,
    );
    assert.match(
      source,
      /runFastTryOnOwnerAttempts\(\{[\s\S]*retry-completed-try-on[\s\S]*collectRetry: skipVisionRecommendation[\s\S]*excludeAttemptId: initial\.tryOnSurface\.attemptId/,
    );
    assert.match(
      source,
      /selectedProduct: \{[\s\S]*manualSelectedProduct\.catalogKey[\s\S]*manualSelectedProduct\.variantId/,
    );
    assert.match(
      source,
      /if \(!skipVisionRecommendation\) \{[\s\S]*degradedDaemon = await waitForVisionDegradation[\s\S]*waitForRecommendationPresentation\([\s\S]*"vision_unavailable"[\s\S]*ordinaryVariantId/,
    );
    for (const label of [
      "automatic-recommendation-detail",
      "manual-size-detail",
      "online-unmatched-recommendation-detail",
      "vision-degraded-product",
    ]) {
      assert.match(source, new RegExp(`"${label}"[\\s\\S]*validatePng: true`));
    }
  });

  it("wires the explicit VM Fast core scope around recommendation-only work", () => {
    const source = readFileSync(
      new URL("./vision-try-on-acceptance.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /const skipVisionRecommendation = isVmFastCoreVisionRecommendationSkip\(\);[\s\S]*if \(skipVisionRecommendation\) \{[\s\S]*open-vm-fast-core-seeded-product[\s\S]*catalog-category[\s\S]*catalog-product[\s\S]*select-vm-fast-core-alternate-variant[\s\S]*product-size-option/,
    );
    assert.match(
      source,
      /\} else \{[\s\S]*clear-existing-vision-before-recommendation-baseline[\s\S]*start-installed-vision-fixture-source[\s\S]*observe-fenced-recorded-video-chronology-in-machine-catalog[\s\S]*validate-automatic-recommendation-presentation[\s\S]*validate-online-unmatched-recommendation-presentation/,
    );
    assert.match(
      source,
      /if \(!skipVisionRecommendation\) \{[\s\S]*stop-real-vision-runtime[\s\S]*validate-vision-unavailable-recommendation-presentation/,
    );
    assert.match(
      source,
      /runFastTryOnOwnerAttempts\(\{[\s\S]*retry-completed-try-on[\s\S]*collectRetry: skipVisionRecommendation[\s\S]*\}\);[\s\S]*stage = "return-from-try-on"[\s\S]*try-on-return[\s\S]*prove-ordinary-checkout-after-try-on[\s\S]*product-buy/,
    );
    assert.match(
      source,
      /acceptanceScope: \{ visionRecommendation: recommendationScope \}/,
    );
  });

  it("waits for product-owned media through the shared condition contract", () => {
    const source = readFileSync(
      new URL("./vision-try-on-acceptance.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /product-owned media card \$\{expected\.catalogKey\}[\s\S]*return \{\s+ok:[\s\S]*state\.complete === true[\s\S]*value: state,[\s\S]*\};[\s\S]*60_000,[\s\S]*250,/,
    );
    assert.doesNotMatch(
      source,
      /product-owned media card \$\{expected\.catalogKey\}[\s\S]*\(state\) =>[\s\S]*state\.naturalWidth >= 64/,
    );
  });

  it("accepts only full mode with absolute Windows inputs", () => {
    assert.deepEqual(
      parseVisionTryOnAcceptanceArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        "--handoff",
        "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
        "--out",
        "C:\\ProgramData\\VEM\\testbed\\vision-try-on-acceptance.json",
        "--fixture-key",
        "visionExperience",
      ]),
      {
        mode: "full",
        guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        handoffPath:
          "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
        outPath: "C:\\ProgramData\\VEM\\testbed\\vision-try-on-acceptance.json",
        fixtureKey: "visionExperience",
      },
    );
    assert.throws(
      () =>
        parseVisionTryOnAcceptanceArgs([
          "--mode",
          "fast",
          "--guest-input",
          "C:\\guest.json",
          "--handoff",
          "C:\\handoff.json",
          "--out",
          "C:\\out.json",
        ]),
      /--mode must be full/,
    );
  });

  it("builds recorded-video configuration for the installed Tauri origin", () => {
    const config = buildRecordedVisionSiteConfiguration();
    assert.equal(config.schemaVersion, "vending-vision-site-config/v1");
    assert.deepEqual(config.allowed_origins, [
      "http://tauri.localhost",
      "http://127.0.0.1:7892",
    ]);
    assert.deepEqual(config.cameras.top, {
      source: "recorded_video",
      role: "presence",
      video_path: "recorded-video/top.mp4",
      loop: true,
    });
    assert.deepEqual(config.cameras.front, {
      source: "recorded_video",
      role: "profile_fast_try_on",
      video_path: "recorded-video/front.mp4",
      loop: true,
    });
  });

  it("validates compact health and machine-protocol evidence", () => {
    const summary = validateVisionProtocolEvidence({
      health: {
        status: "ok",
        protocol: VISION_V2_IDENTITY.protocol,
        cameraReady: true,
        frameSource: frameSourceBinding(),
      },
      ready: {
        protocol: VISION_V2_IDENTITY.protocol,
        type: "vision.ready",
        messageId: "ready-1",
        timestamp: "2026-07-18T00:00:00.000Z",
        payload: {
          serverName: "vem-vision-runtime",
          serverVersion: "1.2.3",
          schemaVersion: VISION_V2_IDENTITY.schemaVersion,
          bundleVersion: VISION_V2_IDENTITY.bundleVersion,
          contractDigest: VISION_V2_IDENTITY.contractDigest,
          fastReady: true,
          aiReady: false,
          aiReadinessDiagnostic: "model_pack_missing",
          visionBusinessReady: true,
          businessReadinessDiagnostic: "ready",
          cameraReady: true,
          capabilities: [
            "profile_push",
            "presence_status",
            "person_departed",
            "try_on_fast",
          ],
          frameSource: frameSourceBinding(),
        },
      },
      presence: {
        type: "vision.presence_status",
        payload: {
          source: "top",
          detectedAt: "2026-07-18T00:00:01.000Z",
          personPresent: true,
          sourceFrame: sourceFrame("top", "b".repeat(64)),
        },
      },
      profile: {
        type: "vision.profile_result",
        payload: {
          source: "front",
          detectedAt: "2026-07-18T00:00:02.000Z",
          profile: { personPresent: true },
          quality: { profileUsable: true },
          sourceFrame: sourceFrame("front", "c".repeat(64), {
            frameIndex: 8,
            decodedFrameCount: 9,
          }),
        },
      },
      departure: {
        type: "vision.person_departed",
        payload: {
          source: "top",
          detectedAt: "2026-07-18T00:00:03.000Z",
          sourceFrame: sourceFrame("top", "b".repeat(64), {
            frameIndex: 12,
            decodedFrameCount: 13,
          }),
        },
      },
    });
    assert.equal(summary.healthStatus, "ok");
    assert.equal(summary.readyServerName, "vem-vision-runtime");
    assert.equal(summary.readyServerVersion, "1.2.3");
    assert.deepEqual(summary.frameSourceBinding, frameSourceBinding());
    assert.equal(summary.profileUsable, true);
    assert.throws(
      () =>
        validateVisionProtocolEvidence({
          health: {
            status: "offline",
            protocol: VISION_V2_IDENTITY.protocol,
            cameraReady: true,
            frameSource: frameSourceBinding(),
          },
          ready: {},
          presence: {},
          profile: {},
          departure: {},
        }),
      /vision health evidence is invalid/,
    );
    assert.throws(
      () =>
        validateVisionProtocolEvidence({
          health: {
            status: "ok",
            protocol: VISION_V2_IDENTITY.protocol,
            cameraReady: true,
            frameSource: frameSourceBinding(),
          },
          ready: {
            protocol: VISION_V2_IDENTITY.protocol,
            type: "vision.ready",
            messageId: "ready-1",
            timestamp: "2026-07-18T00:00:00.000Z",
            payload: {
              serverName: "vem-vision-runtime",
              serverVersion: "1.2.3",
              schemaVersion: VISION_V2_IDENTITY.schemaVersion,
              bundleVersion: VISION_V2_IDENTITY.bundleVersion,
              contractDigest: VISION_V2_IDENTITY.contractDigest,
              fastReady: true,
              aiReady: false,
              aiReadinessDiagnostic: "model_pack_missing",
              visionBusinessReady: true,
              businessReadinessDiagnostic: "ready",
              schemaVersion: VISION_V2_IDENTITY.schemaVersion,
              bundleVersion: VISION_V2_IDENTITY.bundleVersion,
              contractDigest: VISION_V2_IDENTITY.contractDigest,
              fastReady: true,
              aiReady: false,
              aiReadinessDiagnostic: "model_pack_missing",
              visionBusinessReady: true,
              businessReadinessDiagnostic: "ready",
              cameraReady: true,
              capabilities: [
                "profile_push",
                "presence_status",
                "person_departed",
                "try_on_fast",
              ],
              frameSource: frameSourceBinding(),
            },
          },
          presence: {
            type: "vision.presence_status",
            payload: {
              detectedAt: "2026-07-18T00:00:01.000Z",
              personPresent: true,
              sourceFrame: sourceFrame("top", "b".repeat(64)),
            },
          },
          profile: {
            type: "vision.profile_result",
            payload: {
              source: "front",
              detectedAt: "2026-07-18T00:00:02.000Z",
              profile: { personPresent: true },
              quality: {},
              sourceFrame: sourceFrame("front", "c".repeat(64)),
            },
          },
          departure: {
            type: "vision.person_departed",
            payload: {
              source: "top",
              detectedAt: "2026-07-18T00:00:03.000Z",
              sourceFrame: sourceFrame("top", "b".repeat(64), {
                frameIndex: 6,
                decodedFrameCount: 7,
              }),
            },
          },
        }),
      /vision profile evidence is invalid/,
    );
  });

  it("accepts missing frameSource when installed binding is supplied", () => {
    const binding = frameSourceBinding();
    const summary = validateVisionProtocolEvidence(
      {
        health: {
          status: "ok",
          protocol: VISION_V2_IDENTITY.protocol,
          cameraReady: true,
        },
        ready: {
          protocol: VISION_V2_IDENTITY.protocol,
          type: "vision.ready",
          messageId: "ready-1",
          timestamp: "2026-07-18T00:00:00.000Z",
          payload: {
            serverName: "vem-vision-runtime",
            serverVersion: "1.2.3",
            schemaVersion: VISION_V2_IDENTITY.schemaVersion,
            bundleVersion: VISION_V2_IDENTITY.bundleVersion,
            contractDigest: VISION_V2_IDENTITY.contractDigest,
            fastReady: true,
            aiReady: false,
            aiReadinessDiagnostic: "model_pack_missing",
            visionBusinessReady: true,
            businessReadinessDiagnostic: "ready",
            schemaVersion: VISION_V2_IDENTITY.schemaVersion,
            bundleVersion: VISION_V2_IDENTITY.bundleVersion,
            contractDigest: VISION_V2_IDENTITY.contractDigest,
            fastReady: true,
            aiReady: false,
            aiReadinessDiagnostic: "model_pack_missing",
            visionBusinessReady: true,
            businessReadinessDiagnostic: "ready",
            cameraReady: true,
            capabilities: [
              "profile_push",
              "presence_status",
              "person_departed",
              "try_on_fast",
            ],
          },
        },
        presence: {
          type: "vision.presence_status",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:01.000Z",
            personPresent: true,
            sourceFrame: sourceFrame("top", "b".repeat(64)),
          },
        },
        profile: {
          type: "vision.profile_result",
          payload: {
            source: "front",
            detectedAt: "2026-07-18T00:00:02.000Z",
            profile: { personPresent: true },
            quality: { profileUsable: true },
            sourceFrame: sourceFrame("front", "c".repeat(64), {
              frameIndex: 8,
              decodedFrameCount: 9,
            }),
          },
        },
        departure: {
          type: "vision.person_departed",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:03.000Z",
            sourceFrame: sourceFrame("top", "b".repeat(64), {
              frameIndex: 12,
              decodedFrameCount: 13,
            }),
          },
        },
      },
      { frameSourceBinding: binding },
    );
    assert.deepEqual(summary.frameSourceBinding, binding);
  });

  it("fails when neither health/ready nor installed binding provides frameSource", () => {
    assert.throws(
      () =>
        validateVisionProtocolEvidence({
          health: {
            status: "ok",
            protocol: VISION_V2_IDENTITY.protocol,
            cameraReady: true,
          },
          ready: {
            protocol: VISION_V2_IDENTITY.protocol,
            type: "vision.ready",
            messageId: "ready-1",
            timestamp: "2026-07-18T00:00:00.000Z",
            payload: {
              serverName: "vem-vision-runtime",
              serverVersion: "1.2.3",
              cameraReady: true,
              capabilities: [
                "profile_push",
                "presence_status",
                "person_departed",
                "try_on_fast",
              ],
            },
          },
          presence: {
            type: "vision.presence_status",
            payload: {
              source: "top",
              detectedAt: "2026-07-18T00:00:01.000Z",
              personPresent: true,
              sourceFrame: sourceFrame("top", "b".repeat(64)),
            },
          },
          profile: {
            type: "vision.profile_result",
            payload: {
              source: "front",
              detectedAt: "2026-07-18T00:00:02.000Z",
              profile: { personPresent: true },
              quality: { profileUsable: true },
              sourceFrame: sourceFrame("front", "c".repeat(64), {
                frameIndex: 8,
                decodedFrameCount: 9,
              }),
            },
          },
          departure: {
            type: "vision.person_departed",
            payload: {
              source: "top",
              detectedAt: "2026-07-18T00:00:03.000Z",
              sourceFrame: sourceFrame("top", "b".repeat(64), {
                frameIndex: 12,
                decodedFrameCount: 13,
              }),
            },
          },
        }),
      /Vision frame-source binding is unavailable for protocol evidence/,
    );
  });

  it("normalizes fixture protocol semantics separately from seeded runtime identity", () => {
    const normalized = normalizeVisionExpectedResults(baseExpectedResults());
    assert.equal(normalized.protocol.profile.source, "front");
    assert.equal(normalized.recommendation.selectedVariantId, null);
    assert.equal(normalized.recommendation.orderedCatalogKeys, null);
    assert.equal(
      normalized.tryOn.resultPathPrefix,
      "http://127.0.0.1:7892/v2/try-on/results/",
    );
    assert.deepEqual(
      normalizeSeededVisionAcceptance({
        selectedVariantId: "variant-seeded",
        tryOnGarmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
        tryOnGarmentReadyUrl:
          "http://127.0.0.1:26849/media/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?grant=garment",
        recommendationVariants: [],
        seededTryOnVariants: [
          {
            sourceRow: 31,
            productId: "product-seeded",
            variantId: "variant-seeded",
            sku: "TSC-LOCAL-031",
            size: "M",
            garmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
            garmentReadyUrl:
              "http://127.0.0.1:26849/media/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?grant=garment",
            garmentDigest: null,
            garmentTemplate: null,
          },
        ],
      }),
      {
        tryOnCategoryKey: null,
        selectedCatalogKey: null,
        selectedVariantId: "variant-seeded",
        tryOnGarmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
        tryOnGarmentReadyUrl:
          "http://127.0.0.1:26849/media/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?grant=garment",
        recommendationVariants: [],
        seededTryOnVariants: [
          {
            sourceRow: 31,
            productId: "product-seeded",
            variantId: "variant-seeded",
            sku: "TSC-LOCAL-031",
            size: "M",
            garmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
            garmentReadyUrl:
              "http://127.0.0.1:26849/media/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?grant=garment",
            garmentDigest: null,
            garmentTemplate: null,
          },
        ],
        productMedia: [],
      },
    );
    assert.deepEqual(
      validateSeededRecommendationVariants({
        selectedCatalogKey: "product:product-seeded",
        selectedVariantId: "variant-s",
        recommendationVariants: [
          {
            productId: "product-seeded",
            variantId: "variant-s",
            sku: "TSC-LOCAL-032-VISION-S",
            size: "S",
            slotId: "slot-s",
            inventoryId: "inventory-s",
            onHandQty: 3,
          },
          {
            productId: "product-seeded",
            variantId: "variant-m",
            sku: "TSC-LOCAL-032-VISION-M",
            size: "M",
            slotId: "slot-m",
            inventoryId: "inventory-m",
            onHandQty: 3,
          },
        ],
      }),
      {
        matched: {
          productId: "product-seeded",
          variantId: "variant-s",
          sku: "TSC-LOCAL-032-VISION-S",
          size: "S",
          slotId: "slot-s",
          inventoryId: "inventory-s",
          onHandQty: 3,
        },
        alternate: {
          productId: "product-seeded",
          variantId: "variant-m",
          sku: "TSC-LOCAL-032-VISION-M",
          size: "M",
          slotId: "slot-m",
          inventoryId: "inventory-m",
          onHandQty: 3,
        },
      },
    );
    assert.throws(
      () =>
        normalizeVisionExpectedResults({
          protocol: {},
          recommendation: {},
          tryOn: {},
        }),
      /presence expected result/,
    );
  });

  it("consumes the current Vision repository recorded-video fixture contract", () => {
    const normalized = normalizeVisionExpectedResults({
      schemaVersion: "vending-vision-recorded-video-fixture/v1",
      recordings: {
        top: { file: "top.mp4", sha256: "a".repeat(64), loop: false },
        front: { file: "front.mp4", sha256: "b".repeat(64), loop: true },
      },
      expected: {
        top: {
          protocolEvents: ["vision.presence_status", "vision.person_departed"],
        },
        front: { tryOn: { jpeg: true } },
      },
    });

    assert.equal(normalized.protocol.presence.type, "vision.presence_status");
    assert.equal(normalized.protocol.profile.type, "vision.profile_result");
    assert.equal(normalized.protocol.departure.type, "vision.person_departed");
  });

  it("compares observed protocol evidence by event type and fresh runtime chronology", () => {
    const summary = compareObservedVisionProtocolToExpected({
      expectedResults: baseExpectedResults(),
      protocolEvidence: {
        health: {
          status: "ok",
          protocol: VISION_V2_IDENTITY.protocol,
          cameraReady: true,
          frameSource: frameSourceBinding(),
        },
        ready: {
          protocol: VISION_V2_IDENTITY.protocol,
          type: "vision.ready",
          messageId: "ready-1",
          timestamp: "2026-07-18T00:00:00.000Z",
          payload: {
            serverName: "vem-vision-runtime",
            serverVersion: "1.2.3",
            schemaVersion: VISION_V2_IDENTITY.schemaVersion,
            bundleVersion: VISION_V2_IDENTITY.bundleVersion,
            contractDigest: VISION_V2_IDENTITY.contractDigest,
            fastReady: true,
            aiReady: false,
            aiReadinessDiagnostic: "model_pack_missing",
            visionBusinessReady: true,
            businessReadinessDiagnostic: "ready",
            cameraReady: true,
            capabilities: [
              "profile_push",
              "presence_status",
              "person_departed",
              "try_on_fast",
            ],
            frameSource: frameSourceBinding(),
          },
        },
        observation: {
          startedAt: "2026-07-18T00:00:00.500Z",
          completedAt: "2026-07-18T00:00:04.000Z",
        },
        presence: {
          type: "vision.presence_status",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:01.000Z",
            personPresent: true,
            sourceFrame: sourceFrame("top", "b".repeat(64)),
          },
        },
        profile: {
          type: "vision.profile_result",
          payload: {
            source: "front",
            detectedAt: "2026-07-18T00:00:02.000Z",
            profile: { personPresent: true },
            quality: { profileUsable: true },
            sourceFrame: sourceFrame("front", "c".repeat(64), {
              frameIndex: 6,
              decodedFrameCount: 7,
            }),
          },
        },
        departure: {
          type: "vision.person_departed",
          payload: {
            source: "top",
            detectedAt: "2026-07-18T00:00:03.000Z",
            sourceFrame: sourceFrame("top", "b".repeat(64), {
              frameIndex: 8,
              decodedFrameCount: 9,
            }),
          },
        },
      },
      installedBinding: { frameSourceBinding: frameSourceBinding() },
    });
    assert.equal(summary.expectedSequence[1].source, "front");
    assert.equal(summary.observationCompletedAt, "2026-07-18T00:00:04.000Z");
    assert.throws(
      () =>
        compareObservedVisionProtocolToExpected({
          expectedResults: baseExpectedResults(),
          protocolEvidence: {
            health: {
              status: "ok",
              protocol: VISION_V2_IDENTITY.protocol,
              cameraReady: true,
              frameSource: frameSourceBinding(),
            },
            ready: {
              protocol: VISION_V2_IDENTITY.protocol,
              type: "vision.ready",
              messageId: "ready-1",
              timestamp: "2026-07-18T00:00:00.000Z",
              payload: {
                serverName: "vem-vision-runtime",
                serverVersion: "1.2.3",
                schemaVersion: VISION_V2_IDENTITY.schemaVersion,
                bundleVersion: VISION_V2_IDENTITY.bundleVersion,
                contractDigest: VISION_V2_IDENTITY.contractDigest,
                fastReady: true,
                aiReady: false,
                aiReadinessDiagnostic: "model_pack_missing",
                visionBusinessReady: true,
                businessReadinessDiagnostic: "ready",
                cameraReady: true,
                capabilities: [
                  "profile_push",
                  "presence_status",
                  "person_departed",
                  "try_on_fast",
                ],
                frameSource: frameSourceBinding(),
              },
            },
            observation: {
              startedAt: "2026-07-18T00:00:00.500Z",
              completedAt: "2026-07-18T00:00:04.000Z",
            },
            presence: {
              type: "vision.presence_status",
              payload: {
                detectedAt: "2026-07-18T00:00:01.000Z",
                personPresent: false,
                sourceFrame: sourceFrame("front", "c".repeat(64)),
              },
            },
            profile: {
              type: "vision.profile_result",
              payload: {
                source: "front",
                detectedAt: "2026-07-18T00:00:02.000Z",
                profile: { personPresent: true },
                quality: { profileUsable: true },
                sourceFrame: sourceFrame("front", "c".repeat(64), {
                  frameIndex: 4,
                  decodedFrameCount: 5,
                }),
              },
            },
            departure: {
              type: "vision.person_departed",
              payload: {
                source: "top",
                detectedAt: "2026-07-18T00:00:03.000Z",
                sourceFrame: sourceFrame("top", "b".repeat(64), {
                  frameIndex: 6,
                  decodedFrameCount: 7,
                }),
              },
            },
          },
        }),
      /vision presence evidence is invalid/,
    );
    assert.throws(
      () =>
        compareObservedVisionProtocolToExpected({
          expectedResults: baseExpectedResults(),
          protocolEvidence: {
            health: {
              status: "ok",
              protocol: VISION_V2_IDENTITY.protocol,
              cameraReady: true,
              frameSource: frameSourceBinding(),
            },
            ready: {
              protocol: VISION_V2_IDENTITY.protocol,
              type: "vision.ready",
              messageId: "ready-1",
              timestamp: "2026-07-18T00:00:00.000Z",
              payload: {
                serverName: "vem-vision-runtime",
                serverVersion: "1.2.3",
                schemaVersion: VISION_V2_IDENTITY.schemaVersion,
                bundleVersion: VISION_V2_IDENTITY.bundleVersion,
                contractDigest: VISION_V2_IDENTITY.contractDigest,
                fastReady: true,
                aiReady: false,
                aiReadinessDiagnostic: "model_pack_missing",
                visionBusinessReady: true,
                businessReadinessDiagnostic: "ready",
                cameraReady: true,
                capabilities: [
                  "profile_push",
                  "presence_status",
                  "person_departed",
                  "try_on_fast",
                ],
                frameSource: frameSourceBinding(),
              },
            },
            observation: {
              startedAt: "2026-07-18T00:00:00.500Z",
              completedAt: "2026-07-18T00:00:04.000Z",
            },
            presence: {
              type: "vision.presence_status",
              payload: {
                source: "top",
                detectedAt: "2025-07-18T00:00:01.000Z",
                personPresent: true,
                sourceFrame: sourceFrame("top", "b".repeat(64)),
              },
            },
            profile: {
              type: "vision.profile_result",
              payload: {
                source: "front",
                detectedAt: "2025-07-18T00:00:02.000Z",
                profile: { personPresent: true },
                quality: { profileUsable: true },
                sourceFrame: sourceFrame("front", "c".repeat(64), {
                  frameIndex: 4,
                  decodedFrameCount: 5,
                }),
              },
            },
            departure: {
              type: "vision.person_departed",
              payload: {
                source: "top",
                detectedAt: "2025-07-18T00:00:03.000Z",
                sourceFrame: sourceFrame("top", "b".repeat(64), {
                  frameIndex: 6,
                  decodedFrameCount: 7,
                }),
              },
            },
          },
        }),
      /does not look fresh/,
    );
  });

  it("rejects protocol events from before the Vision runtime event fence or another runtime generation", () => {
    const eventFence = createVisionEventFence({
      runtimeTraceSnapshot: {
        runtimeGenerationId: "runtime:vision-fence-1",
        entries: [{ id: 18 }],
      },
      visionStartedAt: "2026-07-18T00:00:00.500Z",
    });
    const protocolEvidence = {
      ready: { type: "vision.ready", timestamp: "2026-07-18T00:00:01.000Z" },
      presence: {
        type: "vision.presence_status",
        payload: { detectedAt: "2026-07-18T00:00:02.000Z" },
      },
      profile: {
        type: "vision.profile_result",
        payload: { detectedAt: "2026-07-18T00:00:03.000Z" },
      },
      departure: {
        type: "vision.person_departed",
        payload: { detectedAt: "2026-07-18T00:00:04.000Z" },
      },
    };
    assert.equal(
      validateVisionEventFence({
        eventFence,
        protocolEvidence,
        runtimeTraceSnapshot: {
          runtimeGenerationId: "runtime:vision-fence-1",
          entries: [{ id: 19 }],
        },
      }).lastEntryId,
      18,
    );
    assert.throws(
      () =>
        validateVisionEventFence({
          eventFence,
          protocolEvidence: {
            ...protocolEvidence,
            profile: {
              type: "vision.profile_result",
              payload: { detectedAt: "2026-07-18T00:00:00.499Z" },
            },
          },
          runtimeTraceSnapshot: {
            runtimeGenerationId: "runtime:vision-fence-1",
            entries: [],
          },
        }),
      /predates this runtime event fence/,
    );
    assert.throws(
      () =>
        validateVisionEventFence({
          eventFence,
          protocolEvidence,
          runtimeTraceSnapshot: {
            runtimeGenerationId: "runtime:vision-fence-2",
            entries: [],
          },
        }),
      /generation changed/,
    );
  });

  it("collects one chronology after the fence instead of equating first socket events", async () => {
    const messages = [
      { type: "vision.ready", timestamp: "2026-07-18T00:00:00.400Z" },
      { type: "vision.ready", timestamp: "2026-07-18T00:00:01.000Z" },
      {
        type: "vision.presence_status",
        payload: {
          personPresent: false,
          detectedAt: "2026-07-18T00:00:01.100Z",
        },
      },
      {
        type: "vision.profile_result",
        payload: { eventId: "early", detectedAt: "2026-07-18T00:00:01.200Z" },
      },
      {
        type: "vision.presence_status",
        payload: {
          personPresent: true,
          detectedAt: "2026-07-18T00:00:02.000Z",
        },
      },
      {
        type: "vision.profile_result",
        payload: {
          eventId: "profile-fenced",
          detectedAt: "2026-07-18T00:00:03.000Z",
        },
      },
      {
        type: "vision.person_departed",
        payload: { detectedAt: "2026-07-18T00:00:04.000Z" },
      },
    ];
    const evidence = await collectVisionProtocolEvidence({
      machineCode: "MACHINE-01",
      eventFence: createVisionEventFence({
        runtimeTraceSnapshot: {
          runtimeGenerationId: "runtime:vision-fence-1",
          entries: [],
        },
        visionStartedAt: "2026-07-18T00:00:00.500Z",
      }),
      openSocket: async () => ({ send: () => {}, close: () => {} }),
      readMessage: async () => {
        const message = messages.shift();
        if (!message) throw new Error("message queue exhausted");
        return message;
      },
      fetchHealth: async () => ({ status: "ok" }),
      now: () => "2026-07-18T00:00:05.000Z",
      timeoutMs: 5_000,
    });
    assert.equal(evidence.profile.payload.eventId, "profile-fenced");
    assert.equal(evidence.departure, null);
    assert.equal(evidence.observedMessages.length, 6);
  });

  it("uses the Catalog Vision event as the navigation fence while retaining runtime health evidence", () => {
    const summary = validateVisionRuntimeEvidence({
      health: {
        status: "ok",
        protocol: VISION_V2_IDENTITY.protocol,
        cameraReady: true,
        frameSource: frameSourceBinding(),
      },
      catalogRecommendation: {
        recommendationActive: "true",
        profileEventId: "catalog-profile-001",
      },
      installedBinding: { frameSourceBinding: frameSourceBinding() },
    });
    assert.equal(summary.catalogProfileEventId, "catalog-profile-001");
    assert.throws(
      () =>
        validateVisionRuntimeEvidence({
          health: {
            status: "ok",
            protocol: VISION_V2_IDENTITY.protocol,
            cameraReady: true,
          },
          catalogRecommendation: {
            recommendationActive: "true",
            profileEventId: "",
          },
          installedBinding: { frameSourceBinding: frameSourceBinding() },
        }),
      /catalog Vision profile eventId/,
    );
  });

  it("waits until the catalog clears the previous Vision recommendation and returns the baseline generation", async () => {
    let reads = 0;
    const baseline = await waitForClearedVisionRecommendationBaseline(
      {
        readCatalogState: async () => {
          reads += 1;
          if (reads === 1) {
            return {
              route: "#/catalog",
              recommendationActive: "true",
              profileEventId: "profile-old",
              products: [{ catalogKey: "shirt:l" }],
            };
          }
          return {
            route: "#/catalog",
            recommendationActive: "false",
            profileEventId: null,
            products: [{ catalogKey: "shirt:l" }],
          };
        },
        readRuntimeTraceSnapshot: async () => ({
          runtimeGenerationId: "runtime:baseline-1",
          entries: [{ id: 41 }],
        }),
      },
      50,
      1,
    );
    assert.equal(baseline.catalogState.recommendationActive, "false");
    assert.equal(baseline.catalogState.profileEventId, null);
    assert.equal(
      baseline.runtimeTraceSnapshot.runtimeGenerationId,
      "runtime:baseline-1",
    );
    assert.equal(baseline.runtimeGenerationId, "runtime:baseline-1");
    assert.equal(reads, 2);
  });

  it("treats a blank catalog Vision profile eventId as absent in the baseline", async () => {
    const baseline = await waitForClearedVisionRecommendationBaseline(
      {
        readCatalogState: async () => ({
          route: "#/catalog",
          recommendationActive: "false",
          profileEventId: "",
          products: [{ catalogKey: "shirt:l" }],
        }),
        readRuntimeTraceSnapshot: async () => ({
          runtimeGenerationId: "runtime:baseline-blank",
          entries: [{ id: 9 }],
        }),
      },
      50,
      1,
    );
    assert.equal(baseline.catalogState.profileEventId, null);
    assert.equal(baseline.runtimeGenerationId, "runtime:baseline-blank");
  });

  it("times out while the previous Vision recommendation remains projected in the catalog baseline", async () => {
    await assert.rejects(
      waitForClearedVisionRecommendationBaseline(
        {
          readCatalogState: async () => ({
            route: "#/catalog",
            recommendationActive: "true",
            profileEventId: "profile-old",
            products: [{ catalogKey: "shirt:l" }],
          }),
          readRuntimeTraceSnapshot: async () => ({
            runtimeGenerationId: "runtime:baseline-stuck",
            entries: [{ id: 7 }],
          }),
        },
        10,
        1,
      ),
      /Vision recommendation baseline clear did not become true/,
    );
  });

  it("accepts a same-product size recommendation when the seeded variant matches", () => {
    const summary = validateRecommendationProjection({
      beforeProducts: [
        {
          catalogKey: "product:tee",
          preferredVariantId: "",
          recommendationScore: 0,
        },
      ],
      afterProducts: [
        {
          catalogKey: "product:tee",
          variantId: "variant-regular",
          preferredVariantId: "variant-s",
          recommendationScore: 0.88,
        },
      ],
      pageText: "推荐尺码 基础T恤",
      expectedResults: baseExpectedResults(),
      runtimeExpectation: {
        selectedVariantId: "variant-s",
        seededTryOnVariants: [
          { productId: "tee", variantId: "variant-s" },
          { productId: "tee", variantId: "variant-m" },
        ],
      },
    });
    assert.equal(summary.selectedVariantId, "variant-s");
    assert.equal(summary.seededSelection.catalogKey, "product:tee");
  });

  it("uses the seeded try-on projection as authority while cross-checking the recommendation projection", () => {
    const projection = (runtimeExpectation) =>
      validateRecommendationProjection({
        beforeProducts: [
          {
            catalogKey: "product:tee",
            preferredVariantId: "",
            recommendationScore: 0,
          },
        ],
        afterProducts: [
          {
            catalogKey: "product:tee",
            variantId: "variant-regular",
            preferredVariantId: "variant-s",
            recommendationScore: 0.88,
          },
        ],
        pageText: "推荐尺码 基础T恤",
        expectedResults: baseExpectedResults(),
        runtimeExpectation,
      });
    const seeded = {
      productId: "tee",
      variantId: "variant-s",
      sku: "TSC-LOCAL-S",
      size: "S",
    };
    const recommendation = {
      ...seeded,
      slotId: "slot-s",
      inventoryId: "inventory-s",
      onHandQty: 3,
    };
    assert.equal(
      projection({
        seededTryOnVariants: [seeded],
        recommendationVariants: [recommendation],
      }).seededSelection.catalogKey,
      "product:tee",
    );
    assert.equal(
      projection({ recommendationVariants: [recommendation] }).seededSelection
        .catalogKey,
      "product:tee",
    );
    for (const [label, runtimeExpectation, expected] of [
      [
        "a conflicting recommendation identity",
        {
          seededTryOnVariants: [seeded],
          recommendationVariants: [{ ...recommendation, sku: "OTHER-SKU" }],
        },
        /seeded and recommendation entries disagree/,
      ],
      [
        "duplicate seeded variants",
        {
          seededTryOnVariants: [seeded, seeded],
          recommendationVariants: [recommendation],
        },
        /exactly one seeded try-on entry/,
      ],
      [
        "duplicate recommendation variants",
        {
          seededTryOnVariants: [seeded],
          recommendationVariants: [recommendation, recommendation],
        },
        /exactly one recommendation entry/,
      ],
    ]) {
      assert.throws(() => projection(runtimeExpectation), expected, label);
    }
  });

  it("fails closed unless recommendation has a seeded variant match", () => {
    const summary = validateRecommendationProjection({
      beforeProducts: [
        {
          catalogKey: "product:M",
          preferredVariantId: "",
          recommendationScore: 0,
        },
        {
          catalogKey: "product:L",
          preferredVariantId: "",
          recommendationScore: 0,
        },
      ],
      afterProducts: [
        {
          catalogKey: "product:L",
          preferredVariantId: "variant-l",
          recommendationScore: 0.88,
        },
        {
          catalogKey: "product:M",
          preferredVariantId: "",
          recommendationScore: 0.12,
        },
      ],
      pageText: "推荐商品 基础T恤",
      expectedResults: baseExpectedResults(),
      runtimeExpectation: {
        selectedVariantId: "variant-l",
        seededTryOnVariants: [
          { productId: "L", variantId: "variant-l" },
          { productId: "M", variantId: "variant-m" },
        ],
      },
    });
    assert.equal(summary.selectedVariantId, "variant-l");
    assert.equal(summary.seededSelection.catalogKey, "product:L");
    assert.throws(
      () =>
        validateRecommendationProjection({
          beforeProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "",
              recommendationScore: 0,
            },
          ],
          afterProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "variant-x",
              recommendationScore: 0.9,
            },
          ],
          pageText: "推荐商品",
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            seededTryOnVariants: [{ productId: "L", variantId: "variant-l" }],
          },
        }),
      /must uniquely match exactly one seeded try-on entry/,
    );
    assert.throws(
      () =>
        validateRecommendationProjection({
          beforeProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "",
              recommendationScore: 0,
            },
          ],
          afterProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "variant-m",
              recommendationScore: 0.9,
            },
          ],
          pageText: "identity hidden? no, identity leaked",
          expectedResults: baseExpectedResults(),
        }),
      /did not actually change|leaked identity field/,
    );
    assert.throws(
      () =>
        validateRecommendationProjection({
          beforeProducts: [
            {
              catalogKey: "product:M",
              preferredVariantId: "",
              recommendationScore: 0,
            },
          ],
          afterProducts: [
            {
              catalogKey: "product:X",
              preferredVariantId: "variant-l",
              recommendationScore: 0.9,
            },
          ],
          pageText: "推荐商品",
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            seededTryOnVariants: [{ productId: "L", variantId: "variant-l" }],
          },
        }),
      /catalogKey does not match the seeded productId/,
    );
  });

  it("requires recommendation styling only for the automatic selected size", () => {
    const automatic = validateRecommendationPresentation({
      state: {
        variantId: "variant-l",
        recommendationActive: "true",
        sizeOptions: [
          {
            size: "M",
            active: false,
            recommended: false,
            recommendedClass: false,
            disabled: false,
          },
          {
            size: "L",
            active: true,
            recommended: true,
            recommendedClass: true,
            disabled: false,
          },
        ],
      },
      phase: "automatic",
      expectedVariantId: "variant-l",
    });
    assert.equal(automatic.recommendedSize, "L");

    assert.doesNotThrow(() =>
      validateRecommendationPresentation({
        state: {
          variantId: "variant-l",
          recommendationActive: "false",
          sizeOptions: [
            {
              size: "M",
              active: false,
              recommended: false,
              recommendedClass: false,
              disabled: false,
            },
            {
              size: "L",
              active: true,
              recommended: false,
              recommendedClass: false,
              disabled: false,
            },
          ],
        },
        phase: "manual",
        expectedVariantId: "variant-l",
      }),
    );
    assert.throws(
      () =>
        validateRecommendationPresentation({
          state: {
            variantId: "variant-l",
            recommendationActive: "false",
            sizeOptions: [
              {
                size: "L",
                active: true,
                recommended: true,
                recommendedClass: true,
                disabled: false,
              },
            ],
          },
          phase: "vision_unavailable",
        }),
      /must not retain recommendation styling/,
    );
    assert.throws(
      () =>
        validateRecommendationPresentation({
          state: {
            variantId: "variant-l",
            recommendationActive: "false",
            sizeOptions: [
              {
                size: "L",
                active: true,
                recommended: false,
                recommendedClass: true,
                disabled: false,
              },
            ],
          },
          phase: "manual",
        }),
      /must not retain recommendation styling/,
    );
  });

  it("requires 1080x1920 visible, bounded size controls without overflow", () => {
    assert.deepEqual(
      validateSizeControlPresentation({
        viewport: { width: 1080, height: 1920 },
        horizontalOverflow: false,
        sizeControlsOverflow: false,
        sizeOptions: [
          {
            size: "M",
            visible: true,
            bounds: { left: 120, top: 1100, right: 300, bottom: 1180 },
          },
          {
            size: "L",
            visible: true,
            bounds: { left: 320, top: 1100, right: 500, bottom: 1180 },
          },
        ],
      }),
      { viewport: { width: 1080, height: 1920 }, sizeOptionCount: 2 },
    );
    assert.throws(
      () =>
        validateSizeControlPresentation({
          viewport: { width: 1080, height: 1920 },
          horizontalOverflow: false,
          sizeControlsOverflow: true,
          sizeOptions: [
            {
              size: "L",
              visible: true,
              bounds: { left: 960, top: 1100, right: 1100, bottom: 1180 },
            },
          ],
        }),
      /overflow|viewport/,
    );
  });

  it("keeps profile and try-on acceptance usable when published fixtures do not claim recommendation data", () => {
    const expectedResults = {
      schemaVersion: "vending-vision-recorded-video-fixture/v1",
      expected: {
        top: {
          protocolEvents: ["vision.presence_status", "vision.person_departed"],
        },
        front: { tryOn: { jpeg: true } },
      },
    };
    assert.equal(
      normalizeVisionExpectedResults(expectedResults).recommendation.required,
      false,
    );
    const summary = validateRecommendationProjection({
      beforeProducts: [
        {
          catalogKey: "product:regular",
          variantId: "variant-regular",
          preferredVariantId: "",
          recommendationScore: 0,
        },
      ],
      afterProducts: [
        {
          catalogKey: "product:regular",
          variantId: "variant-regular",
          preferredVariantId: "",
          recommendationScore: 0,
        },
      ],
      pageText: "常规码 T恤",
      expectedResults,
      runtimeExpectation: {
        seededTryOnVariants: [
          { productId: "regular", variantId: "variant-regular" },
        ],
      },
    });
    assert.equal(summary.selectedVariantId, "variant-regular");
  });

  function completedTryOnState(attemptId, variantId = "variant-l") {
    return {
      route: `#/try-on?catalogKey=product:L&variantId=${variantId}&mode=fast`,
      attemptId,
      lifecycle: [
        "starting",
        "accepted",
        "acquiring",
        "generating",
        "completed",
      ].map((phase) => ({
        phase,
        attemptId,
        acquisitionPreview:
          phase === "acquiring"
            ? "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token"
            : null,
      })),
      resultUrl: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`,
      retryVisible: true,
      returnVisible: true,
    };
  }

  it("requires the exact Fast mode in the try-on route", () => {
    const validateRoute = (route) =>
      validateTryOnPresentation({
        selectedProduct: {
          catalogKey: "product:L",
          variantId: "variant-l",
        },
        tryOnState: {
          ...completedTryOnState("attempt-fast-route"),
          route,
        },
        resultEvidence: resultEvidence(),
        expectedResults: baseExpectedResults(),
      });
    assert.doesNotThrow(() =>
      validateRoute(
        "#/try-on?catalogKey=product:L&variantId=variant-l&mode=fast",
      ),
    );
    for (const route of [
      "#/try-on?catalogKey=product:L&variantId=variant-l",
      "#/try-on?catalogKey=product:L&variantId=variant-l&mode=ai",
    ]) {
      assert.throws(() => validateRoute(route), /route is not bound/);
    }
  });

  it("observes a real DOM lifecycle installed before the Fast action", async () => {
    const dom = new JSDOM(
      '<!doctype html><button data-test="try-on-fast">快速试衣</button>',
      {
        runScripts: "dangerously",
        url: "http://tauri.localhost/#/products/product:L",
      },
    );
    const { window } = dom;
    window.eval(INSTALL_TRY_ON_LIFECYCLE_OBSERVER_EXPRESSION);
    const button = window.document.querySelector('[data-test="try-on-fast"]');
    button.addEventListener("click", () => {
      window.location.hash =
        "#/try-on?catalogKey=product:L&variantId=variant-l&mode=fast";
      const view = window.document.createElement("main");
      view.dataset.test = "try-on-view";
      view.dataset.attemptId = "attempt-dom-1";
      view.dataset.state = "idle";
      window.document.body.append(view);
    });
    button.click();
    const view = window.document.querySelector('[data-test="try-on-view"]');
    for (const phase of [
      "starting",
      "accepted",
      "acquiring",
      "generating",
      "completed",
    ]) {
      if (phase === "acquiring") {
        const preview = window.document.createElement("img");
        preview.dataset.test = "try-on-acquisition-preview";
        preview.src =
          "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token";
        view.append(preview);
      }
      view.dataset.state = phase;
      await new Promise((resolvePromise) =>
        window.queueMicrotask(resolvePromise),
      );
    }
    const observations = window.eval(READ_TRY_ON_LIFECYCLE_EXPRESSION);
    const summary = validateTryOnPresentation({
      selectedProduct: { catalogKey: "product:L", variantId: "variant-l" },
      tryOnState: {
        ...completedTryOnState("attempt-dom-1"),
        route: window.location.hash,
        lifecycle: observations,
      },
      resultEvidence: resultEvidence(),
      expectedResults: baseExpectedResults(),
      runtimeExpectation: {
        seededTryOnVariants: [{ productId: "L", variantId: "variant-l" }],
      },
    });
    assert.deepEqual(Array.from(summary.lifecycle.phases), [
      "starting",
      "accepted",
      "acquiring",
      "generating",
      "completed",
    ]);
    window.__vemTryOnLifecycleObserver.disconnect();
    dom.window.close();
  });

  function resultEvidence(overrides = {}) {
    return {
      ok: true,
      httpStatus: 200,
      contentType: "image/png",
      byteLength: 2048,
      width: 512,
      height: 768,
      nonBlackPixelCount: 12,
      sha256: "f".repeat(64),
      ...overrides,
    };
  }

  it("requires decodable Fast V2 try-on result pixels and result controls", () => {
    const summary = validateTryOnPresentation({
      selectedProduct: {
        catalogKey: "product:L",
        variantId: "variant-l",
      },
      tryOnState: completedTryOnState("attempt-001"),
      resultEvidence: resultEvidence(),
      expectedResults: baseExpectedResults(),
      runtimeExpectation: {
        selectedVariantId: "variant-l",
        tryOnGarmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
        tryOnGarmentReadyUrl:
          "http://127.0.0.1:26849/media/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?grant=garment",
        seededTryOnVariants: [
          {
            productId: "L",
            variantId: "variant-l",
            garmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
            garmentReadyUrl:
              "http://127.0.0.1:26849/media/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?grant=garment",
          },
        ],
      },
    });
    assert.equal(summary.attemptId, "attempt-001");
    assert.equal(summary.nonBlackPixelCount, 12);
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: completedTryOnState("attempt-002"),
          resultEvidence: resultEvidence({ nonBlackPixelCount: 0 }),
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            selectedVariantId: "variant-l",
            seededTryOnVariants: [
              {
                productId: "L",
                variantId: "variant-l",
              },
            ],
          },
        }),
      /remained fully black/,
    );
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: {
            ...completedTryOnState("attempt-003"),
            resultUrl:
              "http://127.0.0.1:7892/v2/try-on/results/other-attempt?token=result-token",
          },
          resultEvidence: resultEvidence(),
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            seededTryOnVariants: [
              {
                productId: "L",
                variantId: "variant-l",
              },
            ],
          },
        }),
      /active attempt/,
    );
  });

  it("accepts try-on for the customer-selected seeded variant after a manual size override", () => {
    const summary = validateTryOnPresentation({
      selectedProduct: {
        catalogKey: "product:tee",
        variantId: "variant-m",
      },
      tryOnState: {
        ...completedTryOnState("attempt-004", "variant-m"),
        route: "#/try-on?catalogKey=product:tee&variantId=variant-m&mode=fast",
      },
      resultEvidence: resultEvidence(),
      expectedResults: baseExpectedResults(),
      runtimeExpectation: {
        selectedVariantId: "variant-s",
        seededTryOnVariants: [
          {
            productId: "tee",
            variantId: "variant-s",
            garmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
          },
          {
            productId: "tee",
            variantId: "variant-m",
            garmentAssetId: "550e8400-e29b-41d4-a716-446655440125",
          },
        ],
      },
    });
    assert.equal(summary.attemptId, "attempt-004");
  });

  it("rejects incomplete Fast V2 attempts before result rendering", () => {
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: {
            route:
              "#/try-on?catalogKey=product:L&variantId=variant-l&mode=fast",
            attemptId: "attempt-005",
            resultUrl:
              "http://127.0.0.1:7892/v2/try-on/results/attempt-005?token=result-token",
            lifecycle: ["starting", "accepted"].map((phase) => ({
              phase,
              attemptId: "attempt-005",
            })),
            retryVisible: false,
            returnVisible: true,
          },
          resultEvidence: resultEvidence(),
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            selectedVariantId: "variant-l",
            seededTryOnVariants: [
              {
                productId: "L",
                variantId: "variant-l",
              },
            ],
          },
        }),
      /real (acquiring|generating) lifecycle state/,
    );
  });

  it("rejects result pages without retry and return actions", () => {
    assert.throws(
      () =>
        validateTryOnPresentation({
          selectedProduct: {
            catalogKey: "product:L",
            variantId: "variant-l",
          },
          tryOnState: {
            ...completedTryOnState("attempt-006"),
            retryVisible: false,
          },
          resultEvidence: resultEvidence(),
          expectedResults: baseExpectedResults(),
          runtimeExpectation: {
            selectedVariantId: "variant-l",
            seededTryOnVariants: [
              {
                productId: "L",
                variantId: "variant-l",
              },
            ],
          },
        }),
      /retry and return/,
    );
  });

  it("requires the 7892 listener to bind the fixed installed executable and commit", () => {
    const bindingFacts = {
      installedRecord: {
        schemaVersion: "vem-vision-installed/v1",
        commit: "a".repeat(40),
        appDirectory: "C:\\VEM\\vision\\app",
        runtime: "vending-vision.exe",
        executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
        executableSha256: "b".repeat(64),
        runtimeWorkDirectory: "C:\\ProgramData\\VEM\\vision\\runtime",
        siteConfiguration: {
          path: "C:\\ProgramData\\VEM\\vision\\site.json",
          sha256: "a".repeat(64),
        },
        launcher: {
          path: "C:\\VEM\\bringup\\launch-vem-vision.ps1",
          command:
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          arguments:
            '-NoProfile -ExecutionPolicy Bypass -File "C:\\VEM\\bringup\\launch-vem-vision.ps1"',
          workingDirectory: "C:\\VEM\\vision\\app",
        },
        startTask: {
          path: "\\",
          name: "VEMVisionRuntime",
          user: "VEMKiosk",
        },
        downloadManifest: {
          path: "C:\\cache\\vision\\vending-vision-main-artifacts.json",
          sha256: "c".repeat(64),
          runtimeArchive: {
            path: "C:\\cache\\vision\\runtime.zip",
            sha256: "d".repeat(64),
          },
          fixtureArchive: {
            path: "C:\\cache\\vision\\fixtures.zip",
            sha256: "e".repeat(64),
          },
        },
        fixtureSet: {
          manifestPath:
            "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\fixture-manifest.json",
          manifestSha256: "f".repeat(64),
          top: frameSourceBinding().top,
          front: frameSourceBinding().front,
          expectedResults: frameSourceBinding().expectedResults,
        },
      },
      siteConfiguration: {
        cameras: {
          top: {
            source: "recorded_video",
            role: "presence",
            video_path:
              "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\top-presence.mp4",
            loop: true,
          },
          front: {
            source: "recorded_video",
            role: "profile_fast_try_on",
            video_path:
              "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\man-front.mp4",
            loop: true,
          },
        },
      },
      executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
      executableSha256: "b".repeat(64),
      siteConfigurationSha256: "9".repeat(64),
      downloadManifestSha256: "c".repeat(64),
      fixtureManifestSha256: "f".repeat(64),
      siteConfigurationFiles: {
        top: {
          path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\top-presence.mp4",
          sha256: "1".repeat(64),
          regularFile: true,
          symbolicLink: false,
        },
        front: {
          path: "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\man-front.mp4",
          sha256: "2".repeat(64),
          regularFile: true,
          symbolicLink: false,
        },
      },
      fixtureExpectedResultsSha256: frameSourceBinding().expectedResults.sha256,
      processId: 4242,
      processOwner: "VEMKiosk",
      commandLine:
        '"C:\\VEM\\vision\\app\\vending-vision.exe" --config "C:\\ProgramData\\VEM\\vision\\site.json"',
      taskUser: "DOM\\VEMKiosk",
      taskCommand:
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      taskArguments:
        '-NoProfile -ExecutionPolicy Bypass -File "C:\\VEM\\bringup\\launch-vem-vision.ps1"',
      taskWorkingDirectory: "C:\\VEM\\vision\\app",
      listenerProcessId: 4242,
      listenerOwnerCount: 1,
      listenerBindingSource: "Get-NetTCPConnection",
      visionProcessOwnershipSource: "Win32_Process",
      visionProcessCount: 1,
      visionProcessIds: [4242],
      visionProcessCommandLines: [
        '"C:\\VEM\\vision\\app\\vending-vision.exe" --config "C:\\ProgramData\\VEM\\vision\\site.json"',
      ],
    };
    const binding = validateVisionInstalledBinding(bindingFacts);
    assert.equal(binding.processId, 4242);
    assert.equal(binding.processOwner, "VEMKiosk");
    assert.deepEqual(binding.visionProcessIds, [4242]);
    assert.equal(Object.hasOwn(binding, "siteConfigurationSha256"), false);
    assert.equal(binding.frameSourceBinding.top.sha256, "1".repeat(64));
    assert.equal(binding.frameSourceBinding.front.sha256, "2".repeat(64));
    for (const [label, mutate, expected] of [
      [
        "a non-recorded source",
        (facts) => (facts.siteConfiguration.cameras.top.source = "camera"),
        /top camera must use recorded_video/,
      ],
      [
        "a wrong front role",
        (facts) => (facts.siteConfiguration.cameras.front.role = "presence"),
        /front role drifted/,
      ],
      [
        "an outside fixture path",
        (facts) => {
          const outside = "C:\\ProgramData\\VEM\\vision\\fixtures\\other.mp4";
          facts.siteConfiguration.cameras.front.video_path = outside;
          facts.siteConfigurationFiles.front.path = outside;
        },
        /must remain within the installed recorded-video root/,
      ],
      [
        "a symbolic-link fixture",
        (facts) => (facts.siteConfigurationFiles.front.symbolicLink = true),
        /front video must not be a symbolic link/,
      ],
      [
        "a missing fixture",
        (facts) => (facts.siteConfigurationFiles.top.regularFile = false),
        /top video must be a regular file/,
      ],
      [
        "a missing fixture observation",
        (facts) => delete facts.siteConfigurationFiles.front,
        /front video must be an object/,
      ],
      [
        "a non-looping fixture",
        (facts) => (facts.siteConfiguration.cameras.top.loop = false),
        /recorded-video cameras must loop/,
      ],
    ]) {
      const invalidConfiguration = structuredClone(bindingFacts);
      mutate(invalidConfiguration);
      assert.throws(
        () => validateVisionInstalledBinding(invalidConfiguration),
        expected,
        label,
      );
    }
    const collectedThreeProcessBinding = buildVisionInstalledRuntimeBinding({
      canonicalProcesses: [
        {
          processId: 4242,
          parentProcessId: 100,
          creationDate: "20260722120000.000000+000",
          executablePath: bindingFacts.executablePath,
          commandLine: bindingFacts.commandLine,
        },
        ...[4243, 4244].map((processId) => ({
          processId,
          parentProcessId: 4242,
          creationDate: "20260722120000.000000+000",
          executablePath: bindingFacts.executablePath,
          commandLine:
            "C:\\VEM\\vision\\app\\vending-vision.exe --multiprocessing-fork",
        })),
      ],
      listeners: [
        { localAddress: "127.0.0.1", localPort: 7892, owningProcess: 4242 },
      ],
      processOwner: bindingFacts.processOwner,
      task: {
        user: bindingFacts.taskUser,
        command: bindingFacts.taskCommand,
        arguments: bindingFacts.taskArguments,
        workingDirectory: bindingFacts.taskWorkingDirectory,
      },
    });
    const threeProcessBinding = validateVisionInstalledBinding({
      ...bindingFacts,
      ...collectedThreeProcessBinding,
    });
    assert.deepEqual(threeProcessBinding.visionProcessIds, [4242, 4243, 4244]);
    const legacyCmdLauncher = structuredClone(bindingFacts);
    legacyCmdLauncher.taskCommand = "C:\\Windows\\System32\\cmd.exe";
    legacyCmdLauncher.taskArguments =
      '/c ""C:\\VEM\\bringup\\start_vision.bat""';
    assert.throws(
      () => validateVisionInstalledBinding(legacyCmdLauncher),
      /Vision scheduled task command drifted/,
    );
    const legacyBatLauncher = structuredClone(bindingFacts);
    legacyBatLauncher.taskArguments =
      '-NoProfile -ExecutionPolicy Bypass -File "C:\\VEM\\bringup\\start_vision.bat"';
    assert.throws(
      () => validateVisionInstalledBinding(legacyBatLauncher),
      /Vision scheduled task arguments drifted/,
    );
    const installer = readFileSync(
      new URL("../windows/install-vem-runtime-owners.ps1", import.meta.url),
      "utf8",
    );
    assert.match(
      installer,
      /-Execute "C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/,
    );
    assert.match(
      installer,
      /-Argument "-NoProfile -ExecutionPolicy Bypass -File `"\$LauncherPath`""/,
    );
    assert.match(
      installer,
      /Register-InteractiveOwnerTask "VEMVisionRuntime" \$visionLauncher \$VisionAppDirectory/,
    );
    assert.throws(
      () =>
        validateVisionInstalledBinding({
          installedRecord: {
            schemaVersion: "vem-vision-installed/v1",
            commit: "a".repeat(40),
            appDirectory: "C:\\VEM\\vision\\app",
            runtime: "vending-vision.exe",
            executablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
            executableSha256: "b".repeat(64),
            runtimeWorkDirectory: "C:\\ProgramData\\VEM\\vision\\runtime",
            siteConfiguration: {
              path: "C:\\ProgramData\\VEM\\vision\\site.json",
              sha256: "a".repeat(64),
            },
            downloadManifest: {
              path: "C:\\cache\\vision\\vending-vision-main-artifacts.json",
              sha256: "c".repeat(64),
              runtimeArchive: {
                path: "C:\\cache\\vision\\runtime.zip",
                sha256: "d".repeat(64),
              },
              fixtureArchive: {
                path: "C:\\cache\\vision\\fixtures.zip",
                sha256: "e".repeat(64),
              },
            },
            fixtureSet: {
              manifestPath:
                "C:\\ProgramData\\VEM\\vision\\fixtures\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\recorded-video\\fixture-manifest.json",
              manifestSha256: "f".repeat(64),
              top: frameSourceBinding().top,
              front: frameSourceBinding().front,
              expectedResults: frameSourceBinding().expectedResults,
            },
          },
          siteConfiguration: {
            cameras: {
              top: {
                source: "recorded_video",
                role: "presence",
                video_path: frameSourceBinding().top.path,
                loop: true,
              },
              front: {
                source: "recorded_video",
                role: "profile_fast_try_on",
                video_path: frameSourceBinding().front.path,
                loop: true,
              },
            },
          },
          executablePath: "C:\\Temp\\other.exe",
          executableSha256: "b".repeat(64),
          siteConfigurationSha256: "a".repeat(64),
          downloadManifestSha256: "c".repeat(64),
          fixtureManifestSha256: "f".repeat(64),
          siteConfigurationFiles: {
            top: {
              ...frameSourceBinding().top,
              regularFile: true,
              symbolicLink: false,
            },
            front: {
              ...frameSourceBinding().front,
              regularFile: true,
              symbolicLink: false,
            },
          },
          fixtureExpectedResultsSha256:
            frameSourceBinding().expectedResults.sha256,
          processId: 1,
          processOwner: "OtherUser",
          commandLine:
            '"C:\\Temp\\other.exe" --config "C:\\ProgramData\\VEM\\vision\\site.json"',
          taskUser: "VEMKiosk",
          taskCommand: "C:\\Windows\\System32\\cmd.exe",
          taskArguments: '/c ""C:\\VEM\\bringup\\start_vision.bat""',
          taskWorkingDirectory: "C:\\VEM\\vision\\app",
          listenerProcessId: 2,
          listenerOwnerCount: 2,
          listenerBindingSource: "Get-NetTCPConnection",
        }),
      /Vision scheduled task user drifted|fixed installed executable|exactly one installed process/,
    );
  });

  it("fails closed while the target port is still occupied", async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await assert.rejects(
      waitForVisionPortRelease(200, { port, host: "127.0.0.1" }),
      /Vision port release did not become true|did not become true/,
    );
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await waitForVisionPortRelease(2_000, { port, host: "127.0.0.1" });
  });

  it("stops the mock child and preserves the primary failure when cleanup also fails", async () => {
    const probeServer = createServer();
    await new Promise((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
    const { port } = probeServer.address();
    await new Promise((resolve, reject) =>
      probeServer.close((error) => (error ? reject(error) : resolve())),
    );

    const child = spawn(process.execPath, [
      "-e",
      `const http = require("node:http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(${port}, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);`,
    ]);
    await waitForVisionPortRelease(2_000, { port, host: "127.0.0.1" }).catch(
      () => undefined,
    );
    await stopVisionChild(child, { port, host: "127.0.0.1", timeoutMs: 5_000 });

    const primary = new Error("business failed");
    const cleanup = new Error("cleanup failed");
    const combined = combineCleanupFailure(primary, cleanup);
    assert.equal(combined.errors[0], primary);
    assert.equal(combined.errors[1], cleanup);
    assert.match(combined.message, /business failed/);
    assert.match(combined.message, /cleanup failed/);
  });

  it("shuts down a failed mock child when 7892 is already occupied", async () => {
    const occupier = spawn(process.execPath, [
      "-e",
      `const http = require("node:http");
const server = http.createServer((_req, res) => {
  if (_req.url === "/health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", mockScenario: "success" }));
    return;
  }
  res.end("ok");
});
server.listen(7892, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);`,
    ]);
    try {
      await assert.rejects(
        startVisionMockScenario("try_on_unavailable_start", 1_000),
        /vision mock scenario try_on_unavailable_start did not become true/,
      );
    } finally {
      await stopVisionChild(occupier, {
        port: 7892,
        host: "127.0.0.1",
        timeoutMs: 5_000,
      });
    }
    await waitForVisionPortRelease(2_000, { port: 7892, host: "127.0.0.1" });
  });
});
