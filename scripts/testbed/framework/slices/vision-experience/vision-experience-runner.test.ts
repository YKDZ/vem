import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBusinessCheckRegistryV2 } from "../../business-check-registry-v2.ts";
import { createFakeTestAdapter } from "../../test-adapter.ts";
import { runVisionExperienceSlice } from "./vision-experience-runner.ts";

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
  const attemptId = tryOnAttemptId;
  const resultReference = `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`;
  const capturedEvidence = capturedEvidenceFor(attemptId);
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
            buyDisabled: false,
          }),
        );
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
      'click [data-test="try-on"]': async () => {
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
            resultUrl: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=y`,
          }),
        );
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  return adapter;
}

describe("visionExperience slice runner", () => {
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
    assert.equal(report.businessSets[0].assertionCount, 8);
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
