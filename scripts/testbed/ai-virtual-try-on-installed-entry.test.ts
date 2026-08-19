import assert from "node:assert/strict";
import { test } from "node:test";

import { startVmAiActiveHeartbeatForTest } from "./ai-virtual-try-on-installed-entry.ts";

function heartbeatClient(handler) {
  const sends = [];
  return {
    sends,
    async send(method, params, options) {
      sends.push({ method, params, options });
      return handler({ method, params, options });
    },
  };
}

function timedInterval(ms) {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  const timer = setTimeout(resolve, ms);
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      resolve();
    },
  };
}

test("AI keepalive heartbeat is best-effort and never fails the acceptance", async () => {
  process.env.NODE_ENV = "test";
  try {
    const failures = [];
    const client = heartbeatClient(() => Promise.reject(new Error("busy")));
    const heartbeat = startVmAiActiveHeartbeatForTest(client, {
      intervalMs: 5,
      retryIntervalMs: 2,
      sendTimeoutMs: 1_000,
      waitForInterval: (ms) => timedInterval(ms),
      onFailure: (error) => failures.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await heartbeat.stop();
    assert.ok(failures.length > 0, "keepalive failures must be recorded");
    assert.equal(failures[0].message, "busy");
  } finally {
    delete process.env.NODE_ENV;
  }
});

test("AI keepalive heartbeat uses mouse events with a generous send timeout", async () => {
  process.env.NODE_ENV = "test";
  try {
    const failures = [];
    const client = heartbeatClient(() => Promise.resolve({}));
    const heartbeat = startVmAiActiveHeartbeatForTest(client, {
      intervalMs: 5,
      retryIntervalMs: 2,
      sendTimeoutMs: 30_000,
      waitForInterval: (ms) => timedInterval(ms),
      onFailure: (error) => failures.push(error),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await heartbeat.stop();
    assert.ok(client.sends.length >= 2, "expected at least one completed beat");
    const pressed = client.sends.find(
      (entry) =>
        entry.method === "Input.dispatchMouseEvent" &&
        entry.params.type === "mousePressed",
    );
    const released = client.sends.find(
      (entry) =>
        entry.method === "Input.dispatchMouseEvent" &&
        entry.params.type === "mouseReleased",
    );
    assert.ok(pressed, "keepalive must press with a mouse event");
    assert.ok(released, "keepalive must release with a mouse event");
    assert.equal(pressed.params.x, 540);
    assert.equal(pressed.params.y, 960);
    assert.equal(pressed.options.timeoutMs, 30_000);
    assert.equal(failures.length, 0);
  } finally {
    delete process.env.NODE_ENV;
  }
});
