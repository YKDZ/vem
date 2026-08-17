import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("installed IPC recovery guest full runner", () => {
  it("retries daemon transport interruption when the recovery overlay is missed", () => {
    const source = readFileSync(
      new URL("./installed-ipc-recovery-guest-full.mjs", import.meta.url),
      "utf8",
    );
    const interruption = source.slice(
      source.indexOf(
        "async function interruptDaemonTransportAndObserveOverlay",
      ),
      source.indexOf("export async function runInstalledIpcRecoveryGuest"),
    );
    assert.match(interruption, /attempts = 2/);
    assert.match(interruption, /overlayTimeoutMs = 45_000/);
    assert.match(
      interruption,
      /phase: "recover"[\s\S]*waitForDaemonReadyRefresh\(handoff\)/,
    );
    assert.match(
      source,
      /interruptDaemonTransportAndObserveOverlay\(\{[\s\S]*handoff,[\s\S]*client,[\s\S]*screenshotSink,[\s\S]*session,[\s\S]*\}\)/,
    );
  });
});
