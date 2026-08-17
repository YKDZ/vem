import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  REQUIRED_TRANSACTION_AUDIO_PREFERENCES,
  restoreTransactionAudioPreferences,
} from "./delayed-pickup-native-audio-guest-full.mjs";

describe("delayed pickup guest full runner", () => {
  it("restores transaction audio preferences before returning to catalog", async () => {
    const calls = [];
    const client = { id: "client-17" };

    const restored = await restoreTransactionAudioPreferences(client, {
      async setMachineUiAudioPreferences(actualClient, preferences) {
        calls.push(["set", actualClient, preferences]);
        return { ...preferences };
      },
      async evaluateExpression(actualClient, expression) {
        calls.push(["eval", actualClient, expression]);
      },
      async waitForRoute(actualClient, route, options) {
        calls.push(["wait", actualClient, route, options]);
      },
    });

    assert.deepEqual(restored, REQUIRED_TRANSACTION_AUDIO_PREFERENCES);
    assert.deepEqual(calls, [
      ["set", client, REQUIRED_TRANSACTION_AUDIO_PREFERENCES],
      ["eval", client, 'location.hash = "#/catalog"'],
      [
        "wait",
        client,
        "#/catalog",
        {
          timeoutMs: 30_000,
          pollMs: 250,
        },
      ],
    ]);
  });

  it("gives pending-order cleanup a budget covering cancel and catalog return", () => {
    const source = readFileSync(
      new URL("./delayed-pickup-native-audio-guest-full.mjs", import.meta.url),
      "utf8",
    );
    const pendingOrderCleanup = source.slice(
      source.indexOf('await cleanupFailClosed(\n      "pending-order"'),
      source.indexOf('await cleanupFailClosed("audio-capture"'),
    );
    assert.match(pendingOrderCleanup, /timeoutMs: 30_000/);
    assert.match(pendingOrderCleanup, /60_000/);
  });
});
