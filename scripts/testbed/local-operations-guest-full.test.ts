import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { waitForRawSerialFrame } from "./host-serial-control-plane.ts";
import {
  buildInstalledDaemonRestartScript,
  restartInstalledDaemon,
  serialBoundaryWaitRequest,
} from "./local-operations-guest-full.ts";

test("a later environment boundary is scoped after completed dispense evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-local-operations-serial-"));
  const journalPath = join(root, "serial.log");
  writeFileSync(journalPath, "> 2026/08/25 00:00:00.000 length=2\n55 f2\n");
  const appendB3 = setTimeout(() => {
    appendFileSync(
      journalPath,
      "< 2026/08/25 00:00:00.100 length=3\n55 b3 03\n",
    );
  }, 20);

  try {
    const boundary = await waitForRawSerialFrame({
      journalPath,
      parsedOpcode: "B3",
      afterSequence: 1,
      timeoutMs: 500,
      pollMs: 5,
    });
    assert.equal(boundary.frame?.parsedOpcode, "B3");
    assert.deepEqual(
      serialBoundaryWaitRequest("B3", {
        rawFrames: [{ sequence: 1, parsedOpcode: "F2" }],
      }),
      { parsedOpcode: "B3", timeoutMs: 30_000, afterSequence: 1 },
    );
  } finally {
    clearTimeout(appendB3);
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon-only restart leaves Machine UI ownership untouched", () => {
  const script = buildInstalledDaemonRestartScript({
    daemonPath: "C:\\VEM\\bringup\\vending-daemon.exe",
    daemonDataDirectory: "C:\\ProgramData\\VEM\\vending-daemon",
  });

  assert.match(script, /VemVendingDaemon/);
  assert.match(script, /vending-daemon\.exe/);
  assert.doesNotMatch(script, /machine\.exe/);
  assert.doesNotMatch(script, /VEMMachineUI/);
  assert.doesNotMatch(script, /ScheduledTask/);
});

test("daemon-only restart refreshes only daemon handoff facts", async () => {
  const machine = { processId: 41, executablePath: "machine.exe" };
  const cdp = { endpoint: "http://127.0.0.1:9222", targetId: "page-1" };
  const handoff = {
    daemon: {
      executablePath: "C:\\VEM\\bringup\\vending-daemon.exe",
      dataDirectory: "C:\\ProgramData\\VEM\\vending-daemon",
      ready: { generation: "generation-before" },
    },
    machine,
    cdp,
  };
  const writes: unknown[] = [];
  const generations = [
    { generation: "generation-before", ipcToken: "before" },
    { generation: "generation-after", ipcToken: "after" },
  ];

  const result = await restartInstalledDaemon(handoff, "handoff.json", {
    runPowerShell: async () =>
      JSON.stringify({
        daemonProcessId: 99,
        daemonService: "VemVendingDaemon",
      }),
    waitForDaemonReadyRefreshFn: async () =>
      generations.shift() ?? {
        generation: "generation-after",
        ipcToken: "after",
      },
    writeJsonFn: (_path, value) => writes.push(structuredClone(value)),
  });

  assert.strictEqual(handoff.machine, machine);
  assert.strictEqual(handoff.cdp, cdp);
  assert.deepEqual(handoff.daemon.ready, {
    generation: "generation-after",
    ipcToken: "after",
  });
  assert.equal((handoff.daemon as Record<string, unknown>).processId, 99);
  assert.equal(writes.length, 1);
  assert.deepEqual(result.ready, handoff.daemon.ready);
  assert.strictEqual(result.machine, undefined);
  assert.strictEqual(result.cdp, undefined);
});
