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
} from "./machine-ui-cdp-driver.mjs";

const MODES = new Set(["fast", "full"]);
const CANONICAL_DAEMON = "C:\\VEM\\bringup\\vending-daemon.exe";
const CANONICAL_MACHINE = "C:\\VEM\\bringup\\machine.exe";
const BASE_TRACKS = Object.freeze([
  "production-daemon-ready",
  "runtime-claim",
  "installed-tauri-cdp-handoff",
]);

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function canonicalWindowsPath(value, expected, label) {
  const path = required(value, label).replaceAll("/", "\\");
  if (path.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

function loopbackUrl(value, label, expectedPort, expectedPath) {
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

export function declaredInstalledRuntimeTracks(mode) {
  if (!MODES.has(mode))
    throw new Error("installed runtime mode must be fast or full");
  return mode === "fast"
    ? [...BASE_TRACKS]
    : [...BASE_TRACKS, "installed-runtime-observability"];
}

export function validateInstalledRuntimeEvidence(value) {
  if (value?.schemaVersion !== "vem-installed-runtime-handoff/v1") {
    throw new Error("installed runtime handoff schema is invalid");
  }
  const machineCode = required(value.machineCode, "machineCode");
  if (
    value.claim?.status !== "provisioned" ||
    value.claim?.machineCode !== machineCode
  ) {
    throw new Error(
      "installed runtime handoff must prove the clean claim result",
    );
  }
  if (value.daemon?.console !== true) {
    throw new Error("ordinary production daemon process must use --console");
  }
  const principal = required(value.machine?.principal, "machine principal");
  const healthzUrl = loopbackUrl(
    value.daemon.ready?.healthzUrl,
    "daemon healthzUrl",
    null,
    "/healthz",
  );
  const readyzUrl = loopbackUrl(
    value.daemon.ready?.readyzUrl,
    "daemon readyzUrl",
    new URL(healthzUrl).port,
    "/readyz",
  );
  const machineProcessId = positiveInteger(
    value.machine.processId,
    "machine processId",
  );
  const machineAncestorProcessId = positiveInteger(
    value.cdp?.machineAncestorProcessId,
    "CDP machineAncestorProcessId",
  );
  if (machineAncestorProcessId !== machineProcessId) {
    throw new Error(
      "CDP listener is not descended from the installed machine process",
    );
  }
  return {
    schemaVersion: value.schemaVersion,
    machineCode,
    claim: { status: "provisioned", machineCode },
    daemon: {
      executablePath: canonicalWindowsPath(
        value.daemon.executablePath,
        CANONICAL_DAEMON,
        "daemon executablePath",
      ),
      processId: positiveInteger(value.daemon.processId, "daemon processId"),
      console: true,
      ready: {
        healthzUrl,
        readyzUrl,
        ipcToken: required(value.daemon.ready?.ipcToken, "daemon ipcToken"),
      },
    },
    machine: {
      executablePath: canonicalWindowsPath(
        value.machine.executablePath,
        CANONICAL_MACHINE,
        "machine executablePath",
      ),
      processId: machineProcessId,
      sessionId: positiveInteger(value.machine.sessionId, "machine sessionId"),
      principal,
    },
    cdp: {
      endpoint: loopbackUrl(value.cdp?.endpoint, "CDP endpoint", 9222),
      targetId: required(value.cdp?.targetId, "CDP targetId"),
      listenerProcessId: positiveInteger(
        value.cdp?.listenerProcessId,
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
}) {
  const tracks = declaredInstalledRuntimeTracks(mode);
  const runtime = validateInstalledRuntimeEvidence(evidence);
  const healthResponse = await fetchImpl(runtime.daemon.ready.healthzUrl, {
    headers: {
      authorization: `Bearer ${runtime.daemon.ready.ipcToken}`,
    },
  });
  if (!healthResponse.ok) {
    throw new Error(
      `production daemon health failed with HTTP ${healthResponse.status}`,
    );
  }
  const health = await healthResponse.json();
  if (
    !["healthy", "degraded", "offline", "maintenance", "starting"].includes(
      health?.status,
    ) ||
    !health.process ||
    !Array.isArray(health.components)
  ) {
    throw new Error("production daemon health snapshot is invalid");
  }
  const readyResponse = await fetchImpl(runtime.daemon.ready.readyzUrl, {
    headers: {
      authorization: `Bearer ${runtime.daemon.ready.ipcToken}`,
    },
  });
  if (!readyResponse.ok) {
    throw new Error(
      `production daemon readiness failed with HTTP ${readyResponse.status}`,
    );
  }
  const readiness = await readyResponse.json();
  if (
    readiness?.ready !== true ||
    !Array.isArray(readiness.blockingCodes) ||
    !Array.isArray(readiness.blockingReasons)
  ) {
    throw new Error("production daemon did not become ready after claim");
  }
  const target = await discoverMachineUiTarget({
    endpoint: runtime.cdp.endpoint,
    expectedTargetId: runtime.cdp.targetId,
    fetchImpl,
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      runtime.cdp.endpoint,
    ),
    { webSocketFactory },
  );
  try {
    await client.connect();
    await enablePageRuntime(client);
    const identity = await captureDomIdentity(client);
    if (identity.readyState !== "complete") {
      throw new Error("installed Tauri document is not complete");
    }
    return {
      schemaVersion: "vem-installed-runtime-smoke/v1",
      ok: true,
      mode,
      machineCode: runtime.machineCode,
      declaredTracks: tracks,
      completedTracks: tracks,
      daemon: {
        executablePath: runtime.daemon.executablePath,
        processId: runtime.daemon.processId,
        ready: true,
        healthStatus: health.status,
      },
      machine: runtime.machine,
      tauri: {
        targetId: target.id,
        listenerProcessId: runtime.cdp.listenerProcessId,
        route: identity.route,
        readyState: identity.readyState,
        domHash: mode === "full" ? identity.domHash : null,
      },
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return required(value, `--${name}`);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = option(args, "mode");
  const evidencePath = option(args, "evidence");
  const out = option(args, "out");
  if (!isAbsolute(evidencePath) || !isAbsolute(out)) {
    throw new Error("--evidence and --out must be absolute paths");
  }
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
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
