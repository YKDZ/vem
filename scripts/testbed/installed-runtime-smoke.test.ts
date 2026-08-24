import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  declaredInstalledRuntimeTracks,
  runInstalledRuntimeSmoke,
} from "./installed-runtime-smoke.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

type SmokeOptions = Parameters<typeof runInstalledRuntimeSmoke>[0];
type FetchImpl = NonNullable<SmokeOptions["fetchImpl"]>;

class FakeCdpSocket extends EventTarget {
  readyState = 1;
  documentReadyStates: string[];

  constructor(documentReadyStates: string[] = ["complete"]) {
    super();
    this.documentReadyStates = [...documentReadyStates];
  }

  send(payload: string) {
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
                readyState:
                  this.documentReadyStates.shift() ??
                  this.documentReadyStates.at(-1) ??
                  "complete",
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
      console: false,
      service: { name: "VemVendingDaemon", status: "Running" },
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

function fetchBoundary(url: string | URL | Request, options: RequestInit = {}) {
  const value = String(url);
  if (value.endsWith("/healthz")) {
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer local-ipc-token",
    );
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
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer local-ipc-token",
    );
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
      fetchImpl: fetchBoundary as unknown as FetchImpl,
      webSocketFactory: () => new FakeCdpSocket(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.machineCode, "VEM-TESTBED-LOCAL");
    assert.equal(recordValue(result.tauri).route, "#/catalog");
    assert.equal(recordValue(result.tauri).readyState, "complete");
    assert.equal(recordValue(result.tauri).listenerProcessId, 303);
    assert.equal(recordValue(result.daemon).healthStatus, "healthy");
    assert.equal(recordValue(result.daemon).runtimeMode, "windows_service");
    assert.deepEqual(
      result.completedTracks,
      declaredInstalledRuntimeTracks("full"),
    );
    assert.equal("ipcToken" in result, false);
  });

  it("waits for the installed Tauri document to finish loading", async () => {
    const socket = new FakeCdpSocket(["loading", "complete"]);
    const result = await runInstalledRuntimeSmoke({
      mode: "fast",
      evidence: evidence(),
      fetchImpl: fetchBoundary as unknown as FetchImpl,
      webSocketFactory: () => socket,
    });

    assert.equal(result.ok, true);
    assert.equal(recordValue(result.tauri).readyState, "complete");
  });

  it("retries transient loopback refusal without accepting an invalid response", async () => {
    let attempts = 0;
    const result = await runInstalledRuntimeSmoke({
      mode: "fast",
      evidence: evidence(),
      fetchImpl: (async (...args: Parameters<typeof fetchBoundary>) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("fetch failed");
        return fetchBoundary(...args);
      }) as unknown as FetchImpl,
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
    assert.match(guest, /install-vem-runtime-owners\.ps1/);
    assert.match(guest, /Start-Service -Name "VemVendingDaemon"/);
    assert.match(guest, /Start-ScheduledTask -TaskName "VEMMachineUI"/);
    assert.match(guest, /Start-ScheduledTask -TaskName "VEMVisionRuntime"/);
    assert.match(guest, /function Wait-InstalledTauriRoute/);
    assert.match(guest, /function Wait-CanonicalProcessEvidence/);
    assert.match(guest, /function Get-InstalledTauriTargetOnce/);
    assert.match(guest, /Wait-InstalledTauriTarget \$deadline/);
    assert.doesNotMatch(
      guest,
      /function Wait-InstalledTauriTarget \{[\s\S]*AddMinutes\(1\)/,
    );
    assert.match(guest, /installed-tauri-route-admission\.ts/);
    assert.match(guest, /Write-TestbedPhase "admit-installed-tauri-catalog"/);
    assert.match(guest, /Wait-InstalledTauriRoute "#\/catalog"/);
    assert.match(guest, /function Wait-TestbedVisionRuntimeEvidence/);
    assert.match(guest, /Get-VisionMainCanonicalProcessBinding/);
    assert.match(guest, /Wait-TestbedVisionRuntimeEvidence 30/);
    assert.match(
      guest,
      /SetEnvironmentVariable\("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", \$null, \$scope\)/,
    );
    assert.match(guest, /-MachineUiWebViewDebugPort 9222/);
    assert.doesNotMatch(
      guest,
      /SetEnvironmentVariable\("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9222", "Machine"\)/,
    );
    assert.match(guest, /function Get-TestbedStartupModeEvidence/);
    assert.match(guest, /source = "windows_reboot_logon_probe"/);
    assert.match(guest, /source = "installed_owner_stop_start"/);
    assert.match(guest, /startedAt = \$bootStartedAt/);
    assert.match(guest, /lastRunTime = \$machineTaskLastRun/);
    assert.match(
      guest,
      /\$machineTaskResult = if \(\$null -eq \$machineTask\.lastTaskResult\)[\s\S]*\[long\]\$machineTask\.lastTaskResult/,
    );
    assert.match(guest, /lastTaskResult = \$machineTaskResult/);
    assert.match(guest, /Get-TestbedStartupModeEvidence \$sessionId \$Probe/);
    assert.match(
      guest,
      /ValidateSet\("single", "prepare_reboot", "resume_reboot"\)/,
    );
    assert.match(guest, /vem-local-testbed-startup-preparation\/v1/);
    assert.match(
      guest,
      /\$StartupPhase -eq "prepare_reboot"[\s\S]*Write-TestbedStartupPreparation[\s\S]*exit 0/,
    );
    assert.match(
      guest,
      /\$StartupPhase -eq "resume_reboot"[\s\S]*Read-TestbedStartupPreparation[\s\S]*Get-TestbedInstalledRuntimeOwnerState/,
    );
    assert.match(guest, /Unregister-ScheduledTask -TaskName \$taskSpec\.Name/);
    assert.doesNotMatch(guest, /\$daemonProcess = Start-Process/);
    assert.doesNotMatch(
      guest,
      /Register-ScheduledTask -TaskName \$machineTaskName/,
    );
    assert.doesNotMatch(
      guest,
      /Start-ScheduledTask -TaskName \$machineTaskName/,
    );
    assert.match(guest, /installed-runtime-smoke\.ts/);
    assert.match(guest, /full-workflow-orchestrator\.ts/);
    assert.match(guest, /installed-ipc-recovery\.json/);
    assert.match(guest, /serial-fulfillment-error\.json/);
    assert.match(guest, /scanner-payment-code\.json/);
    assert.match(guest, /startupOwnerReadiness/);
    assert.doesNotMatch(
      guest,
      /pnpm[^\\n]+test:e2e:real-daemon|pnpm[^\\n]+playwright|pnpm[^\\n]+vite|fake[_ -]?platform|simulatedHardwareSaleFlow/i,
    );
  });
});
