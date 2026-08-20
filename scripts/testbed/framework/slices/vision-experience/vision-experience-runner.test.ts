import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBusinessCheckRegistryV2 } from "../../business-check-registry-v2.ts";
import { createFakeTestAdapter } from "../../test-adapter.ts";
import {
  sourceGarmentBindingFromGuestInput,
  runVisionExperienceSlice,
} from "./vision-experience-runner.ts";

const tryOnAttemptId = "550e8400-e29b-41d4-a716-446655440124";

function capturedEvidenceFor(attemptId: string) {
  const visionOrigin = "http://127.0.0.1:7892";
  const requestId = "vision-websocket-1";
  const captured = {
    reference: `${visionOrigin}/v2/try-on/captured/frame.png?token=captured-token`,
    digest: `sha256:${"a".repeat(64)}`,
    contentType: "image/png" as const,
    byteSize: 4096,
    width: 720,
    height: 1280,
    frameId: "frame-000042",
  };
  const result = {
    reference: `${visionOrigin}/v2/try-on/results/${attemptId}?token=result-token`,
    digest: `sha256:${"b".repeat(64)}`,
    contentType: "image/png" as const,
    byteSize: 8192,
    width: 720,
    height: 1280,
  };
  return {
    visionOrigin,
    protocolTimeline: [
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
      {
        type: "vision.try_on.attempt.completed",
        requestId,
        origin: visionOrigin,
        payload: { attemptId, result },
      },
    ],
    capturedResource: {
      attemptId,
      capturedDigest: captured.digest,
      capturedFrameId: captured.frameId,
      visionOrigin,
      reference: captured.reference,
      finalUrl: captured.reference,
      ok: true,
      httpStatus: 200,
      contentType: "image/png" as const,
      byteSize: captured.byteSize,
      digest: captured.digest,
      width: captured.width,
      height: captured.height,
    },
  };
}

function fakeUiAdapter() {
  const statePath = "ui/try-on-state.json";
  let selectedSegment: "far" | "mid" | "near" = "mid";
  const segmentScale = { far: 0.8, mid: 1, near: 1.2 } as const;
  const segmentAttemptId = {
    far: "550e8400-e29b-41d4-a716-446655440121",
    mid: tryOnAttemptId,
    near: "550e8400-e29b-41d4-a716-446655440123",
  } as const;
  const resultPng = (scale: number) => ({
    width: 720,
    height: 1280,
    leftSleevePixels: 120,
    torsoPixels: 1_200,
    rightSleevePixels: 120,
    garment: {
      x: 360 - Math.round(100 * scale) / 2,
      y: 640 - Math.round(125 * scale) / 2,
      width: Math.round(100 * scale),
      height: Math.round(125 * scale),
      centerX: 359.5,
      centerY: 639.5,
      aspect: 0.8,
    },
  });
  const sourceGarmentMetadata = {
    reference:
      "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
    origin: "http://127.0.0.1:26849",
    assetId: "550e8400-e29b-41d4-a716-446655440126",
    digest: `sha256:${"a".repeat(64)}`,
    contentType: "image/png" as const,
    byteSize: 12,
    template: "tshirt_short_sleeve" as const,
    width: 512,
    height: 640,
  };
  const startGarment = {
    assetId: sourceGarmentMetadata.assetId,
    reference: "http://127.0.0.1:7892/media/garment?token=source-token",
    digest: sourceGarmentMetadata.digest,
    contentType: sourceGarmentMetadata.contentType,
    byteSize: sourceGarmentMetadata.byteSize,
    template: sourceGarmentMetadata.template,
  };
  const adapter = createFakeTestAdapter({
    files: {
      [statePath]: JSON.stringify({ route: "#/catalog", state: "idle" }),
    },
    commands: {
      "vision-ready": () => ({ exitCode: 0, stdout: "ready", stderr: "" }),
      "select-recorded-video-fixture far": () => {
        selectedSegment = "far";
        return { exitCode: 0, stdout: "far", stderr: "" };
      },
      "select-recorded-video-fixture mid": () => {
        selectedSegment = "mid";
        return { exitCode: 0, stdout: "mid", stderr: "" };
      },
      "select-recorded-video-fixture near": () => {
        selectedSegment = "near";
        return { exitCode: 0, stdout: "near", stderr: "" };
      },
      "navigate #/catalog": () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      'click [data-test="catalog-category"][data-category-key="tshirts"]':
        async () => {
          await adapter.writeFile(
            statePath,
            JSON.stringify({ route: "#/catalog", state: "idle" }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      'click [data-test="catalog-product"]': async () => {
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            route: "#/products/product:1",
            state: "idle",
            tryOnPresent: true,
            buyDisabled: false,
          }),
        );
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      'click [data-test="try-on"]': async () => {
        const attemptId = segmentAttemptId[selectedSegment];
        const resultReference = `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`;
        const capturedEvidence = capturedEvidenceFor(attemptId);
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            route: "#/try-on?catalogKey=product%3A1",
            state: "acquiring",
            attemptId,
            preview: { naturalWidth: 720, naturalHeight: 1280 },
          }),
        );
        setTimeout(() => {
          void adapter.writeFile(
            statePath,
            JSON.stringify({
              route: "#/try-on?catalogKey=product%3A1",
              state: "completed",
              attemptId,
              preview: { naturalWidth: 720, naturalHeight: 1280 },
              resultUrl: resultReference,
              resultPng: resultPng(segmentScale[selectedSegment]),
              sourceGarmentPng: resultPng(1),
              sourceGarmentMetadata,
              startGarment,
              ...capturedEvidence,
            }),
          );
        }, 50);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      'click [data-test="try-on-scale-up"]': async () => {
        const current = JSON.parse(await adapter.readFile(statePath));
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            ...current,
            scaleValue: "105%",
            resultUrl: `http://127.0.0.1:7892/v2/try-on/results/${current.attemptId}?token=105`,
            resultPng: resultPng(1.05),
            adjustmentEvidence: {
              scales: [1.05],
              results: [
                {
                  reference: `http://127.0.0.1:7892/v2/try-on/results/${current.attemptId}?token=105`,
                },
              ],
            },
          }),
        );
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  return adapter;
}

describe("visionExperience slice runner", () => {
  it("从实际 guest-input 的 runtime bootstrap 派生 Service API 规范来源", () => {
    const sourceGarment = {
      publicPath:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
      assetId: "550e8400-e29b-41d4-a716-446655440126",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png",
      byteSize: 12,
      template: "tshirt_short_sleeve",
      width: 512,
      height: 640,
    };
    assert.deepEqual(
      sourceGarmentBindingFromGuestInput({
        schemaVersion: "vem-local-testbed-guest-input/v1",
        runtimeBootstrap: {
          provisioningApiBaseUrl: "http://10.0.0.15:26849/api",
        },
        visionAcceptance: { sourceGarment },
      }),
      {
        sourceGarmentMetadata: {
          ...sourceGarment,
          reference:
            "http://10.0.0.15:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
          origin: "http://10.0.0.15:26849",
        },
        sourceGarmentServiceApiOrigin: "http://10.0.0.15:26849",
      },
    );
  });

  it("拒绝把 host loopback 的 source garment 带进 guest", () => {
    assert.deepEqual(
      sourceGarmentBindingFromGuestInput({
        runtimeBootstrap: {
          provisioningApiBaseUrl: "http://10.0.0.15:26849/api",
        },
        visionAcceptance: {
          sourceGarment: {
            publicPath:
              "http://127.0.0.1:26849/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
          },
        },
      }),
      { sourceGarmentMetadata: null, sourceGarmentServiceApiOrigin: null },
    );
  });

  it("从三次结果资源与同一 attempt 的 100/105 资源生成几何业务断言", async () => {
    const report = await runVisionExperienceSlice({
      adapter: fakeUiAdapter(),
      includeGarmentScale: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    const ids =
      report.businessSets[0].assertions?.map((assertion) => assertion.id) ?? [];
    assert.ok(ids.includes("result-sleeves-retained"));
    assert.ok(ids.includes("garment-scale-renders-pixels"));
    assert.equal(report.businessSets[0].status, "passed");
  });

  it("三段受控录播缺失时保留结构化 fail-closed 几何诊断", async () => {
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "select-recorded-video-fixture") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "候选未提供动态 far/mid/near 录播夹具",
        };
      }
      return originalRun(command, args);
    };
    const report = await runVisionExperienceSlice({
      adapter,
      includeGarmentScale: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    const set = report.businessSets[0];
    assert.equal(set.status, "failed");
    assert.equal(
      set.assertions?.find(
        (assertion) => assertion.id === "result-automatic-scale",
      )?.status,
      "failed",
    );
    assert.deepEqual(set.supportingEvidence.at(-1), {
      kind: "vision-recorded-geometry-fixture",
      status: "blocked",
      reason: "候选未提供动态 far/mid/near 录播夹具",
      segments: ["far"],
    });
  });

  it("produces a registry-validated passed report", async () => {
    const registry = createBusinessCheckRegistryV2([
      {
        name: "visionExperience",
        fullRequired: true,
        runner: { kind: "node", script: "vision-experience-runner.ts" },
        validator: (set) => ({
          ok: set.status === "passed",
          errors: set.status === "failed" ? ["vision assertions failed"] : [],
        }),
      },
    ]);
    const adapter = fakeUiAdapter();
    const report = await runVisionExperienceSlice({
      adapter,
      includeGarmentScale: true,
      includeDegradation: true,
      stopOwner: async () => {
        const current = JSON.parse(
          await adapter.readFile("ui/try-on-state.json"),
        );
        await adapter.writeFile(
          "ui/try-on-state.json",
          JSON.stringify({
            ...current,
            tryOnPresent: false,
            buyDisabled: false,
          }),
        );
      },
      timeoutMs: 2_000,
      pollMs: 10,
    });
    const result = registry.validateReport(report);
    assert.equal(result.businessSets.visionExperience.status, "passed");
    assert.equal(report.businessSets[0].assertionCount, 13);
  });

  it("waits for a stable Vision role PID set before starting the flow", async () => {
    let readyPolls = 0;
    let navigateCalls = 0;
    const adapter = fakeUiAdapter();
    const originalRun = adapter.run.bind(adapter);
    adapter.run = async (command, args = []) => {
      if (command === "navigate") navigateCalls += 1;
      if (command === "vision-ready") {
        readyPolls += 1;
        if (readyPolls <= 2) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({ ready: false, pids: [100 + readyPolls] }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ready: true, pids: [999, 1000] }),
          stderr: "",
        };
      }
      return originalRun(command, args);
    };
    const report = await runVisionExperienceSlice({
      adapter,
      includeGarmentScale: false,
      visionStabilityMs: 40,
      visionStabilityTimeoutMs: 2_000,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(report.businessSets[0].status, "passed");
    assert.equal(navigateCalls, 1);
    assert.ok(
      readyPolls >= 4,
      `expected multiple readiness polls, got ${readyPolls}`,
    );
  });

  it("covers manual capture and departure cancellation", async () => {
    const statePath = "ui/try-on-state.json";
    const attemptId = tryOnAttemptId;
    const capturedEvidence = capturedEvidenceFor(attemptId);
    let tryOnEntries = 0;
    const adapter = createFakeTestAdapter({
      files: {
        [statePath]: JSON.stringify({ route: "#/catalog", state: "idle" }),
      },
      commands: {
        "vision-ready": () => ({ exitCode: 0, stdout: "ready", stderr: "" }),
        "navigate #/catalog": () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
        'click [data-test="catalog-category"][data-category-key="tshirts"]':
          async () => {
            await adapter.writeFile(
              statePath,
              JSON.stringify({ route: "#/catalog", state: "idle" }),
            );
            return { exitCode: 0, stdout: "ok", stderr: "" };
          },
        'click [data-test="catalog-product"]': async () => {
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              route: "#/products/product:1",
              state: "idle",
              tryOnPresent: true,
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on"]': async () => {
          tryOnEntries += 1;
          if (tryOnEntries === 1) {
            await adapter.writeFile(
              statePath,
              JSON.stringify({
                route: "#/try-on?catalogKey=product%3A1",
                state: "acquiring",
                attemptId,
                preview: { naturalWidth: 720, naturalHeight: 1280 },
              }),
            );
            setTimeout(() => {
              void adapter.writeFile(
                statePath,
                JSON.stringify({
                  route: "#/try-on?catalogKey=product%3A1",
                  state: "completed",
                  attemptId,
                  preview: { naturalWidth: 720, naturalHeight: 1280 },
                  resultUrl: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`,
                  ...capturedEvidence,
                }),
              );
            }, 50);
            return { exitCode: 0, stdout: "ok", stderr: "" };
          }
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              route: "#/try-on?catalogKey=product%3A1",
              state: "acquiring",
              manualCaptureAllowed: true,
              guidance: "请保持不动，3 秒后自动拍摄",
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on-manual-capture"]': async () => {
          const current = JSON.parse(await adapter.readFile(statePath));
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              ...current,
              state: "completed",
              manualCaptureAllowed: false,
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        "simulate-departure": async () => {
          const current = JSON.parse(await adapter.readFile(statePath));
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              ...current,
              state: "canceled",
              phaseText: "检测到顾客已离开，本次试衣已取消",
            }),
          );
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
      },
    });
    const report = await runVisionExperienceSlice({
      adapter,
      includeManualCapture: true,
      includeDeparture: true,
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(report.businessSets[0].status, "passed");
    assert.equal(report.businessSets[0].assertionCount, 7);
  });
});
