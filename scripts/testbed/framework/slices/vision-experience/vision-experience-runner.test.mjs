import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBusinessCheckRegistryV2 } from "../../business-check-registry-v2.mjs";
import { createFakeTestAdapter } from "../../test-adapter.mjs";
import { runVisionExperienceSlice } from "./vision-experience-runner.mjs";

function fakeUiAdapter() {
  const statePath = "ui/try-on-state.json";
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
      'click [data-test="try-on-fast"]': async () => {
        await adapter.writeFile(
          statePath,
          JSON.stringify({
            route: "#/try-on?catalogKey=product%3A1&mode=fast",
            state: "acquiring",
            preview: { naturalWidth: 720, naturalHeight: 1280 },
          }),
        );
        setTimeout(() => {
          void adapter.writeFile(
            statePath,
            JSON.stringify({
              route: "#/try-on?catalogKey=product%3A1&mode=fast",
              state: "completed",
              preview: { naturalWidth: 720, naturalHeight: 1280 },
              resultUrl:
                "http://127.0.0.1:7892/v2/try-on/results/attempt-1?token=x",
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
            resultUrl:
              "http://127.0.0.1:7892/v2/try-on/results/attempt-1?token=y",
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
        runner: { kind: "node", script: "vision-experience-runner.mjs" },
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
    assert.equal(report.businessSets[0].assertionCount, 7);
  });

  it("covers manual capture and departure cancellation", async () => {
    const statePath = "ui/try-on-state.json";
    let fastEntries = 0;
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
        'click [data-test="try-on-fast"]': async () => {
          fastEntries += 1;
          if (fastEntries === 1) {
            await adapter.writeFile(
              statePath,
              JSON.stringify({
                route: "#/try-on?catalogKey=product%3A1&mode=fast",
                state: "acquiring",
                preview: { naturalWidth: 720, naturalHeight: 1280 },
              }),
            );
            setTimeout(() => {
              void adapter.writeFile(
                statePath,
                JSON.stringify({
                  route: "#/try-on?catalogKey=product%3A1&mode=fast",
                  state: "completed",
                  preview: { naturalWidth: 720, naturalHeight: 1280 },
                  resultUrl:
                    "http://127.0.0.1:7892/v2/try-on/results/attempt-1?token=x",
                }),
              );
            }, 50);
            return { exitCode: 0, stdout: "ok", stderr: "" };
          }
          await adapter.writeFile(
            statePath,
            JSON.stringify({
              route: "#/try-on?catalogKey=product%3A1&mode=fast",
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
    assert.equal(report.businessSets[0].assertionCount, 6);
  });
});
