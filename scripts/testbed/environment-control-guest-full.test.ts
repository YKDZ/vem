import assert from "node:assert/strict";
import test from "node:test";

import { serialProtocolFrames } from "./environment-control-guest-full.ts";

test("deduplication ignores ambient and inbound frames but detects an emitted command", () => {
  const cursor = {
    frameCount: 1,
    lastSequence: 5,
    lastCapturedAt: "2026-08-25T00:00:00.000Z",
    lastIdentity: "before",
  };
  const ambientEvidence = {
    rawFrames: [
      {
        sequence: 6,
        direction: "controller-to-daemon",
        parsedOpcode: "AA",
      },
      {
        sequence: 7,
        direction: "controller-to-daemon",
        parsedOpcode: "B3",
      },
    ],
  };

  assert.deepEqual(serialProtocolFrames(ambientEvidence, cursor, "B3"), []);
  assert.deepEqual(
    serialProtocolFrames(
      {
        rawFrames: [
          ...ambientEvidence.rawFrames,
          {
            sequence: 8,
            direction: "daemon-to-controller",
            parsedOpcode: "B3",
          },
        ],
      },
      cursor,
      "B3",
    ),
    ["B3"],
  );
});
