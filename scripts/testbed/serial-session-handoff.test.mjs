import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.mjs";

const guestInput = {
  runId: "RUN-HANDOFF",
  machineCode: "VEM-HANDOFF",
  hostControlPlane: {
    targetIdentity: "vm-target://handoff",
    runtimeBaseIdentity: "runtime-base://handoff",
  },
};

describe("serial session handoff", () => {
  it("does not start a replacement when abort lacks authoritative confirmation", async () => {
    const calls = [];
    await assert.rejects(
      () =>
        replaceSerialSessionAndUpdateHandoff({
          guestInput,
          handoff: { commissioningSerialSession: { sessionId: "serial-old" } },
          handoffPath: "C:\\handoff.json",
          sessionId: "serial-old",
          control: async (_input, path) => {
            calls.push(path);
            return { aborted: false };
          },
          writeJsonFile: () => {
            throw new Error("handoff must not be written");
          },
        }),
      /serial session abort did not confirm inactive state/,
    );
    assert.deepEqual(calls, ["/v1/serial-sessions/serial-old/abort"]);
  });

  it("aborts the fresh session when handoff persistence fails", async () => {
    const calls = [];
    const handoff = { commissioningSerialSession: { sessionId: "serial-old" } };
    await assert.rejects(
      () =>
        replaceSerialSessionAndUpdateHandoff({
          guestInput,
          handoff,
          handoffPath: "C:\\handoff.json",
          sessionId: "serial-old",
          control: async (_input, path) => {
            calls.push(path);
            if (path.endsWith("/serial-old/abort")) return { aborted: true };
            if (path.endsWith("/start")) return { sessionId: "serial-fresh" };
            assert.equal(path, "/v1/serial-sessions/serial-fresh/abort");
            return { aborted: true };
          },
          writeJsonFile: () => {
            throw new Error("disk full");
          },
        }),
      /disk full/,
    );
    assert.deepEqual(calls, [
      "/v1/serial-sessions/serial-old/abort",
      "/v1/serial-sessions/start",
      "/v1/serial-sessions/serial-fresh/abort",
    ]);
    assert.equal(handoff.commissioningSerialSession.sessionId, "serial-old");
  });
});
