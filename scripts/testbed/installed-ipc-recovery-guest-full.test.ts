import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { jsonOnlyPowerShellCommand } from "./installed-ipc-recovery-guest-full.ts";

describe("installed IPC recovery guest full runner", () => {
  it("keeps auxiliary PowerShell streams out of the JSON stdout channel", () => {
    const command = jsonOnlyPowerShellCommand(
      'Write-Warning "service is stopping"; [Console]::Out.WriteLine("{}")',
    );

    assert.match(command, /\$ProgressPreference = 'SilentlyContinue'/);
    assert.match(command, /3>\$null 4>\$null 5>\$null 6>\$null$/);
    assert.match(command, /\[Console\]::Out\.WriteLine\("\{\}"\)/);
  });

  it("retries daemon transport interruption when the recovery overlay is missed", () => {
    const source = readFileSync(
      new URL("./installed-ipc-recovery-guest-full.ts", import.meta.url),
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
