import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectInstalledAiDegradationEvidence } from "./ai-installed-degradation.mjs";
import {
  assembleInstalledAiTryOnAcceptanceForTest,
  buildInstalledVisionWorkerSampleScript,
  sampleInstalledVisionPeakRssForTest,
  validateInstalledAiAttemptSupport,
  validateMissingDegradationSupport,
  validateVerifiedOwnerRecoverySupport,
} from "./ai-virtual-try-on-installed-entry.mjs";
import { CdpClient } from "./machine-ui-cdp-driver.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const runner = join(
  repoRoot,
  "scripts/testbed/run-full-ai-virtual-try-on-track.ps1",
);
const ownerModule = join(repoRoot, "scripts/testbed/ai-vision-owner.psm1");

class DegradationFakeWebSocket {
  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type, handler, options = {}) {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ handler, once: options.once === true });
    this.listeners.set(type, entries);
  }

  removeEventListener(type, handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (entry) => entry.handler !== handler,
      ),
    );
  }

  send(raw) {
    const request = JSON.parse(raw);
    queueMicrotask(() =>
      this.emit("message", {
        data: JSON.stringify({
          id: request.id,
          result: {
            result: {
              value: {
                buyAvailable: true,
                catalogAvailable: true,
                machineUiAvailable: true,
                tryOnAiAvailable: false,
              },
            },
          },
        }),
      }),
    );
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  emit(type, event) {
    const entries = [...(this.listeners.get(type) ?? [])];
    for (const entry of entries) entry.handler(event);
    this.listeners.set(
      type,
      entries.filter((entry) => !entry.once),
    );
  }
}

test("proves missing model degradation through public Vision Machine and daemon boundaries", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(
        JSON.stringify({
          status: "degraded",
          protocol: "vem.vision.v2",
          cameraReady: true,
          fastReady: true,
          aiReady: false,
          aiReadinessDiagnostic: "model_pack_missing",
          visionBusinessReady: true,
        }),
      );
      return;
    }
    if (request.url === "/healthz") {
      response.end(JSON.stringify({ status: "healthy" }));
      return;
    }
    if (request.url === "/readyz") {
      response.end(JSON.stringify({ ready: true }));
      return;
    }
    if (request.url === "/v1/sale-start-capability") {
      response.end(JSON.stringify({ canStartSale: true, revision: 1 }));
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const socket = new DegradationFakeWebSocket();
  const client = new CdpClient("ws://127.0.0.1/devtools/page/degradation", {
    webSocketFactory: () => socket,
    defaultTimeoutMs: 500,
  });
  await client.connect();
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await collectInstalledAiDegradationEvidence({
      client,
      daemonOrigin: origin,
      daemonToken: "test-token",
      expectedDiagnostic: "model_pack_missing",
      readReady: async () => ({
        type: "vision.ready",
        payload: {
          aiReady: false,
          aiReadinessDiagnostic: "model_pack_missing",
          fastReady: true,
          visionBusinessReady: true,
          capabilities: ["try_on_fast", "profile_push", "presence_status"],
        },
      }),
      visionOrigin: origin,
    });
    assert.deepEqual(result, {
      aiReady: false,
      coreReady: true,
      daemonReady: true,
      fastReady: true,
      machineUiAvailable: true,
      saleAvailable: true,
    });
  } finally {
    await client.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects missing model support with unknown fields or any false surviving truth", () => {
  const value = {
    facts: {
      degradation: {
        diagnostic: "model_pack_missing",
        facts: {
          aiReady: false,
          coreReady: true,
          daemonReady: true,
          fastReady: true,
          machineUiAvailable: true,
          saleAvailable: true,
        },
        fault: "missing",
      },
    },
    kind: "installed-runtime",
    schemaVersion: "vem.testbed.ai-virtual-try-on-support.v1",
  };
  assert.deepEqual(
    validateMissingDegradationSupport(value),
    value.facts.degradation.facts,
  );
  for (const mutate of [
    (copy) => (copy.extra = true),
    (copy) => delete copy.facts.degradation.facts.coreReady,
    (copy) => (copy.facts.degradation.facts.fastReady = false),
    (copy) => (copy.facts.degradation.facts.aiReady = true),
    (copy) => (copy.facts.degradation.extra = true),
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.throws(
      () => validateMissingDegradationSupport(copy),
      /support evidence is invalid/,
    );
  }
});

test("binds verified owner recovery to ready model runtime worker and source identities", () => {
  const proof = {
    candidate: {
      sourceCommit: "1".repeat(40),
      workerExecutableSha256: "2".repeat(64),
    },
    modelPack: { archive: { sha256: "3".repeat(64) } },
    resources: { runtimeDescriptorSha256: "4".repeat(64) },
  };
  const value = {
    facts: {
      recovery: {
        aiReadinessDiagnostic: "ready",
        aiReady: true,
        modelPackSha256: "3".repeat(64),
        runtimeDescriptorSha256: "4".repeat(64),
        sourceCommit: "1".repeat(40),
        workerExecutableSha256: "2".repeat(64),
      },
    },
    kind: "installed-runtime",
    schemaVersion: "vem.testbed.ai-virtual-try-on-support.v1",
  };
  assert.equal(
    validateVerifiedOwnerRecoverySupport(value, proof).aiReady,
    true,
  );
  for (const mutate of [
    (copy) => (copy.extra = true),
    (copy) => (copy.facts.recovery.aiReady = false),
    (copy) =>
      (copy.facts.recovery.aiReadinessDiagnostic = "worker_unavailable"),
    (copy) => (copy.facts.recovery.modelPackSha256 = "5".repeat(64)),
    (copy) => (copy.facts.recovery.runtimeDescriptorSha256 = "5".repeat(64)),
    (copy) => (copy.facts.recovery.workerExecutableSha256 = "5".repeat(64)),
    (copy) => (copy.facts.recovery.sourceCommit = "5".repeat(40)),
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.throws(
      () => validateVerifiedOwnerRecoverySupport(copy, proof),
      /recovery support evidence is invalid/,
    );
  }
});

test("AI track owns the importable short/long/default Vision owner lifecycle", () => {
  assert.equal(existsSync(ownerModule), true);
  const source = readFileSync(runner, "utf8");
  assert.match(source, /Import-Module[^\n]*ai-vision-owner\.psm1/);
  assert.match(source, /Restart-TestbedAiVisionOwner[^\n]*short/);
  assert.match(source, /Restart-TestbedAiVisionOwner[^\n]*long/);
  assert.match(source, /Restart-TestbedAiDegradedVisionOwner[^\n]*missing/);
  assert.match(source, /degradation --fault missing/);
  assert.match(source, /--missing-degradation \$missingFacts/);
  assert.match(source, /Restore-TestbedDefaultVisionOwner/);
  assert.match(source, /default-owner-restoration\.json/);
  assert.match(source, /aiEnvironmentCleared = \$true/);
});

test("repeat runs clear only the exact owned AI artifact root before admission", () => {
  const guest = readFileSync(
    join(repoRoot, "scripts/testbed/run-local-testbed-guest.ps1"),
    "utf8",
  );
  assert.match(guest, /Join-Path \$handoffRoot "ai-virtual-try-on-artifacts"/);
  assert.match(guest, /Remove-TestbedAiAcceptanceArtifactRoot/);
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(repoRoot, "scripts/testbed/ai-acceptance-artifacts.harness.ps1"),
    ],
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout.trim()).ok, true);
});

test("AI virtual try-on runner fails closed without emitting acceptance evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-track-placeholder-"));
  const output = join(root, "ai-virtual-try-on.json");
  try {
    const guestInput = join(root, "guest-input.json");
    const handoff = join(root, "handoff.json");
    writeFileSync(
      guestInput,
      '{"schemaVersion":"vem-local-testbed-guest-input/v1"}\n',
    );
    writeFileSync(handoff, "{}\n");
    const result = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        runner,
        "-GuestInputPath",
        guestInput,
        "-HandoffPath",
        handoff,
        "-OutPath",
        output,
        "-FixtureKey",
        "aiVirtualTryOn",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /candidate exact-four input directory is required/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AI virtual try-on runner accepts only approved external input identities", () => {
  const source = readFileSync(runner, "utf8");
  for (const name of [
    "candidateInputDirectory",
    "windowsProofInputDirectory",
    "approvedPrecutoverReceipt",
    "modelPackUrl",
    "modelPackSha256",
    "modelPackByteSize",
    "installedVisionRuntimeArchive",
    "recordedFixtureArchive",
  ]) {
    assert.match(source, new RegExp(name));
  }
  for (const member of [
    "candidate-manifest.json",
    "github-build-provenance.sigstore.json",
    "trusted-builder-evidence.json",
    "precutover-ai-proof.json",
    "precutover-ai-proof.sigstore.json",
    "trusted-precutover-proof-evidence.json",
  ]) {
    assert.match(source, new RegExp(member.replaceAll(".", "\\.")));
  }
  assert.match(source, /vem\.precutover\.ai\.v2/);
  assert.match(source, /\^https:\/\//);
  assert.doesNotMatch(
    source,
    /Start-Process[^\n]*worker|--probe-runtime|--model-pack/,
  );
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod|WebClient/);
  assert.doesNotMatch(source, /camera|captureUserMedia|getUserMedia/i);
});

test("assembles two isolated installed AI attempts and ordinary sale facts while calibration stays fail closed", async () => {
  process.env.NODE_ENV = "test";
  const root = mkdtempSync(join(tmpdir(), "vem-ai-assembly-"));
  const calls = [];
  const attempt = (caseKey, digit) => ({
    attemptId: `0198f44e-21bd-7c62-8f52-b7c86cc2c00${digit}`,
    lifecycle: ["acquiring", "generating", "completed"],
    resultEvidence: {
      contentType: "image/png",
      width: 768,
      height: 1024,
      sha256: digit.repeat(64),
    },
    durationMs: 12_000,
    peakRssBytes: 512 * 1024 * 1024,
    surface: {
      garmentId: `0198f44e-21bd-7c62-8f52-b7c86cc2d00${digit}`,
    },
    regionalEvidence: { bytes: Buffer.from("{}\n") },
  });
  const result = await assembleInstalledAiTryOnAcceptanceForTest(
    {
      attempts: [attempt("short", "1"), attempt("long", "5")],
      identities: {
        aiRuntime: "3".repeat(64),
        contract: "2".repeat(64),
        modelPack: "4".repeat(64),
        runtime: "1".repeat(64),
      },
      artifactRoot: root,
    },
    {
      ordinarySale: async () => {
        calls.push("sale");
        return { ok: true, summary: { orderId: "ORDER-1" } };
      },
    },
  );
  assert.deepEqual(calls, ["sale"]);
  assert.equal(
    result.report.schemaVersion,
    "vem-ai-virtual-try-on-acceptance/v2",
  );
  assert.equal(result.report.attempts.length, 2);
  assert.equal(result.report.postAi.ordinarySaleCompleted, true);
  assert.equal(result.acceptance.ok, false);
  assert.deepEqual(result.acceptance.reasons, [
    "installed degradation probes not executed",
    "AI regional evidence policy awaits Issue10 two-garment calibration",
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("samples the same installed Vision process identity until the attempt completes", async () => {
  process.env.NODE_ENV = "test";
  const samples = [
    { processId: 812, startTime: 100, workingSetBytes: 64 },
    { processId: 812, startTime: 100, workingSetBytes: 128 },
    { processId: 812, startTime: 100, workingSetBytes: 96 },
  ];
  const result = await sampleInstalledVisionPeakRssForTest(
    { processId: 812, startTime: 100 },
    async () => samples.shift(),
    async () => samples.length === 0,
  );
  assert.equal(result.peakRssBytes, 128);
  await assert.rejects(
    sampleInstalledVisionPeakRssForTest(
      { processId: 812, startTime: 100 },
      async () => ({ processId: 812, startTime: 101, workingSetBytes: 64 }),
      async () => false,
    ),
    /identity changed/,
  );
});

test("archives held regional evidence without overwriting an existing attempt member", () => {
  const source = readFileSync(
    join(repoRoot, "scripts/testbed/ai-virtual-try-on-installed-entry.mjs"),
    "utf8",
  );
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /physicalIdentity/);
  assert.match(source, /linkSync\(temporary, destination\)/);
  assert.doesNotMatch(
    source,
    /renameSync\(temporary, destination\)|copyFileSync/,
  );
});

test("binds installed garment and RSS facts without inventing a UI garment identity", () => {
  const source = readFileSync(
    join(repoRoot, "scripts/testbed/ai-virtual-try-on-installed-entry.mjs"),
    "utf8",
  );
  assert.match(source, /surface\.variantId !== acceptance\.selectedVariantId/);
  assert.match(
    source,
    /value\.attempt\.garmentSha256 !== collected\.expectedGarmentSha256/,
  );
  assert.doesNotMatch(source, /surface\.garmentId\s*=\s*acceptance\.garmentId/);
  for (const fact of [
    "workerProcessId",
    "workerStartTime",
    "ownerProcessId",
    "ownerStartTime",
    "sampleCount",
    "peakRssBytes",
  ])
    assert.match(source, new RegExp(fact));
  assert.match(source, /GetProcessMemoryInfo/);
  assert.match(source, /PeakWorkingSetSize/);
  assert.match(source, /CreationDate -is \[DateTime\]/);
  assert.match(source, /\$cimStart -cne \$start/);
  assert.match(source, /\$ownerCimStart -cne \$ownerStart/);
  assert.match(source, /\$workerFinal=Get-Process/);
  assert.match(source, /\$finalListener=@\(Get-NetTCPConnection/);
  assert.match(source, /\$ownerFinal=Get-Process/);
  assert.match(
    source,
    /D:\\\\runtime-cache\\\\v1\\\\powershell\\\\7\.4\.6\\\\pwsh\.exe/,
  );
  assert.doesNotMatch(source, /execFileAsync\(\s*["']pwsh["']/);
});

test("rejects a CIM snapshot whose owner PID was reused before its handle opened", () => {
  const productionScript = buildInstalledVisionWorkerSampleScript();
  const body = productionScript.slice(
    productionScript.indexOf("$ownerCim=$main[0]"),
    productionScript.indexOf("$finalListener="),
  );
  const harness = [
    "$mainPath='C:\\VEM\\vision\\app\\vending-vision.exe'",
    "$main=@([pscustomobject]@{ProcessId=41;CreationDate=[datetime]'2025-01-01T00:00:00Z'})",
    "function Get-Process { [pscustomobject]@{Id=41;Handle=[intptr]1;Path=$mainPath;StartTime=[datetime]'2025-01-01T00:00:01Z'} }",
    body,
  ].join(";");
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", harness],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /owner process handle identity mismatched/);
});

test("rejects unsafe or cross-attempt installed RSS support facts", () => {
  process.env.NODE_ENV = "test";
  const value = {
    facts: {
      attempt: {
        attemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2c001",
        caseKey: "short",
        garment: {
          garmentId: "0198f44e-21bd-7c62-8f52-b7c86cc2d001",
          sha256: "a".repeat(64),
        },
        result: { peakRssBytes: 4096 },
      },
      observation: {
        attemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2c001",
        caseKey: "short",
        garmentAssociation: {
          garmentId: "0198f44e-21bd-7c62-8f52-b7c86cc2d001",
          garmentSha256: "a".repeat(64),
          selectedVariantId: "0198f44e-21bd-7c62-8f52-b7c86cc2e001",
        },
        resource: {
          ownerExecutablePath: "C:\\VEM\\vision\\app\\vending-vision.exe",
          ownerProcessId: 10,
          ownerStartTimeTicks: "638900000000000001",
          peakRssBytes: 4096,
          sampleCount: 2,
          workerExecutablePath:
            "C:\\VEM\\vision\\app\\vending-vision-ai-worker\\vending-vision-ai-worker.exe",
          workerParentProcessId: 10,
          workerProcessId: 11,
          workerStartTimeTicks: "638900000000000002",
        },
      },
    },
    kind: "installed-runtime",
    schemaVersion: "vem.testbed.ai-virtual-try-on-support.v1",
  };
  assert.equal(
    validateInstalledAiAttemptSupport(value, "short").attemptId,
    value.facts.attempt.attemptId,
  );
  for (const mutate of [
    (copy) => (copy.facts.observation.resource.ownerProcessId = -1),
    (copy) => (copy.facts.observation.resource.workerProcessId = 10),
    (copy) => (copy.facts.observation.resource.workerProcessId = 2 ** 54),
    (copy) => (copy.facts.observation.resource.workerParentProcessId = 12),
    (copy) =>
      (copy.facts.observation.resource.ownerExecutablePath =
        "C:\\Temp\\vending-vision.exe"),
    (copy) =>
      (copy.facts.observation.resource.workerExecutablePath =
        "C:\\Temp\\vending-vision-ai-worker.exe"),
    (copy) =>
      (copy.facts.observation.garmentAssociation.selectedVariantId =
        "variant-1"),
    (copy) =>
      (copy.facts.observation.resource.workerStartTimeTicks =
        "9007199254740993.0"),
    (copy) => (copy.facts.observation.resource.peakRssBytes = 8192),
    (copy) =>
      (copy.facts.observation.attemptId =
        "0198f44e-21bd-7c62-8f52-b7c86cc2c009"),
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.throws(
      () => validateInstalledAiAttemptSupport(copy, "short"),
      /support evidence is invalid/,
    );
  }
});
