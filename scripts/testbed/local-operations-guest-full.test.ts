import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstalledDaemonRestartScript,
  restartInstalledDaemon,
} from "./local-operations-guest-full.ts";

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
