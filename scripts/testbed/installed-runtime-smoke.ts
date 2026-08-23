#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  captureDomIdentity,
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  rewriteWebSocketDebuggerUrl,
} from "./machine-ui-cdp-driver.ts";

const MODES = new Set(["fast", "full"]);
const CANONICAL_DAEMON = "C:\\VEM\\bringup\\vending-daemon.exe";
const CANONICAL_MACHINE = "C:\\VEM\\bringup\\machine.exe";
const BASE_TRACKS = Object.freeze([
  "production-daemon-ready",
  "runtime-claim",
  "installed-tauri-cdp-handoff",
]);
const LOOPBACK_FETCH_ATTEMPTS = 9;
const LOOPBACK_FETCH_RETRY_MS = 250;
const TAURI_DOCUMENT_READY_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchLoopbackWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit,
  label: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOPBACK_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImpl(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < LOOPBACK_FETCH_ATTEMPTS) {
        await sleep(LOOPBACK_FETCH_RETRY_MS);
      }
    }
  }
  throw new Error(
    `${label} could not connect to ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function canonicalWindowsPath(
  value: unknown,
  expected: string,
  label: string,
): string {
  const path = required(value, label).replaceAll("/", "\\");
  if (path.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

function loopbackUrl(
  value: unknown,
  label: string,
  expectedPort: number | null,
  expectedPath: string,
): string {
  const url = new URL(required(value, label));
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    (expectedPort != null && url.port !== String(expectedPort)) ||
    (expectedPath && url.pathname !== expectedPath)
  ) {
    throw new Error(`${label} must use the declared Windows loopback endpoint`);
  }
  return url.toString().replace(/\/$/, "");
}

export function declaredInstalledRuntimeTracks(mode: unknown): string[] {
  const normalizedMode = String(mode);
  if (!MODES.has(normalizedMode))
    throw new Error("installed runtime mode must be fast or full");
  return normalizedMode === "fast"
    ? [...BASE_TRACKS]
    : [
        ...BASE_TRACKS,
        "scanner-payment-code",
        "installed-runtime-observability",
      ];
}

export function validateInstalledRuntimeEvidence(value: unknown): JsonRecord {
  const input = recordValue(value);
  if (input?.schemaVersion !== "vem-installed-runtime-handoff/v1") {
    throw new Error("installed runtime handoff schema is invalid");
  }
  const machineCode = required(input.machineCode, "machineCode");
  const claim = recordValue(input.claim);
  if (claim?.status !== "provisioned" || claim?.machineCode !== machineCode) {
    throw new Error(
      "installed runtime handoff must prove the clean claim result",
    );
  }
  const daemon = recordValue(input.daemon);
  const daemonService = recordValue(daemon.service);
  const daemonRuntimeMode =
    daemonService.name === "VemVendingDaemon"
      ? "windows_service"
      : daemon.console === true
        ? "console_process"
        : null;
  if (!daemonRuntimeMode) {
    throw new Error(
      "installed runtime handoff must declare a daemon service owner",
    );
  }
  const machine = recordValue(input.machine);
  const principal = required(machine.principal, "machine principal");
  const daemonReady = recordValue(daemon.ready);
  const healthzUrl = loopbackUrl(
    daemonReady.healthzUrl,
    "daemon healthzUrl",
    null,
    "/healthz",
  );
  const readyzUrl = loopbackUrl(
    daemonReady.readyzUrl,
    "daemon readyzUrl",
    Number(new URL(healthzUrl).port),
    "/readyz",
  );
  const machineProcessId = positiveInteger(
    machine.processId,
    "machine processId",
  );
  const cdp = recordValue(input.cdp);
  const machineAncestorProcessId = positiveInteger(
    cdp.machineAncestorProcessId,
    "CDP machineAncestorProcessId",
  );
  if (machineAncestorProcessId !== machineProcessId) {
    throw new Error(
      "CDP listener is not descended from the installed machine process",
    );
  }
  return {
    schemaVersion: input.schemaVersion,
    machineCode,
    claim: { status: "provisioned", machineCode },
    daemon: {
      executablePath: canonicalWindowsPath(
        daemon.executablePath,
        CANONICAL_DAEMON,
        "daemon executablePath",
      ),
      processId: positiveInteger(daemon.processId, "daemon processId"),
      runtimeMode: daemonRuntimeMode,
      service:
        daemonRuntimeMode === "windows_service"
          ? {
              name: "VemVendingDaemon",
              status: required(daemonService.status, "daemon service status"),
            }
          : null,
      ready: {
        healthzUrl,
        readyzUrl,
        ipcToken: required(daemonReady.ipcToken, "daemon ipcToken"),
      },
    },
    machine: {
      executablePath: canonicalWindowsPath(
        machine.executablePath,
        CANONICAL_MACHINE,
        "machine executablePath",
      ),
      processId: machineProcessId,
      sessionId: positiveInteger(machine.sessionId, "machine sessionId"),
      principal,
    },
    cdp: {
      endpoint: loopbackUrl(cdp.endpoint, "CDP endpoint", 9222, ""),
      targetId: required(cdp.targetId, "CDP targetId"),
      listenerProcessId: positiveInteger(
        cdp.listenerProcessId,
        "CDP listenerProcessId",
      ),
      machineAncestorProcessId,
    },
  };
}

export async function runInstalledRuntimeSmoke({
  mode,
  evidence,
  fetchImpl = globalThis.fetch,
  webSocketFactory,
}: {
  mode: unknown;
  evidence: unknown;
  fetchImpl?: typeof fetch;
  webSocketFactory?: unknown;
}): Promise<JsonRecord> {
  const tracks = declaredInstalledRuntimeTracks(mode);
  const runtime = validateInstalledRuntimeEvidence(evidence);
  const runtimeDaemon = recordValue(runtime.daemon);
  const runtimeDaemonReady = recordValue(runtimeDaemon.ready);
  const runtimeCdp = recordValue(runtime.cdp);
  const retryingFetch: typeof fetch = (input, init) =>
    fetchLoopbackWithRetry(
      fetchImpl,
      String(input),
      init ?? {},
      "installed runtime probe",
    );
  const healthResponse = await retryingFetch(
    String(runtimeDaemonReady.healthzUrl),
    {
      headers: {
        authorization: `Bearer ${runtimeDaemonReady.ipcToken}`,
      },
    },
  );
  if (!healthResponse.ok) {
    throw new Error(
      `production daemon health failed with HTTP ${healthResponse.status}`,
    );
  }
  const health = recordValue(await healthResponse.json());
  if (
    !["healthy", "degraded", "offline", "maintenance", "starting"].includes(
      String(health?.status),
    ) ||
    !health.process ||
    !Array.isArray(health.components)
  ) {
    throw new Error("production daemon health snapshot is invalid");
  }
  const readyResponse = await retryingFetch(
    String(runtimeDaemonReady.readyzUrl),
    {
      headers: {
        authorization: `Bearer ${runtimeDaemonReady.ipcToken}`,
      },
    },
  );
  if (!readyResponse.ok) {
    throw new Error(
      `production daemon readiness failed with HTTP ${readyResponse.status}`,
    );
  }
  const readiness = recordValue(await readyResponse.json());
  if (
    readiness?.ready !== true ||
    !Array.isArray(readiness.blockingCodes) ||
    !Array.isArray(readiness.blockingReasons)
  ) {
    throw new Error("production daemon did not become ready after claim");
  }
  const target = await discoverMachineUiTarget({
    endpoint: String(runtimeCdp.endpoint),
    expectedTargetId: String(runtimeCdp.targetId),
    fetchImpl: retryingFetch,
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(
      String(target.webSocketDebuggerUrl),
      String(runtimeCdp.endpoint),
    ),
    {
      webSocketFactory: webSocketFactory as NonNullable<
        ConstructorParameters<typeof CdpClient>[1]
      >["webSocketFactory"],
    },
  );
  try {
    await client.connect();
    await enablePageRuntime(client);
    const deadline = Date.now() + TAURI_DOCUMENT_READY_TIMEOUT_MS;
    let identity: JsonRecord;
    do {
      identity = recordValue(await captureDomIdentity(client));
      if (identity.readyState === "complete") break;
      await sleep(100);
    } while (Date.now() < deadline);
    if (identity?.readyState !== "complete") {
      throw new Error("installed Tauri document did not become complete");
    }
    return {
      schemaVersion: "vem-installed-runtime-smoke/v1",
      ok: true,
      mode,
      machineCode: runtime.machineCode,
      declaredTracks: tracks,
      completedTracks: tracks,
      daemon: {
        executablePath: runtimeDaemon.executablePath,
        processId: runtimeDaemon.processId,
        runtimeMode: runtimeDaemon.runtimeMode,
        ready: true,
        healthStatus: health.status,
      },
      machine: runtime.machine,
      tauri: {
        targetId: target.id,
        listenerProcessId: runtimeCdp.listenerProcessId,
        route: identity.route,
        readyState: identity.readyState,
        domHash: mode === "full" ? identity.domHash : null,
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return required(value, `--${name}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = option(args, "mode");
  const evidencePath = option(args, "evidence");
  const out = option(args, "out");
  if (!isAbsolute(evidencePath) || !isAbsolute(out)) {
    throw new Error("--evidence and --out must be absolute paths");
  }
  const evidence = JSON.parse(
    await readFile(evidencePath, "utf8"),
  ) as JsonRecord;
  const result = await runInstalledRuntimeSmoke({ mode, evidence });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
