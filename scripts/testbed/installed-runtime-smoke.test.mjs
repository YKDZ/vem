import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  declaredInstalledRuntimeTracks,
  runInstalledRuntimeSmoke,
} from "./installed-runtime-smoke.mjs";

class FakeCdpSocket extends EventTarget {
  readyState = 1;

  send(payload) {
    const request = JSON.parse(payload);
    const result =
      request.method === "Runtime.evaluate"
        ? {
            result: {
              value: {
                url: "http://tauri.localhost/#/catalog",
                route: "#/catalog",
                pathname: "/",
                title: "VEM",
                readyState: "complete",
                activeElement: "body",
                domLength: 512,
                domHash: "0123abcd",
              },
            },
          }
        : {};
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ id: request.id, result }),
        }),
      );
    });
  }

  close() {
    this.readyState = 3;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}

function evidence() {
  return {
    schemaVersion: "vem-installed-runtime-handoff/v1",
    machineCode: "VEM-TESTBED-LOCAL",
    claim: { status: "provisioned", machineCode: "VEM-TESTBED-LOCAL" },
    daemon: {
      executablePath: "C:\\VEM\\bringup\\vending-daemon.exe",
      processId: 101,
      console: true,
      ready: {
        healthzUrl: "http://127.0.0.1:43101/healthz",
        readyzUrl: "http://127.0.0.1:43101/readyz",
        ipcToken: "local-ipc-token",
      },
    },
    machine: {
      executablePath: "C:\\VEM\\bringup\\machine.exe",
      processId: 202,
      sessionId: 3,
      principal: "TESTBED\\BaselineUser",
    },
    cdp: {
      endpoint: "http://127.0.0.1:9222",
      targetId: "tauri-page-1",
      listenerProcessId: 303,
      machineAncestorProcessId: 202,
    },
  };
}

function fetchBoundary(url, options = {}) {
  const value = String(url);
  if (value.endsWith("/healthz")) {
    assert.equal(options.headers.authorization, "Bearer local-ipc-token");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        status: "healthy",
        process: {
          component: "daemon",
          level: "ok",
          code: "OK",
          message: "ok",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
        components: [],
        configConfigured: true,
        databaseOnline: true,
        backendOnline: true,
        mqttConnected: true,
        outboxSize: 0,
        outboxMax: 1000,
        hardwareOnline: true,
        scannerOnline: true,
        visionOnline: false,
        remoteOpsActive: false,
        currentTransaction: null,
        operatorReason: "OK",
        updatedAt: "2026-07-18T00:00:00.000Z",
      }),
    });
  }
  if (value.endsWith("/readyz")) {
    assert.equal(options.headers.authorization, "Bearer local-ipc-token");
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        ready: true,
        blockingCodes: [],
        blockingReasons: [],
        degradedReasons: [],
        updatedAt: "2026-07-18T00:00:00.000Z",
      }),
    });
  }
  if (value.endsWith("/json")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: "tauri-page-1",
          url: "http://tauri.localhost/#/catalog",
          webSocketDebuggerUrl:
            "ws://127.0.0.1:9222/devtools/page/tauri-page-1",
        },
      ],
    });
  }
  throw new Error(`unexpected boundary URL: ${value}`);
}

describe("installed production runtime smoke", () => {
  it("declares distinct fast and full installed-runtime tracks", () => {
    const fast = declaredInstalledRuntimeTracks("fast");
    const full = declaredInstalledRuntimeTracks("full");
    assert.notDeepEqual(fast, full);
    assert.deepEqual(full.slice(0, fast.length), fast);
    assert.equal(full.at(-1), "installed-runtime-observability");
    assert.ok(full.includes("scanner-payment-code"));
  });

  it("observes the production daemon and attaches to the installed Tauri page", async () => {
    const result = await runInstalledRuntimeSmoke({
      mode: "full",
      evidence: evidence(),
      fetchImpl: fetchBoundary,
      webSocketFactory: () => new FakeCdpSocket(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.machineCode, "VEM-TESTBED-LOCAL");
    assert.equal(result.tauri.route, "#/catalog");
    assert.equal(result.tauri.readyState, "complete");
    assert.equal(result.tauri.listenerProcessId, 303);
    assert.equal(result.daemon.healthStatus, "healthy");
    assert.deepEqual(
      result.completedTracks,
      declaredInstalledRuntimeTracks("full"),
    );
    assert.equal("ipcToken" in result, false);
  });

  it("retries transient loopback refusal without accepting an invalid response", async () => {
    let attempts = 0;
    const result = await runInstalledRuntimeSmoke({
      mode: "fast",
      evidence: evidence(),
      fetchImpl: async (...args) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("fetch failed");
        return fetchBoundary(...args);
      },
      webSocketFactory: () => new FakeCdpSocket(),
    });
    assert.equal(result.ok, true);
    assert.ok(attempts >= 4);
  });

  it("launches only canonical installed binaries without a debug test stack", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.match(guest, /C:\\VEM\\bringup/);
    assert.match(guest, /vending-daemon\.exe.*--console/s);
    assert.match(guest, /installed-runtime-smoke\.mjs/);
    assert.match(guest, /full-workflow-orchestrator\.mjs/);
    assert.match(guest, /installed-ipc-recovery\.json/);
    assert.match(guest, /serial-fulfillment-error\.json/);
    assert.match(guest, /scanner-payment-code\.json/);
    assert.match(
      guest,
      /New-ScheduledTaskPrincipal[\s\S]*-LogonType Interactive/,
    );
    assert.match(guest, /\$guestInput\.interactiveUser/);
    assert.doesNotMatch(
      guest,
      /test:e2e:real-daemon|playwright|vite|fake[_ -]?platform|simulatedHardwareSaleFlow/i,
    );
  });
});
