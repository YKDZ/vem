import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProcessRoleManifest } from "../../fault-injection.ts";
import { createFakeTestAdapter } from "../../test-adapter.ts";
import {
  runFastTryOnScenario,
  runObserverSelfHealScenario,
} from "./vision-experience-driver.ts";

function fakeUiAdapter() {
  const statePath = "ui/try-on-state.json";
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
          route: "#/products/product:1",
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
      'click [data-test="try-on-fast"]': async () => {
        await writeState({
          route: "#/try-on?catalogKey=product%3A1&mode=fast",
          state: "acquiring",
          preview: { naturalWidth: 720, naturalHeight: 1280 },
        });
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
        }, 100);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
  });
  return adapter;
}

describe("visionExperience vertical slice driver", () => {
  it("drives the fast try-on journey and produces passing assertions", async () => {
    const adapter = fakeUiAdapter();
    const outcome = await runFastTryOnScenario(adapter, {
      timeoutMs: 2_000,
      pollMs: 10,
    });
    assert.equal(outcome.assertions.length, 3);
    assert.ok(
      outcome.assertions.every((assertion) => assertion.status === "passed"),
    );
    assert.equal(outcome.report.businessSets[0].name, "visionExperience");
    assert.equal(outcome.report.businessSets[0].status, "passed");
  });

  it("fails with a primary failure when the result surface never completes", async () => {
    const adapter = createFakeTestAdapter({
      files: {
        "ui/try-on-state.json": JSON.stringify({
          route: "#/try-on",
          state: "acquiring",
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
        'click [data-test="catalog-product"]': () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
        'click [data-test="try-on-fast"]': () => ({
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        }),
      },
    });
    await assert.rejects(
      runFastTryOnScenario(adapter, { timeoutMs: 30, pollMs: 5 }),
      /result-surface.*did not become true/,
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
        'click [data-test="catalog-product"]': async () => {
          await writeState({
            route: "#/products/product:1",
            state: "idle",
            tryOnPresent: true,
          });
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        'click [data-test="try-on-fast"]': async () => {
          await writeState({
            route: "#/try-on?catalogKey=product%3A1&mode=fast",
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
