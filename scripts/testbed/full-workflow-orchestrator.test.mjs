import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  returnToCatalogFromClient,
  FULL_WORKFLOW_TRACK_DESCRIPTORS,
  runSerialTrackLifecycle,
} from "./full-workflow-orchestrator.mjs";

describe("full workflow serial lifecycle", () => {
  it("owns the fixed full order, artifacts, fixture allocations, and result-specific evidence policy in one table", () => {
    assert.deepEqual(
      FULL_WORKFLOW_TRACK_DESCRIPTORS.map((track) => track.key),
      [
        "fast",
        "scanner",
        "visionTryOn",
        "fulfillmentFailure",
        "delayedPickup",
        "ipcRecovery",
      ],
    );
    assert.deepEqual(
      FULL_WORKFLOW_TRACK_DESCRIPTORS.map((track) => track.fixtureKey),
      [
        "fast",
        "scanner",
        "visionTryOn",
        "fulfillmentFailure",
        "delayedPickup",
        "ipcRecovery",
      ],
    );
    for (const track of FULL_WORKFLOW_TRACK_DESCRIPTORS) {
      assert.match(track.reportFileName, /\.json$/);
      assert.match(track.artifactDirectory, /artifacts$/);
      assert.equal(track.evidence.passed.screenshot, true);
      assert.equal(track.evidence.failed.primaryReason, true);
      assert.equal(track.evidence.failed.diagnostic, true);
      assert.equal(track.evidence.failed.screenshot, false);
    }
  });

  it("captures and judges each terminal state before bounded recovery while continuing after a failure", async () => {
    const calls = [];
    const tracks = FULL_WORKFLOW_TRACK_DESCRIPTORS.slice(0, 2);
    const result = await runSerialTrackLifecycle({
      tracks,
      now: (() => {
        let value = 0;
        return () => new Date(`2026-07-19T00:00:0${value++}.000Z`);
      })(),
      runTrack(track) {
        calls.push(`run:${track.key}`);
        return {
          status: track.key === "fast" ? "failed" : "passed",
          exitCode: track.key === "fast" ? 1 : 0,
          stdout: "child output",
          stderr: track.key === "fast" ? "primary failure" : "",
          report: { ok: track.key !== "fast" },
        };
      },
      async captureTerminal(track) {
        calls.push(`terminal:${track.key}`);
        return {
          ok: track.key !== "fast",
          facts: { route: "#/result/failure" },
          reason:
            track.key === "fast" ? "terminal route is not recoverable" : null,
        };
      },
      async recover(track) {
        calls.push(`recover:${track.key}`);
        return { ok: true, actions: ["returnToCatalog"] };
      },
    });

    assert.deepEqual(calls, [
      "run:fast",
      "terminal:fast",
      "recover:fast",
      "run:scanner",
      "terminal:scanner",
      "recover:scanner",
    ]);
    assert.equal(result[0].businessStatus, "failed");
    assert.equal(result[0].failureStage, "child");
    assert.equal(result[0].terminal.ok, false);
    assert.equal(result[0].handoffRecovery.ok, true);
    assert.equal(result[1].businessStatus, "passed");
    assert.equal(result[1].durationMs, 1_000);
    assert.equal(result[1].handoffRecovery.durationMs, 1_000);
  });

  it("returns from payment route via customer cancel entry then back to catalog", async () => {
    const calls = [];
    const routeIdentity = { route: "#/catalog" };
    const routeByRoute = new Map([
      ["PAYMENT_RETURN", "#/catalog"],
    ]);
    const result = await returnToCatalogFromClient({
      client: { id: "client" },
      evaluateExpressionFn: async () => "#/payment",
      activateVisibleSelectorFn: async (_client, selector) => {
        calls.push(selector);
        if (selector === '[data-test="payment-cancel"]:not(:disabled)') {
          return { selector };
        }
      },
      waitForRouteFn: async (_client, expected) => {
        calls.push(`wait:${expected.source || expected}`);
        return { route: routeByRoute.get("PAYMENT_RETURN") };
      },
    });
    assert.equal(result, routeIdentity.route);
    assert.deepEqual(calls, [
      '[data-test="payment-cancel"]:not(:disabled)',
      "wait:^(?:#\\/catalog|#\\/result(?:\\/|$)|#\\/checkout|#\\/products(?:\\/|$))",
    ]);
  });

  it("reports payment cancellation failure when the payment-cancel control is disabled", async () => {
    await assert.rejects(
      returnToCatalogFromClient({
        client: { id: "client" },
        evaluateExpressionFn: async () => "#/payment",
        activateVisibleSelectorFn: async () => {
          throw new Error("payment-cancel control is disabled");
        },
        waitForRouteFn: async () => ({ route: "#/catalog" }),
      }),
      /payment-cancel control is disabled/,
    );
  });
});
