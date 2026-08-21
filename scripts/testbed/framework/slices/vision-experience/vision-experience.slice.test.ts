import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProcessRoleManifest } from "../../fault-injection.ts";
import { createFakeTestAdapter } from "../../test-adapter.ts";
import {
  runTryOnScenario,
  runObserverSelfHealScenario,
  validateVisionExperienceTimeline,
  validateGarmentScaleAdjustment,
  type VisionExperienceObservation,
} from "./vision-experience-driver.ts";

const attemptId = "550e8400-e29b-41d4-a716-446655440124";
const alternateAttemptId = "550e8400-e29b-41d4-a716-446655440125";
const selectedCatalogKey = "product:550e8400-e29b-41d4-a716-446655440126";
const selectedVariantId = "550e8400-e29b-41d4-a716-446655440127";
const firstLongSleeveVariantId = "550e8400-e29b-41d4-a716-446655440129";
const visionAcceptanceBinding = {
  selectedCatalogKey,
  selectedVariantId,
  selectedSize: "M",
  sourceGarmentMetadata: {
    reference:
      "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440128/content",
    origin: "http://127.0.0.1:26849",
    assetId: "550e8400-e29b-41d4-a716-446655440128",
    digest: `sha256:${"c".repeat(64)}`,
    contentType: "image/png" as const,
    byteSize: 3_506,
    template: "tshirt_short_sleeve" as const,
    width: 512,
    height: 640,
  },
};
const selectedProductSelector =
  `[data-test="catalog-product"]` +
  `[data-catalog-key="${selectedCatalogKey}"]`;
const selectedSizeSelector =
  `[data-test="product-size-option"]` +
  `[data-size="${visionAcceptanceBinding.selectedSize}"]`;
const selectedProductRoute = `#/products/${encodeURIComponent(
  selectedCatalogKey,
)}?variantId=${selectedVariantId}`;
const expectedStartGarment = {
  assetId: visionAcceptanceBinding.sourceGarmentMetadata.assetId,
  digest: visionAcceptanceBinding.sourceGarmentMetadata.digest,
  contentType: visionAcceptanceBinding.sourceGarmentMetadata.contentType,
  byteSize: visionAcceptanceBinding.sourceGarmentMetadata.byteSize,
  template: visionAcceptanceBinding.sourceGarmentMetadata.template,
};
const validObservationTimeline: Array<
  [number, string | null, string | null, string?]
> = [
  [0, "3", "preview-3a"],
  [750, "3", "preview-3b"],
  [1_000, "2", "preview-2a"],
  [1_750, "2", "preview-2b"],
  [2_000, "1", "preview-1a"],
  [2_750, "1", "preview-1b"],
  [3_000, null, null, "captured"],
  [3_200, null, null, "generating"],
];

function fakeUiAdapter({
  includeCaptured = true,
  includeCompleted = true,
  terminalResult = "valid",
  frameId = "frame-000042",
  resourceDigest = null,
  capturedReference = "http://127.0.0.1:7892/v2/try-on/captured/frame.png?token=captured-token",
  visionOrigin = "http://127.0.0.1:7892",
  requestId = "vision-websocket-1",
  terminalAttemptId = attemptId,
  terminalRequestId = requestId,
  resourceAttemptId = attemptId,
  resourceFrameId = frameId,
  observationTimeline = validObservationTimeline,
  resultGeometryEvidence = null,
  startGarment = expectedStartGarment,
  routeBeforeAttempt = false,
  startGarmentAfterStarting = false,
}: {
  includeCaptured?: boolean;
  includeCompleted?: boolean;
  terminalResult?: "valid" | "missing" | "forged";
  frameId?: string;
  resourceDigest?: string | null;
  capturedReference?: string;
  visionOrigin?: string;
  requestId?: string;
  terminalAttemptId?: string;
  terminalRequestId?: string;
  resourceAttemptId?: string;
  resourceFrameId?: string;
  observationTimeline?: Array<
    [number, string | null, string | null, string?]
  > | null;
  resultGeometryEvidence?: Record<string, unknown> | null;
  startGarment?: Record<string, unknown>;
  routeBeforeAttempt?: boolean;
  startGarmentAfterStarting?: boolean;
} = {}) {
  const statePath = "ui/try-on-state.json";
  const captured = {
    reference: capturedReference,
    digest: `sha256:${"a".repeat(64)}`,
    contentType: "image/png",
    byteSize: 4096,
    width: 720,
    height: 1280,
    frameId,
  };
  const completedResultReference = `${visionOrigin}/v2/try-on/results/${attemptId}?token=result-token`;
  const protocolTimeline = [
    {
      type: "vision.try_on.attempt.accepted",
      requestId,
      origin: visionOrigin,
      payload: { attemptId },
    },
    {
      type: "vision.try_on.attempt.acquiring",
      requestId,
      origin: visionOrigin,
      payload: {
        attemptId,
        preview: {
          reference: `${visionOrigin}/v2/try-on/acquisition/preview.mjpeg?token=preview-token`,
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "counting_down",
        manualCaptureAllowed: true,
        holdRemainingMs: 3_000,
      },
    },
    {
      type: "vision.try_on.attempt.captured",
      requestId,
      origin: visionOrigin,
      payload: { attemptId, captured },
    },
    {
      type: "vision.try_on.attempt.generating",
      requestId,
      origin: visionOrigin,
      payload: { attemptId, stage: "generating" },
    },
    ...(includeCompleted
      ? [
          {
            type: "vision.try_on.attempt.completed",
            requestId: terminalRequestId,
            origin: visionOrigin,
            payload: {
              attemptId: terminalAttemptId,
              ...(terminalResult === "missing"
                ? {}
                : {
                    result: {
                      reference:
                        terminalResult === "forged"
                          ? `${visionOrigin}/v2/try-on/results/${attemptId}?token=forged-token`
                          : completedResultReference,
                      digest: `sha256:${"b".repeat(64)}`,
                      contentType: "image/png",
                      byteSize: 8192,
                      width: 720,
                      height: 1280,
                    },
                  }),
            },
          },
        ]
      : []),
  ];
  const writeState = (value: Record<string, unknown>) =>
    new Promise<void>((resolvePromise) => {
      setTimeout(async () => {
        await adapter.writeFile(statePath, JSON.stringify(value));
        resolvePromise();
      }, 20);
    });
  const adapter = createFakeTestAdapter({
    files: {
      [statePath]: JSON.stringify({ route: "#/catalog", state: "idle" }),
    },
    commands: {
      "navigate #/catalog": async () => {
        await writeState({ route: "#/catalog", state: "idle" });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      'click [data-test="catalog-product"]': async () => {
        await writeState({
          route: `#/products/${selectedCatalogKey}?variantId=${firstLongSleeveVariantId}`,
          catalogKey: selectedCatalogKey,
          variantId: firstLongSleeveVariantId,
          garmentTemplate: "tshirt_long_sleeve",
          tryOnPresent: true,
          state: "idle",
        });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      [`click ${selectedProductSelector}`]: async () => {
        await writeState({
          route: `#/products/${selectedCatalogKey}?variantId=${firstLongSleeveVariantId}`,
          catalogKey: selectedCatalogKey,
          variantId: firstLongSleeveVariantId,
          tryOnPresent: true,
          state: "idle",
        });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      [`click ${selectedSizeSelector}`]: async () => {
        await writeState({
          route: `#/products/${selectedCatalogKey}?variantId=${firstLongSleeveVariantId}`,
          catalogKey: selectedCatalogKey,
          variantId: selectedVariantId,
          tryOnPresent: true,
          state: "idle",
        });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      'click [data-test="catalog-category"][data-category-key="tshirts"]':
        async () => {
          await writeState({ route: "#/catalog", state: "idle" });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      'click [data-test="try-on"]': async () => {
        await writeState({
          route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
          state: routeBeforeAttempt
            ? "idle"
            : startGarmentAfterStarting
              ? "starting"
              : "acquiring",
          attemptId: routeBeforeAttempt ? null : attemptId,
          ...(routeBeforeAttempt
            ? {}
            : startGarmentAfterStarting
              ? { startGarment: null }
              : {
                  preview: { naturalWidth: 720, naturalHeight: 1280 },
                  startGarment,
                }),
        });
        if (startGarmentAfterStarting) {
          setTimeout(() => {
            void adapter.writeFile(
              statePath,
              JSON.stringify({
                route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
                state: "acquiring",
                attemptId,
                preview: { naturalWidth: 720, naturalHeight: 1280 },
                startGarment,
              }),
            );
          }, 40);
        }
        if (routeBeforeAttempt) {
          setTimeout(() => {
            void adapter.writeFile(
              statePath,
              JSON.stringify({
                route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
                state: "acquiring",
                attemptId,
                preview: { naturalWidth: 720, naturalHeight: 1280 },
                startGarment,
              }),
            );
          }, 20);
        }
        setTimeout(() => {
          void adapter.writeFile(
            statePath,
            JSON.stringify({
              route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
              state: "completed",
              attemptId,
              startGarment,
              sourceGarmentMetadata:
                visionAcceptanceBinding.sourceGarmentMetadata,
              visionOrigin,
              preview: { naturalWidth: 720, naturalHeight: 1280 },
              resultUrl: completedResultReference,
              ...(includeCaptured
                ? {
                    protocolTimeline,
                    capturedResource: {
                      attemptId: resourceAttemptId,
                      capturedDigest: captured.digest,
                      capturedFrameId: resourceFrameId,
                      visionOrigin,
                      reference: captured.reference,
                      finalUrl: captured.reference,
                      ok: true,
                      httpStatus: 200,
                      contentType: "image/png",
                      byteSize: captured.byteSize,
                      digest: resourceDigest ?? captured.digest,
                      width: captured.width,
                      height: captured.height,
                    },
                  }
                : {}),
              ...(observationTimeline
                ? {
                    observationTimeline: observationTimeline.map(
                      ([
                        atMs,
                        countdownText,
                        previewFrameHash,
                        state = "acquiring",
                      ]) => ({
                        atMs,
                        attemptId,
                        state,
                        holdRemainingMs:
                          countdownText === null
                            ? null
                            : Number(countdownText) * 1_000,
                        countdownText,
                        previewVisible: state === "acquiring",
                        previewFrameHash,
                        capturedFrameId:
                          state === "captured" || state === "generating"
                            ? frameId
                            : null,
                        capturedDigest:
                          state === "captured" || state === "generating"
                            ? captured.digest
                            : null,
                        capturedVisible:
                          state === "captured" || state === "generating",
                        capturedNaturalWidth:
                          state === "captured" || state === "generating"
                            ? 720
                            : 0,
                        capturedNaturalHeight:
                          state === "captured" || state === "generating"
                            ? 1280
                            : 0,
                        capturedSourceMatchesProtocol:
                          state === "captured" || state === "generating",
                        capturedSourceDigest:
                          state === "captured" || state === "generating"
                            ? "sha256:captured-source"
                            : null,
                        capturedFrameHash:
                          state === "captured" || state === "generating"
                            ? "sha256:captured-frame"
                            : null,
                      }),
                    ),
                  }
                : {}),
              ...(resultGeometryEvidence ? { resultGeometryEvidence } : {}),
            }),
          );
        }, 100);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  return adapter;
}

describe("visionExperience vertical slice driver", () => {
  it("聚合商品卡首项为长袖 S 时按 catalogKey 进详情并选择 guest-input 短袖 M", async () => {
    const adapter = fakeUiAdapter();
    const outcome = await runTryOnScenario(adapter, {
      timeoutMs: 2_000,
      pollMs: 10,
      acceptanceBinding: visionAcceptanceBinding,
    });

    assert.equal(
      adapter.calls.some(
        (call) =>
          call.command === "click" && call.args[0] === selectedProductSelector,
      ),
      true,
    );
    assert.deepEqual(outcome.supportingEvidence[0], {
      kind: "vision-catalog-selection",
      catalogKey: selectedCatalogKey,
      variantId: selectedVariantId,
      size: "M",
      actions: ["catalog-card", "size-option"],
      route: `#/products/${selectedCatalogKey}?variantId=${firstLongSleeveVariantId}`,
    });
    assert.equal(
      JSON.stringify(outcome.supportingEvidence[0]).includes("token"),
      false,
    );
    assert.equal(
      adapter.calls.some(
        (call) =>
          call.command === "click" && call.args[0] === selectedSizeSelector,
      ),
      true,
    );
  });

  it("尺码 click 未改变公开 variant identity 时结构化 fail closed", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) =>
      command === "click" && args[0] === selectedSizeSelector
        ? { exitCode: 0, stdout: "size-unchanged", stderr: "" }
        : originalRun(command, args);

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-catalog-selection" &&
        error?.evidence?.expected?.size === "M" &&
        error?.evidence?.observed?.variantId === firstLongSleeveVariantId &&
        error?.report?.businessSets?.[0]?.status === "failed",
    );
  });

  it("尺码 click 仅伪装目标 route 但 DOM variant 错误时不能假绿", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "click" && args[0] === selectedSizeSelector) {
        await adapter.writeFile(
          "ui/try-on-state.json",
          JSON.stringify({
            route: selectedProductRoute,
            catalogKey: selectedCatalogKey,
            variantId: firstLongSleeveVariantId,
            state: "idle",
          }),
        );
        return { exitCode: 0, stdout: "route-forged", stderr: "" };
      }
      return originalRun(command, args);
    };

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-catalog-selection" &&
        error?.evidence?.observed?.route === selectedProductRoute &&
        error?.evidence?.observed?.variantId === firstLongSleeveVariantId &&
        error?.report?.businessSets?.[0]?.status === "failed",
    );
  });

  it("目标 catalog card 不存在时保留结构化 selection failure", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "click" && args[0] === selectedProductSelector) {
        throw new Error("catalog card selector absent");
      }
      return originalRun(command, args);
    };

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-catalog-selection" &&
        error?.evidence?.expected?.catalogKey === selectedCatalogKey &&
        error?.report?.businessSets?.[0]?.status === "failed",
    );
  });

  it("首个 attempt 的 startGarment 错绑时立即结构化 fail closed", async () => {
    const adapter = fakeUiAdapter({
      startGarment: {
        ...expectedStartGarment,
        template: "tshirt_long_sleeve",
      },
    });
    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-start-garment-binding" &&
        error?.evidence?.selection?.variantId === selectedVariantId &&
        error?.evidence?.observed?.template === "tshirt_long_sleeve" &&
        error?.report?.businessSets?.[0]?.status === "failed" &&
        error?.report?.businessSets?.[0]?.supportingEvidence?.[0]?.kind ===
          "vision-start-garment-binding",
    );
  });

  it("首个非空 startGarment 错绑后即使下一采样修正也立即失败", async () => {
    const wrongGarment = {
      ...expectedStartGarment,
      template: "tshirt_long_sleeve",
    };
    const adapter = fakeUiAdapter({ startGarment: wrongGarment });
    const originalRun = adapter.run.bind(adapter);
    const originalReadFile = adapter.readFile.bind(adapter);
    let tryOnEntered = false;
    let tryOnReads = 0;
    adapter.run = async (command, args = []) => {
      const result = await originalRun(command, args);
      if (command === "click" && args[0] === '[data-test="try-on"]') {
        tryOnEntered = true;
      }
      return result;
    };
    adapter.readFile = async (path) => {
      const value = await originalReadFile(path);
      if (!tryOnEntered || path !== "ui/try-on-state.json") return value;
      tryOnReads += 1;
      if (tryOnReads !== 3) return value;
      return JSON.stringify({
        ...JSON.parse(value),
        startGarment: expectedStartGarment,
      });
    };

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 2_000,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-start-garment-binding" &&
        error?.evidence?.failureReason === "garment-mismatch" &&
        error?.evidence?.observed?.template === "tshirt_long_sleeve" &&
        error?.report?.businessSets?.[0]?.status === "failed",
    );
  });

  it("starting 阶段 descriptor 暂缺时等待同 attempt accepted 的 startGarment", async () => {
    const outcome = await runTryOnScenario(
      fakeUiAdapter({ startGarmentAfterStarting: true }),
      {
        timeoutMs: 2_000,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      },
    );

    assert.equal(outcome.report.businessSets[0].status, "passed");
    assert.deepEqual(outcome.supportingEvidence[1], {
      kind: "vision-start-garment-binding",
      status: "bound",
      attemptId,
      observedAttemptId: attemptId,
      lastStage: "acquiring",
      failureReason: null,
      selection: {
        catalogKey: selectedCatalogKey,
        variantId: selectedVariantId,
        size: "M",
      },
      expected: expectedStartGarment,
      observed: expectedStartGarment,
    });
  });

  it("route 已伪装正确但同 attempt 的 startGarment 永久缺失时仍 timeout", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "click" && args[0] === '[data-test="try-on"]') {
        await adapter.writeFile(
          "ui/try-on-state.json",
          JSON.stringify({
            route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
            state: "starting",
            attemptId,
            startGarment: null,
          }),
        );
        return { exitCode: 0, stdout: "starting", stderr: "" };
      }
      return originalRun(command, args);
    };

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-start-garment-binding" &&
        error?.evidence?.failureReason === "timeout" &&
        error?.evidence?.attemptId === attemptId &&
        error?.evidence?.lastStage === "starting" &&
        error?.evidence?.observed?.assetId === null &&
        error?.report?.businessSets?.[0]?.status === "failed" &&
        !JSON.stringify(error.evidence).includes("token"),
    );
  });

  it("后续 attempt 的 startGarment 不得绑定到首个 attempt", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "click" && args[0] === '[data-test="try-on"]') {
        await adapter.writeFile(
          "ui/try-on-state.json",
          JSON.stringify({
            route: "#/try-on?variantId=forged-route",
            state: "starting",
            attemptId,
            startGarment: null,
          }),
        );
        setTimeout(() => {
          void adapter.writeFile(
            "ui/try-on-state.json",
            JSON.stringify({
              route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
              state: "acquiring",
              attemptId: alternateAttemptId,
              startGarment: expectedStartGarment,
            }),
          );
        }, 10);
        return { exitCode: 0, stdout: "starting", stderr: "" };
      }
      return originalRun(command, args);
    };

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 100,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-start-garment-binding" &&
        error?.evidence?.failureReason === "attempt-changed" &&
        error?.evidence?.attemptId === attemptId &&
        error?.evidence?.lastStage === "acquiring" &&
        error?.report?.businessSets?.[0]?.status === "failed",
    );
  });

  it("terminal failed 没有 startGarment 时立即结构化 fail closed", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "click" && args[0] === '[data-test="try-on"]') {
        await adapter.writeFile(
          "ui/try-on-state.json",
          JSON.stringify({
            route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
            state: "starting",
            attemptId,
            startGarment: null,
          }),
        );
        setTimeout(() => {
          void adapter.writeFile(
            "ui/try-on-state.json",
            JSON.stringify({
              route: "#/catalog",
              state: "failed",
              attemptId,
              startGarment: null,
            }),
          );
        }, 10);
        return { exitCode: 0, stdout: "starting", stderr: "" };
      }
      return originalRun(command, args);
    };

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 100,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-start-garment-binding" &&
        error?.evidence?.failureReason === "terminal-without-garment" &&
        error?.evidence?.lastStage === "failed" &&
        error?.report?.businessSets?.[0]?.status === "failed",
    );
  });

  it("selector click 未产生详情导航时不能由 driver 强制导航掩盖", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) =>
      command === "click" && args[0] === selectedProductSelector
        ? { exitCode: 0, stdout: "click-no-navigation", stderr: "" }
        : originalRun(command, args);

    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      (error: any) =>
        error?.stage === "vision-catalog-selection" &&
        error?.evidence?.expected?.variantId === selectedVariantId &&
        error?.report?.businessSets?.[0]?.status === "failed",
    );
    assert.equal(
      adapter.calls.some(
        (call) =>
          call.command === "navigate" && call.args[0] === selectedProductRoute,
      ),
      false,
    );
  });

  it("仅在 attemptId 出现后的公开状态验证 startGarment", async () => {
    const outcome = await runTryOnScenario(
      fakeUiAdapter({ routeBeforeAttempt: true }),
      {
        timeoutMs: 2_000,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      },
    );
    assert.equal(outcome.report.businessSets[0].status, "passed");
  });

  it("将唯一同 attempt 的绝对 100→105 V2 调整意图绑定到 adjusted resource", () => {
    const resultUrl =
      "http://127.0.0.1:7892/v2/try-on/results/attempt?token=105";
    assert.equal(
      validateGarmentScaleAdjustment({
        evidence: { scales: [1.05], results: [{ reference: resultUrl }] },
        resultUrl,
      }),
      true,
    );
    for (const evidence of [
      { scales: [1.1], results: [{ reference: resultUrl }] },
      { scales: [], results: [{ reference: resultUrl }] },
      { scales: [1.05, 1.05], results: [{ reference: resultUrl }] },
      { scales: [1.05], results: [] },
      {
        scales: [1.05],
        results: [{ reference: resultUrl }, { reference: resultUrl }],
      },
    ]) {
      assert.equal(
        validateGarmentScaleAdjustment({ evidence, resultUrl }),
        false,
      );
    }
  });
  it("拒绝跳过倒计时、过早捕获、非单调时间和静态预览", () => {
    const attempt = "attempt-time-line";
    const observation = (
      atMs: number,
      countdownText: string,
      frameHash: string,
    ) => ({
      atMs,
      attemptId: attempt,
      state: "acquiring",
      holdRemainingMs: Number(countdownText) * 1_000,
      countdownText,
      previewVisible: true,
      previewFrameHash: frameHash,
    });
    const result = validateVisionExperienceTimeline({
      attemptId: attempt,
      samples: [
        observation(0, "3", "a"),
        observation(800, "1", "a"),
        observation(700, "1", "a"),
        {
          atMs: 900,
          attemptId: attempt,
          state: "captured",
          holdRemainingMs: null,
          countdownText: null,
          previewVisible: false,
          previewFrameHash: null,
        },
      ],
    });

    assert.deepEqual(result.countdownRenderedSequence.observed, ["3", "1"]);
    assert.equal(result.captureAfterCountdown.observed, true);
    assert.equal(result.previewLiveThroughCountdown.observed, false);
    assert.equal(result.ok, false);
  });

  it("将倒计时协议与 DOM 一致性从顺序和时长判定中拆开", () => {
    const attemptId = "attempt-countdown-protocol-dom-consistency";
    const held = (atMs: number, state: "captured" | "generating") => ({
      atMs,
      attemptId,
      state,
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
      capturedFrameId: "captured-frame",
      capturedDigest: "sha256:captured",
      capturedVisible: true,
      capturedNaturalWidth: 720,
      capturedNaturalHeight: 1280,
      capturedSourceMatchesProtocol: true,
      capturedSourceDigest: "sha256:captured-source",
      capturedFrameHash: "sha256:captured-frame",
    });
    const baseline: VisionExperienceObservation[] = [
      [0, 3_000, "3"],
      [750, 2_250, "3"],
      [1_000, 2_000, "2"],
      [1_750, 1_250, "2"],
      [2_000, 1_000, "1"],
      [2_750, 250, "1"],
    ].map(([atMs, holdRemainingMs, countdownText]) => ({
      atMs,
      attemptId,
      state: "acquiring",
      holdRemainingMs,
      countdownText,
      previewVisible: true,
      previewFrameHash: `preview-${atMs}`,
    }));
    const validate = (samples: VisionExperienceObservation[]) =>
      validateVisionExperienceTimeline({ attemptId, samples });
    const complete = [
      ...baseline,
      held(3_000, "captured"),
      held(3_200, "generating"),
    ];

    assert.equal(
      validate(complete).countdownProtocolDomConsistent.observed,
      true,
    );
    const boundedEvidence = validate([
      ...complete,
      ...Array.from({ length: 513 }, (_, index) =>
        held(3_300 + index, "generating"),
      ),
    ]).countdownProtocolDomConsistent.evidence;
    assert.equal(boundedEvidence.samples.length, 512);
    assert.deepEqual(Object.keys(boundedEvidence.samples[0]!).sort(), [
      "atMs",
      "countdownText",
      "holdRemainingMs",
      "state",
    ]);

    const reverseTime = structuredClone(complete);
    reverseTime[2]!.atMs = 699;
    const reverseTimeResult = validate(reverseTime);
    assert.equal(
      reverseTimeResult.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.equal(
      reverseTimeResult.countdownVisibleDuration.observed.passed,
      false,
    );
    assert.equal(reverseTimeResult.captureAfterCountdown.observed, true);

    const mismatchedDigit = structuredClone(complete);
    mismatchedDigit[3]!.holdRemainingMs = 2_300;
    const mismatchedDigitResult = validate(mismatchedDigit);
    assert.equal(
      mismatchedDigitResult.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.deepEqual(mismatchedDigitResult.countdownRenderedSequence.observed, [
      "3",
      "2",
      "1",
    ]);
    assert.equal(
      mismatchedDigitResult.countdownVisibleDuration.observed.passed,
      true,
    );
    assert.equal(mismatchedDigitResult.captureAfterCountdown.observed, true);

    const reboundingHold = structuredClone(complete);
    reboundingHold[4]!.holdRemainingMs = 1_500;
    const reboundingHoldResult = validate(reboundingHold);
    assert.equal(
      reboundingHoldResult.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.deepEqual(reboundingHoldResult.countdownRenderedSequence.observed, [
      "3",
      "2",
      "1",
    ]);
    assert.equal(
      reboundingHoldResult.countdownVisibleDuration.observed.passed,
      true,
    );
    assert.equal(reboundingHoldResult.captureAfterCountdown.observed, true);

    const earlyCapture = structuredClone(complete);
    earlyCapture[6]!.atMs = 2_400;
    const earlyCaptureResult = validate(earlyCapture);
    assert.equal(earlyCaptureResult.captureAfterCountdown.observed, false);
    assert.equal(
      earlyCaptureResult.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.equal(
      earlyCaptureResult.countdownVisibleDuration.observed.passed,
      false,
    );

    const nullObservationReverseTime = structuredClone(complete);
    nullObservationReverseTime.push({
      atMs: 2_900,
      attemptId,
      state: "acquiring",
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
    });
    const nullObservationReverseTimeResult = validate(
      nullObservationReverseTime,
    );
    assert.equal(
      nullObservationReverseTimeResult.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.equal(nullObservationReverseTimeResult.ok, false);

    const heldObservationReverseTime = structuredClone(complete);
    heldObservationReverseTime[7]!.atMs = 2_900;
    const heldObservationReverseTimeResult = validate(
      heldObservationReverseTime,
    );
    assert.equal(
      heldObservationReverseTimeResult.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.equal(heldObservationReverseTimeResult.ok, false);
  });

  it("对被打断的旧倒计时轮次保留 protocol 与 DOM 一致性检查", () => {
    const attemptId = "attempt-countdown-all-round-consistency";
    const countdown = (
      atMs: number,
      holdRemainingMs: number,
      countdownText: "3" | "2" | "1",
    ): VisionExperienceObservation => ({
      atMs,
      attemptId,
      state: "acquiring",
      holdRemainingMs,
      countdownText,
      previewVisible: true,
      previewFrameHash: `preview-${atMs}`,
    });
    const breakRound = (atMs: number): VisionExperienceObservation => ({
      atMs,
      attemptId,
      state: "acquiring",
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
    });
    const held = (
      atMs: number,
      state: "captured" | "generating",
    ): VisionExperienceObservation => ({
      atMs,
      attemptId,
      state,
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
      capturedFrameId: "frame",
      capturedDigest: "sha256:captured",
      capturedVisible: true,
      capturedNaturalWidth: 720,
      capturedNaturalHeight: 1280,
      capturedSourceMatchesProtocol: true,
      capturedSourceDigest: "sha256:captured-source",
      capturedFrameHash: "sha256:captured-frame",
    });
    const validCurrentRound = [
      countdown(1_000, 3_000, "3"),
      countdown(1_750, 2_250, "3"),
      countdown(2_000, 2_000, "2"),
      countdown(2_750, 1_250, "2"),
      countdown(3_000, 1_000, "1"),
      countdown(3_750, 250, "1"),
      held(4_000, "captured"),
      held(4_200, "generating"),
    ];
    const validate = (samples: VisionExperienceObservation[]) =>
      validateVisionExperienceTimeline({ attemptId, samples });

    const interruptedCeilMismatch = validate([
      countdown(0, 3_000, "3"),
      countdown(100, 2_300, "2"),
      breakRound(200),
      ...validCurrentRound,
    ]);
    assert.equal(
      interruptedCeilMismatch.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.equal(
      interruptedCeilMismatch.countdownProtocolDomConsistent.evidence.subchecks
        .holdMatchesDom,
      false,
    );
    assert.equal(interruptedCeilMismatch.ok, false);

    const interruptedHoldRebound = validate([
      countdown(0, 3_000, "3"),
      countdown(100, 2_100, "3"),
      countdown(200, 2_200, "3"),
      breakRound(300),
      ...validCurrentRound,
    ]);
    assert.equal(
      interruptedHoldRebound.countdownProtocolDomConsistent.observed,
      false,
    );
    assert.equal(
      interruptedHoldRebound.countdownProtocolDomConsistent.evidence.subchecks
        .holdNonIncreasing,
      false,
    );
    assert.equal(interruptedHoldRebound.ok, false);

    const legalReset = validate([
      countdown(0, 1_000, "1"),
      breakRound(100),
      ...validCurrentRound,
    ]);
    assert.equal(legalReset.countdownProtocolDomConsistent.observed, true);
    assert.equal(legalReset.ok, true);
  });

  it("按每个数字后的首个非本数字观测计算可见桶，而不把 1 截到最后一次同数字轮询", () => {
    const attemptId = "attempt-countdown-visible-boundary";
    const countdown = [
      [0, 3_000, "3", "preview-3a"],
      [600, 2_400, "3", "preview-3b"],
      [1_217, 1_900, "2", "preview-2a"],
      [1_700, 1_400, "2", "preview-2b"],
      [2_097, 900, "1", "preview-1a"],
      [2_697, 300, "1", "preview-1b"],
      [2_989, null, null, null],
    ] as const;
    const held = (atMs: number, state: "captured" | "generating") => ({
      atMs,
      attemptId,
      state,
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
      capturedFrameId: "frame-countdown-boundary",
      capturedDigest: "sha256:countdown-boundary",
      capturedVisible: true,
      capturedNaturalWidth: 720,
      capturedNaturalHeight: 1280,
      capturedSourceMatchesProtocol: true,
      capturedSourceDigest: "sha256:captured-source",
      capturedFrameHash: "sha256:captured-frame",
    });
    const result = validateVisionExperienceTimeline({
      attemptId,
      samples: [
        ...countdown.map(
          ([atMs, holdRemainingMs, countdownText, previewFrameHash]) => ({
            atMs,
            attemptId,
            state: "acquiring",
            holdRemainingMs,
            countdownText,
            previewVisible: countdownText !== null,
            previewFrameHash,
          }),
        ),
        held(3_280, "captured"),
        held(3_400, "generating"),
      ],
    });

    assert.equal(result.countdownVisibleDuration.observed.passed, true);
    assert.deepEqual(
      result.countdownVisibleDuration.observed.bucketDurationsMs,
      {
        "3": 1_217,
        "2": 880,
        "1": 892,
      },
    );
    assert.equal(
      result.countdownVisibleDuration.observed.totalDurationMs,
      3_280,
    );
    assert.equal(result.captureAfterCountdown.observed, true);
    assert.equal(result.ok, true);
  });

  it("把 699ms 桶、2499ms 总时长、早捕获、跳号和非单调时间保持为时序失败", () => {
    const attemptId = "attempt-countdown-visible-mutations";
    const held = (
      atMs: number,
      state: "captured" | "generating",
    ): VisionExperienceObservation => ({
      atMs,
      attemptId,
      state,
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
      capturedFrameId: "mutation-frame",
      capturedDigest: "sha256:mutation",
      capturedVisible: true,
      capturedNaturalWidth: 720,
      capturedNaturalHeight: 1280,
      capturedSourceMatchesProtocol: true,
      capturedSourceDigest: "sha256:captured-source",
      capturedFrameHash: "sha256:captured-frame",
    });
    const samples = (
      entries: readonly (readonly [number, number, string])[],
      heldAt: number,
      includeBoundary = true,
    ): VisionExperienceObservation[] => [
      ...entries.map(([atMs, holdRemainingMs, countdownText]) => ({
        atMs,
        attemptId,
        state: "acquiring",
        holdRemainingMs,
        countdownText,
        previewVisible: true,
        previewFrameHash: `preview-${atMs}`,
      })),
      ...(includeBoundary
        ? [
            {
              atMs: heldAt - 99,
              attemptId,
              state: "acquiring",
              holdRemainingMs: null,
              countdownText: null,
              previewVisible: false,
              previewFrameHash: null,
            },
          ]
        : []),
      held(heldAt, "captured"),
      held(heldAt + 100, "generating"),
    ];
    const baseline = [
      [0, 3_000, "3"],
      [750, 2_250, "3"],
      [800, 2_000, "2"],
      [1_550, 1_250, "2"],
      [1_600, 1_000, "1"],
      [2_350, 250, "1"],
    ] as const;
    const validate = (input: VisionExperienceObservation[]) =>
      validateVisionExperienceTimeline({ attemptId, samples: input });

    assert.equal(validate(samples(baseline, 2_500)).ok, true);
    assert.equal(
      validate(
        samples(
          baseline.map((entry, index) =>
            index === 2 ? [699, entry[1], entry[2]] : entry,
          ),
          2_500,
        ),
      ).countdownVisibleDuration.observed.passed,
      false,
    );
    const totalTooShort = validate(samples(baseline, 2_499));
    assert.equal(
      totalTooShort.countdownVisibleDuration.observed.totalDurationMs,
      2_499,
    );
    assert.equal(totalTooShort.countdownVisibleDuration.observed.passed, false);
    const earlyCapture = validate(samples(baseline, 2_300, false));
    assert.equal(earlyCapture.captureAfterCountdown.observed, false);
    assert.equal(earlyCapture.ok, false);
    const skippedDigit = validate(
      samples(
        baseline.map((entry, index) =>
          index === 2 ? [entry[0], entry[1], "1"] : entry,
        ),
        2_500,
      ),
    );
    assert.equal(skippedDigit.captureAfterCountdown.observed, true);
    assert.equal(skippedDigit.ok, false);
    const nonMonotonic = samples(baseline, 2_500);
    [nonMonotonic[1], nonMonotonic[2]] = [nonMonotonic[2]!, nonMonotonic[1]!];
    const nonMonotonicResult = validate(nonMonotonic);
    assert.equal(nonMonotonicResult.captureAfterCountdown.observed, true);
    assert.equal(nonMonotonicResult.ok, false);
  });

  it("将每个连续倒计时样本的 protocol hold 与 DOM ceil(hold/1000) 绑定", () => {
    const attemptId = "attempt-hold";
    const baseline = [
      [0, 3_000, "3"],
      [800, 2_200, "3"],
      [1_000, 2_000, "2"],
      [1_400, 1_600, "2"],
      [1_800, 1_100, "2"],
      [2_000, 1_000, "1"],
      [2_800, 100, "1"],
    ] as const;
    const validate = (
      samples: readonly (readonly [number, number | null, string])[],
    ) =>
      validateVisionExperienceTimeline({
        attemptId,
        samples: [
          ...samples.map(([atMs, holdRemainingMs, countdownText]) => ({
            atMs,
            attemptId,
            state: "acquiring",
            holdRemainingMs,
            countdownText,
            previewVisible: true,
            previewFrameHash: `${atMs}`,
          })),
          {
            atMs: 3_000,
            attemptId,
            state: "captured",
            holdRemainingMs: null,
            countdownText: null,
            previewVisible: false,
            previewFrameHash: null,
            capturedFrameId: "frame",
            capturedDigest: "sha256:one",
            capturedVisible: true,
            capturedNaturalWidth: 720,
            capturedNaturalHeight: 1280,
            capturedSourceMatchesProtocol: true,
            capturedSourceDigest: "sha256:captured-source",
            capturedFrameHash: "sha256:captured-frame",
          },
          {
            atMs: 3_100,
            attemptId,
            state: "generating",
            holdRemainingMs: null,
            countdownText: null,
            previewVisible: false,
            previewFrameHash: null,
            capturedFrameId: "frame",
            capturedDigest: "sha256:one",
            capturedVisible: true,
            capturedNaturalWidth: 720,
            capturedNaturalHeight: 1280,
            capturedSourceMatchesProtocol: true,
            capturedSourceDigest: "sha256:captured-source",
            capturedFrameHash: "sha256:captured-frame",
          },
        ],
      });
    assert.equal(validate(baseline).ok, true);
    assert.equal(
      validate(
        baseline.map((entry, index) =>
          index === 2 ? [entry[0], entry[1], "3"] : entry,
        ),
      ).ok,
      false,
    );
    assert.equal(
      validate(
        baseline.map((entry, index) =>
          index === 3 ? [entry[0], 2_300, entry[2]] : entry,
        ),
      ).ok,
      false,
    );
    assert.equal(
      validate(
        baseline.map((entry, index) =>
          index === 3 ? [entry[0], null, entry[2]] : entry,
        ),
      ).ok,
      false,
    );
  });

  it("倒计时的任一样本失去 live preview 时 captured 图像不得补救，且完整 1 桶结束前不得进入 held", () => {
    const attemptId = "attempt-countdown-boundary";
    const countdown = [
      [0, 3_000, "3"],
      [800, 2_200, "3"],
      [1_000, 2_000, "2"],
      [1_400, 1_600, "2"],
      [1_800, 1_100, "2"],
      [2_000, 1_000, "1"],
      [2_800, 100, "1"],
    ] as const;
    const samples = (options: {
      invisibleAt?: number;
      generatingAt?: number;
      capturedAt?: number;
    }) =>
      [
        ...countdown.map(([atMs, holdRemainingMs, countdownText], index) => ({
          atMs,
          attemptId,
          state: "acquiring",
          holdRemainingMs,
          countdownText,
          previewVisible: index !== options.invisibleAt,
          previewFrameHash: `${atMs}`,
        })),
        ...(options.generatingAt === undefined
          ? []
          : [
              {
                atMs: options.generatingAt,
                attemptId,
                state: "generating",
                holdRemainingMs: null,
                countdownText: null,
                previewVisible: false,
                previewFrameHash: null,
                capturedFrameId: "frame",
                capturedDigest: "sha256:one",
                capturedVisible: true,
                capturedNaturalWidth: 720,
                capturedNaturalHeight: 1280,
                capturedSourceMatchesProtocol: true,
                capturedSourceDigest: "sha256:captured-source",
                capturedFrameHash: "sha256:captured-frame",
              },
            ]),
        {
          atMs: options.capturedAt ?? 3_000,
          attemptId,
          state: "captured",
          holdRemainingMs: null,
          countdownText: null,
          previewVisible: false,
          previewFrameHash: null,
          capturedFrameId: "frame",
          capturedDigest: "sha256:one",
          capturedVisible: true,
          capturedNaturalWidth: 720,
          capturedNaturalHeight: 1280,
          capturedSourceMatchesProtocol: true,
          capturedSourceDigest: "sha256:captured-source",
          capturedFrameHash: "sha256:captured-frame",
        },
        {
          atMs: 3_100,
          attemptId,
          state: "generating",
          holdRemainingMs: null,
          countdownText: null,
          previewVisible: false,
          previewFrameHash: null,
          capturedFrameId: "frame",
          capturedDigest: "sha256:one",
          capturedVisible: true,
          capturedNaturalWidth: 720,
          capturedNaturalHeight: 1280,
          capturedSourceMatchesProtocol: true,
          capturedSourceDigest: "sha256:captured-source",
          capturedFrameHash: "sha256:captured-frame",
        },
      ].sort((left, right) => left.atMs - right.atMs);
    assert.equal(
      validateVisionExperienceTimeline({
        attemptId,
        samples: samples({ invisibleAt: 3 }),
      }).ok,
      false,
    );
    assert.equal(
      validateVisionExperienceTimeline({
        attemptId,
        samples: samples({ generatingAt: 2_500 }),
      }).ok,
      false,
    );
    assert.equal(
      validateVisionExperienceTimeline({
        attemptId,
        samples: samples({ capturedAt: 2_500 }),
      }).ok,
      false,
    );
  });

  it("captured/generating 必须逐样本呈现已加载、可见且身份稳定的独立 captured 图像", () => {
    const attemptId = "attempt-captured-dom-identity";
    const countdown = [
      [0, 3_000, "3"],
      [800, 2_200, "3"],
      [1_000, 2_000, "2"],
      [1_800, 1_200, "2"],
      [2_000, 1_000, "1"],
      [2_800, 100, "1"],
    ] as const;
    const sample = (
      atMs: number,
      state: "captured" | "generating",
      overrides: Partial<VisionExperienceObservation> = {},
    ): VisionExperienceObservation => ({
      atMs,
      attemptId,
      state,
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
      capturedFrameId: "captured-frame",
      capturedDigest: "sha256:captured",
      ...overrides,
    });
    const validCountdown: VisionExperienceObservation[] = countdown.map(
      ([atMs, holdRemainingMs, countdownText]) => ({
        atMs,
        attemptId,
        state: "acquiring",
        holdRemainingMs,
        countdownText,
        previewVisible: true,
        previewFrameHash: `${atMs}`,
      }),
    );
    const validate = (held: VisionExperienceObservation[]) =>
      validateVisionExperienceTimeline({
        attemptId,
        samples: [...validCountdown, ...held],
      });

    // 当前实现只看 protocol identity，因而下列所有 DOM 缺陷都会错误通过。
    assert.equal(
      validate([sample(3_000, "captured"), sample(3_200, "generating")]).ok,
      false,
    );
    assert.equal(
      validate([
        sample(3_000, "captured", {
          capturedVisible: false,
          capturedNaturalWidth: 0,
          capturedNaturalHeight: 0,
          capturedSourceMatchesProtocol: false,
          capturedSourceDigest: null,
          capturedFrameHash: null,
        }),
        sample(3_200, "generating", {
          capturedVisible: true,
          capturedNaturalWidth: 720,
          capturedNaturalHeight: 1280,
          capturedSourceMatchesProtocol: true,
          capturedSourceDigest: "sha256:source-a",
          capturedFrameHash: "sha256:frame-a",
        }),
      ]).ok,
      false,
    );
    const validCaptured = {
      capturedVisible: true,
      capturedNaturalWidth: 720,
      capturedNaturalHeight: 1280,
      capturedSourceMatchesProtocol: true,
      capturedSourceDigest: "sha256:source-a",
      capturedFrameHash: "sha256:frame-a",
    };
    assert.equal(
      validate([
        sample(3_000, "captured", validCaptured),
        sample(3_200, "generating", {
          ...validCaptured,
          capturedSourceDigest: "sha256:source-b",
        }),
      ]).ok,
      false,
    );
    assert.equal(
      validate([
        sample(3_000, "captured", validCaptured),
        sample(3_200, "generating", {
          ...validCaptured,
          capturedFrameHash: "sha256:frame-b",
        }),
      ]).ok,
      false,
    );
  });

  it("acquiring 阶段出现 captured DOM 即使 live preview 正常也 fail closed", () => {
    const attemptId = "attempt-captured-wrong-phase";
    const samples: VisionExperienceObservation[] = [
      {
        atMs: 0,
        attemptId,
        state: "acquiring",
        holdRemainingMs: 3_000,
        countdownText: "3",
        previewVisible: true,
        previewFrameHash: "preview",
        capturedVisible: true,
        capturedNaturalWidth: 720,
        capturedNaturalHeight: 1280,
        capturedSourceMatchesProtocol: true,
        capturedSourceDigest: "sha256:captured-source",
        capturedFrameHash: "sha256:captured-frame",
      },
    ];
    const result = validateVisionExperienceTimeline({ attemptId, samples });
    assert.equal(result.capturedAbsentOutsideHeld.observed, false);
    assert.equal(result.ok, false);
  });

  it("轮询错过瞬时 captured phase 时以 generating 的独立 captured DOM 证明捕获已完成", () => {
    const attemptId = "attempt-captured-between-polls";
    const acquiring = [
      [0, 3_000, "3"],
      [800, 2_200, "3"],
      [1_000, 2_000, "2"],
      [1_800, 1_200, "2"],
      [2_000, 1_000, "1"],
      [2_800, 100, "1"],
    ].map(([atMs, holdRemainingMs, countdownText]) => ({
      atMs,
      attemptId,
      state: "acquiring",
      holdRemainingMs,
      countdownText,
      previewVisible: true,
      previewFrameHash: `preview-${atMs}`,
    }));
    const held = [3_000, 3_300].map((atMs) => ({
      atMs,
      attemptId,
      state: "generating",
      holdRemainingMs: null,
      countdownText: null,
      previewVisible: false,
      previewFrameHash: null,
      capturedFrameId: "frame-between-polls",
      capturedDigest: "sha256:captured-between-polls",
      capturedVisible: true,
      capturedNaturalWidth: 720,
      capturedNaturalHeight: 1280,
      capturedSourceMatchesProtocol: true,
      capturedSourceDigest: "sha256:captured-source",
      capturedFrameHash: "sha256:captured-frame",
    }));

    const result = validateVisionExperienceTimeline({
      attemptId,
      samples: [...acquiring, ...held] as VisionExperienceObservation[],
    });

    assert.equal(result.captureAfterCountdown.observed, true);
    assert.equal(result.capturedFrameHeldDuringGeneration.observed, true);
    assert.equal(result.ok, true);
  });

  it("失稳后的倒计时必须从新的 3 完整重走", () => {
    const attemptId = "attempt-reset";
    const sample = (
      atMs: number,
      countdownText: string | null,
      previewFrameHash: string | null,
      state = "acquiring",
    ) => ({
      atMs,
      attemptId,
      state,
      holdRemainingMs:
        countdownText === null ? null : Number(countdownText) * 1_000,
      countdownText,
      previewVisible: state === "acquiring",
      previewFrameHash,
      capturedFrameId:
        state === "captured" || state === "generating" ? "frame-1" : null,
      capturedDigest:
        state === "captured" || state === "generating" ? "sha256:one" : null,
      capturedVisible: state === "captured" || state === "generating",
      capturedNaturalWidth:
        state === "captured" || state === "generating" ? 720 : 0,
      capturedNaturalHeight:
        state === "captured" || state === "generating" ? 1280 : 0,
      capturedSourceMatchesProtocol:
        state === "captured" || state === "generating",
      capturedSourceDigest:
        state === "captured" || state === "generating"
          ? "sha256:captured-source"
          : null,
      capturedFrameHash:
        state === "captured" || state === "generating"
          ? "sha256:captured-frame"
          : null,
    });
    const result = validateVisionExperienceTimeline({
      attemptId,
      samples: [
        sample(0, "3", "old-a"),
        sample(500, "2", "old-b"),
        sample(700, null, null),
        sample(800, "3", "new-a"),
        sample(1_550, "3", "new-b"),
        sample(1_700, "2", "new-c"),
        sample(2_450, "2", "new-d"),
        sample(2_600, "1", "new-e"),
        sample(3_350, "1", "new-f"),
        sample(3_800, null, null, "captured"),
        sample(4_000, null, null, "generating"),
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.countdownRenderedSequence.observed, [
      "3",
      "2",
      "1",
    ]);
  });

  it("对齐中断后第二轮 3 不得借用第一轮的等待时间", () => {
    const attemptId = "attempt-alignment-reset";
    const sample = (
      atMs: number,
      countdownText: string | null,
      state = "acquiring",
    ) => ({
      atMs,
      attemptId,
      state,
      holdRemainingMs:
        countdownText === null ? null : Number(countdownText) * 1_000,
      countdownText,
      previewVisible: state === "acquiring",
      previewFrameHash: countdownText ? `${countdownText}-${atMs}` : null,
      capturedFrameId: state === "captured" ? "frame-1" : null,
      capturedDigest: state === "captured" ? "sha256:one" : null,
      capturedVisible: state === "captured",
      capturedNaturalWidth: state === "captured" ? 720 : 0,
      capturedNaturalHeight: state === "captured" ? 1280 : 0,
      capturedSourceMatchesProtocol: state === "captured",
      capturedSourceDigest:
        state === "captured" ? "sha256:captured-source" : null,
      capturedFrameHash: state === "captured" ? "sha256:captured-frame" : null,
    });
    const result = validateVisionExperienceTimeline({
      attemptId,
      samples: [
        sample(0, "3"),
        sample(800, null),
        sample(900, "3"),
        sample(1_200, "2"),
        sample(1_950, "2"),
        sample(2_100, "1"),
        sample(2_850, "1"),
        sample(3_500, null, "captured"),
      ],
    });
    assert.equal(result.countdownRenderedSequence.observed[0], "3");
    assert.equal(result.captureAfterCountdown.observed, true);
    assert.equal(result.ok, false);
  });

  it("rejects a completed attempt without the captured V2 source fact", async () => {
    await assert.rejects(
      runTryOnScenario(fakeUiAdapter({ includeCaptured: false }), {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /captured/i,
    );
  });

  it("将完整倒计时、动态预览和捕获顺序写成结构化业务断言", async () => {
    const outcome = await runTryOnScenario(
      fakeUiAdapter({
        observationTimeline: [
          [0, "3", "a"],
          [750, "3", "b"],
          [900, "2", "c"],
          [1_650, "2", "d"],
          [1_800, "1", "e"],
          [2_550, "1", "f"],
          [3_000, null, null, "captured"],
          [3_300, null, null, "generating"],
        ],
      }),
      {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      },
    );
    const byId = new Map(
      outcome.assertions.map((assertion) => [assertion.id, assertion]),
    );
    assert.equal(byId.get("countdown-rendered-sequence")?.status, "passed");
    assert.equal(byId.get("countdown-visible-duration")?.status, "passed");
    assert.equal(
      byId.get("countdown-protocol-dom-consistent")?.status,
      "passed",
    );
    assert.equal(byId.get("capture-after-countdown")?.status, "passed");
    assert.equal(byId.get("preview-live-through-countdown")?.status, "passed");
    assert.equal(
      byId.get("captured-frame-held-during-generation")?.status,
      "passed",
    );
    assert.deepEqual(
      outcome.supportingEvidence.find(
        (evidence) =>
          (evidence as { kind?: string }).kind ===
          "vision-countdown-visible-duration",
      ),
      {
        kind: "vision-countdown-visible-duration",
        bucketDurationsMs: { "3": 900, "2": 900, "1": 1_200 },
        totalDurationMs: 3_000,
        passed: true,
      },
    );
    assert.deepEqual(
      outcome.supportingEvidence.find(
        (evidence) =>
          (evidence as { kind?: string }).kind ===
          "vision-countdown-protocol-dom-consistency",
      ),
      {
        kind: "vision-countdown-protocol-dom-consistency",
        subchecks: {
          monotonicAtMs: true,
          holdMatchesDom: true,
          holdNonIncreasing: true,
        },
        lastOneAtMs: 2_550,
        firstHeldAtMs: 3_000,
        samples: [
          {
            atMs: 0,
            state: "acquiring",
            countdownText: "3",
            holdRemainingMs: 3_000,
          },
          {
            atMs: 750,
            state: "acquiring",
            countdownText: "3",
            holdRemainingMs: 3_000,
          },
          {
            atMs: 900,
            state: "acquiring",
            countdownText: "2",
            holdRemainingMs: 2_000,
          },
          {
            atMs: 1_650,
            state: "acquiring",
            countdownText: "2",
            holdRemainingMs: 2_000,
          },
          {
            atMs: 1_800,
            state: "acquiring",
            countdownText: "1",
            holdRemainingMs: 1_000,
          },
          {
            atMs: 2_550,
            state: "acquiring",
            countdownText: "1",
            holdRemainingMs: 1_000,
          },
          {
            atMs: 3_000,
            state: "captured",
            countdownText: null,
            holdRemainingMs: null,
          },
          {
            atMs: 3_300,
            state: "generating",
            countdownText: null,
            holdRemainingMs: null,
          },
        ],
      },
    );
  });

  it("把已解码结果 PNG 的几何判定写成业务断言", async () => {
    const passing = {
      ok: true,
      resultSleevesRetained: { expected: true, observed: true },
      resultUniformPlacement: { expected: true, observed: true },
      resultAutomaticScale: { expected: true, observed: true },
      garmentScaleRendersPixels: { expected: true, observed: true },
    };
    const outcome = await runTryOnScenario(
      fakeUiAdapter({ resultGeometryEvidence: passing }),
      {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      },
    );
    const geometry = outcome.assertions.filter((assertion) =>
      [
        "result-sleeves-retained",
        "result-uniform-placement",
        "result-automatic-scale",
        "garment-scale-renders-pixels",
      ].includes(assertion.id),
    );
    assert.equal(geometry.length, 4);
    assert.ok(geometry.every((assertion) => assertion.status === "passed"));
  });

  it("rejects a captured digest or frame identity that cannot bind the input", async () => {
    await assert.rejects(
      runTryOnScenario(
        fakeUiAdapter({ resourceDigest: `sha256:${"b".repeat(64)}` }),
        {
          timeoutMs: 2_000,
          pollMs: 10,
          acceptanceBinding: visionAcceptanceBinding,
        },
      ),
      /captured/i,
    );
    await assert.rejects(
      runTryOnScenario(fakeUiAdapter({ frameId: "" }), {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /captured/i,
    );
    await assert.rejects(
      runTryOnScenario(
        fakeUiAdapter({
          capturedReference:
            "http://127.0.0.1:99999/v2/try-on/captured/frame.png?token=captured-token",
        }),
        {
          timeoutMs: 2_000,
          pollMs: 10,
          acceptanceBinding: visionAcceptanceBinding,
        },
      ),
      /captured/i,
    );
  });

  it("rejects captured facts that are not bound to the current Vision terminal", async () => {
    await assert.rejects(
      runTryOnScenario(
        fakeUiAdapter({
          capturedReference:
            "http://127.0.0.1:7893/v2/try-on/captured/frame.png?token=captured-token",
        }),
        {
          timeoutMs: 2_000,
          pollMs: 10,
          acceptanceBinding: visionAcceptanceBinding,
        },
      ),
      /captured/i,
    );
    await assert.rejects(
      runTryOnScenario(
        fakeUiAdapter({ resourceAttemptId: alternateAttemptId }),
        {
          timeoutMs: 2_000,
          pollMs: 10,
          acceptanceBinding: visionAcceptanceBinding,
        },
      ),
      /captured/i,
    );
    await assert.rejects(
      runTryOnScenario(fakeUiAdapter({ includeCompleted: false }), {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /captured/i,
    );
    await assert.rejects(
      runTryOnScenario(
        fakeUiAdapter({ terminalAttemptId: alternateAttemptId }),
        {
          timeoutMs: 2_000,
          pollMs: 10,
          acceptanceBinding: visionAcceptanceBinding,
        },
      ),
      /captured/i,
    );
  });

  it("preserves a real V2 completed result payload in terminal evidence", async () => {
    const outcome = await runTryOnScenario(fakeUiAdapter(), {
      timeoutMs: 2_000,
      pollMs: 10,
      acceptanceBinding: visionAcceptanceBinding,
    });
    assert.equal(outcome.report.businessSets[0].status, "passed");
  });

  it("rejects missing or forged completed result evidence", async () => {
    await assert.rejects(
      runTryOnScenario(fakeUiAdapter({ terminalResult: "missing" }), {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /captured/i,
    );
    await assert.rejects(
      runTryOnScenario(fakeUiAdapter({ terminalResult: "forged" }), {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /terminal result/i,
    );
  });

  it("drives the single-path try-on journey and produces passing assertions", async () => {
    const adapter = fakeUiAdapter();
    const outcome = await runTryOnScenario(adapter, {
      timeoutMs: 2_000,
      pollMs: 10,
      acceptanceBinding: visionAcceptanceBinding,
    });
    assert.equal(outcome.assertions.length, 13);
    assert.ok(
      outcome.assertions.every((assertion) => assertion.status === "passed"),
    );
    assert.equal(outcome.report.businessSets[0].name, "visionExperience");
    assert.equal(outcome.report.businessSets[0].status, "passed");
  });

  it("缺少 observation timeline 时仍返回结构化的失败时序断言", async () => {
    const outcome = await runTryOnScenario(
      fakeUiAdapter({ observationTimeline: null }),
      {
        timeoutMs: 2_000,
        pollMs: 10,
        acceptanceBinding: visionAcceptanceBinding,
      },
    );
    const timelineAssertions = outcome.assertions.filter(
      (assertion) =>
        assertion.source === "vision-experience-observation-timeline",
    );
    assert.equal(timelineAssertions.length, 7);
    assert.equal(
      timelineAssertions.filter((assertion) => assertion.status === "failed")
        .length,
      5,
    );
    assert.equal(outcome.report.businessSets[0].status, "failed");
  });

  it("fails with a primary failure when the result surface never completes", async () => {
    const adapter = createFakeTestAdapter({
      files: {
        "ui/try-on-state.json": JSON.stringify({
          route: "#/try-on",
          state: "acquiring",
          attemptId,
        }),
      },
      commands: {
        "navigate #/catalog": () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
        'click [data-test="catalog-category"][data-category-key="tshirts"]':
          () => ({
            exitCode: 0,
            stdout: "ok",
            stderr: "",
          }),
        [`click ${selectedProductSelector}`]: async () => {
          await adapter.writeFile(
            "ui/try-on-state.json",
            JSON.stringify({
              route: selectedProductRoute,
              catalogKey: selectedCatalogKey,
              variantId: selectedVariantId,
              state: "idle",
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on"]': async () => {
          await adapter.writeFile(
            "ui/try-on-state.json",
            JSON.stringify({
              route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
              state: "acquiring",
              attemptId,
              startGarment: expectedStartGarment,
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
    });
    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /result-surface.*did not become true/,
    );
  });

  it("未进入试衣路由时在结果等待前按阶段快速失败", async () => {
    const adapter = createFakeTestAdapter({
      files: {
        "ui/try-on-state.json": JSON.stringify({
          route: "#/products/product:1",
          state: null,
          attemptId: null,
        }),
      },
      commands: {
        [`click ${selectedProductSelector}`]: async () => {
          await adapter.writeFile(
            "ui/try-on-state.json",
            JSON.stringify({
              route: selectedProductRoute,
              catalogKey: selectedCatalogKey,
              variantId: selectedVariantId,
              state: "idle",
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on"]': () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
      },
    });
    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /try-on-route.*did not become true/,
    );
  });

  it("试衣路由没有尝试标识时按尝试阶段快速失败", async () => {
    const adapter = createFakeTestAdapter({
      files: {
        "ui/try-on-state.json": JSON.stringify({
          route: "#/try-on?catalogKey=product%3A1",
          state: "idle",
          attemptId: null,
        }),
      },
      commands: {
        [`click ${selectedProductSelector}`]: async () => {
          await adapter.writeFile(
            "ui/try-on-state.json",
            JSON.stringify({
              route: selectedProductRoute,
              catalogKey: selectedCatalogKey,
              variantId: selectedVariantId,
              state: "idle",
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on"]': async () => {
          await adapter.writeFile(
            "ui/try-on-state.json",
            JSON.stringify({
              route: `#/try-on?catalogKey=${encodeURIComponent(selectedCatalogKey)}&variantId=${selectedVariantId}`,
              state: "idle",
              attemptId: null,
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
    });
    await assert.rejects(
      runTryOnScenario(adapter, {
        timeoutMs: 30,
        pollMs: 5,
        acceptanceBinding: visionAcceptanceBinding,
      }),
      /try-on-attempt.*did not become true/,
    );
  });

  it("recovers from an observer stop through the declared role boundary", async () => {
    const statePath = "ui/try-on-state.json";
    const writeState = (value: Record<string, unknown>) =>
      adapter.writeFile(statePath, JSON.stringify(value));
    const adapter = createFakeTestAdapter({
      files: {
        [statePath]: JSON.stringify({
          route: "#/catalog",
          state: "idle",
          tryOnPresent: true,
        }),
      },
      commands: {
        "stop-vision-role --role observer": async () => {
          await writeState({
            route: "#/catalog",
            state: "idle",
            tryOnPresent: false,
          });
          return { exitCode: 0, stdout: "stopped", stderr: "" };
        },
        "probe-vision-role observer": () => ({
          exitCode: 0,
          stdout: "dead",
          stderr: "",
        }),
        "navigate #/catalog": async () => {
          await writeState({
            route: "#/catalog",
            state: "idle",
            tryOnPresent: true,
          });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="catalog-category"][data-category-key="tshirts"]':
          async () => {
            await writeState({
              route: "#/catalog",
              state: "idle",
              tryOnPresent: true,
            });
            return { exitCode: 0, stdout: "ok", stderr: "" };
          },
        [`click ${selectedProductSelector}`]: async () => {
          await writeState({
            route: selectedProductRoute,
            catalogKey: selectedCatalogKey,
            variantId: selectedVariantId,
            state: "idle",
            tryOnPresent: true,
          });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on"]': async () => {
          await writeState({
            route: "#/try-on?catalogKey=product%3A1",
            state: "completed",
            tryOnPresent: true,
            preview: { naturalWidth: 720, naturalHeight: 1280 },
            resultUrl: "http://127.0.0.1:7892/v2/try-on/results/healed?token=y",
          });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
    });
    const manifest = createProcessRoleManifest({
      roles: {
        observer: {
          stopCommand: ["stop-vision-role", "--role", "observer"],
          probeCommand: ["probe-vision-role", "observer"],
        },
      },
    });
    const outcome = await runObserverSelfHealScenario(adapter, manifest, {
      timeoutMs: 2_000,
      pollMs: 10,
      acceptanceBinding: visionAcceptanceBinding,
    });
    assert.ok(
      outcome.assertions.some(
        (assertion) =>
          assertion.id === "observer-self-heal-completes" &&
          assertion.status === "passed",
      ),
    );
  });
});
