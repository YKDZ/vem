import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { condition, waitForCondition } from "./condition-waiter.ts";

describe("bounded condition waiter", () => {
  it("returns the value when the predicate becomes ok", async () => {
    let attempts = 0;
    const value = await waitForCondition(
      "counter",
      () => {
        attempts += 1;
        return condition(attempts >= 2, `attempt-${attempts}`);
      },
      { timeoutMs: 1_000, pollMs: 5 },
    );
    assert.equal(value, "attempt-2");
  });

  it("throws with the last observation after the deadline", async () => {
    await assert.rejects(
      waitForCondition("never", () => condition(false, { seen: 3 }), {
        timeoutMs: 20,
        pollMs: 5,
      }),
      /never did not become true.*"seen":3/,
    );
  });

  it("rejects non-positive budgets instead of hiding a driver mistake", async () => {
    await assert.rejects(
      waitForCondition("bad budget", () => condition(true), {
        timeoutMs: 0,
      }),
      /timeoutMs must be a positive finite number/,
    );
  });

  it("stops early when the abort signal fires", async () => {
    const controller = new AbortController();
    const wait = waitForCondition("aborted", () => condition(false), {
      timeoutMs: 1_000,
      pollMs: 5,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(wait, /aborted/);
  });
});
