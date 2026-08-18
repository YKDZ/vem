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
      "navigate #/catalog": () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      'click [data-test="catalog-category"][data-category-key="tshirts"]':
        () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      'click [data-test="catalog-product"]': () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      }),
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
    const report = await runVisionExperienceSlice({
      adapter: fakeUiAdapter(),
      timeoutMs: 2_000,
      pollMs: 10,
    });
    const result = registry.validateReport(report);
    assert.equal(result.businessSets.visionExperience.status, "passed");
  });
});
