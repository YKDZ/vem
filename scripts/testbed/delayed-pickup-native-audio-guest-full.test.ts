import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  REQUIRED_TRANSACTION_AUDIO_PREFERENCES,
  restoreTransactionAudioPreferences,
} from "./delayed-pickup-native-audio-guest-full.ts";
import { CdpClient } from "./machine-ui-cdp-driver.ts";

type JsonRecord = Record<string, unknown>;

describe("delayed pickup guest full runner", () => {
  it("restores transaction audio preferences before returning to catalog", async () => {
    const calls: unknown[] = [];
    const client = {} as unknown as InstanceType<typeof CdpClient>;

    const restored = await restoreTransactionAudioPreferences(client, {
      async setMachineUiAudioPreferences(
        actualClient: unknown,
        preferences: JsonRecord,
      ) {
        calls.push(["set", actualClient, preferences]);
        return { ...preferences };
      },
      async evaluateExpression(actualClient: unknown, expression: string) {
        calls.push(["eval", actualClient, expression]);
      },
      async waitForRoute(
        actualClient: unknown,
        route: string,
        options: JsonRecord = {},
      ) {
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
      new URL("./delayed-pickup-native-audio-guest-full.ts", import.meta.url),
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
