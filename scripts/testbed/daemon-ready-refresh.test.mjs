import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.mjs";

describe("daemon ready refresh", () => {
  it("replaces a stale handoff only after the current generation is reachable", async () => {
    const handoff = {
      daemon: {
        ready: {
          healthzUrl: "http://127.0.0.1:1/healthz",
          ipcToken: "stale",
          generation: "stale-generation",
        },
      },
    };
    let reads = 0;
    const ready = await waitForDaemonReadyRefresh(handoff, {
      timeoutMs: 1_000,
      pollMs: 1,
      stableMs: 0,
      readReady: () => {
        reads += 1;
        return reads === 1
          ? handoff.daemon.ready
          : {
              healthzUrl: "http://127.0.0.1:7615/healthz",
              ipcToken: "current",
              generation: "current-generation",
            };
      },
      fetchHealth: async (candidate) => ({
        ok: candidate.generation === "current-generation",
        status: candidate.generation === "current-generation" ? 200 : 503,
      }),
    });

    assert.equal(ready.generation, "current-generation");
    assert.equal(handoff.daemon.ready.ipcToken, "current");
    assert.equal(reads, 2);
  });
});
