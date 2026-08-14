import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
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
  clearCollectedRegionalEvidenceForRetryForTest,
  expectedInstalledProductRoute,
  expectedInstalledReturnProductRoute,
  expectedInstalledTryOnRoute,
  isVmAcceptanceKeepAiActiveEnabled,
  isVmAcceptanceAiRssSkipEnabled,
  sampleInstalledVisionPeakRssForTest,
  startVmAiActiveHeartbeatForTest,
  validateInstalledAiAttemptSupport,
  validateCorruptDegradationSupport,
  validateMissingDegradationSupport,
  validateWorkerFailureDegradationSupport,
  validateVerifiedOwnerRecoverySupport,
} from "./ai-virtual-try-on-installed-entry.mjs";
import { CdpClient } from "./machine-ui-cdp-driver.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const runner = join(
  repoRoot,
  "scripts/testbed/run-full-ai-virtual-try-on-track.ps1",
);
const ownerModule = join(repoRoot, "scripts/testbed/ai-vision-owner.psm1");
const installedEntry = join(
  repoRoot,
  "scripts/testbed/ai-virtual-try-on-installed-entry.mjs",
);

test("matches the selected catalog item using the Vue hash-route representation", () => {
  const catalogKey = "product:8a768475-d41b-4b5e-ab9c-c52d1b375c13";
  const variantId = "e24dea5e-8b92-4f71-a018-909fdbc6f5b4";
  assert.equal(
    expectedInstalledProductRoute(catalogKey),
    "#/products/product:8a768475-d41b-4b5e-ab9c-c52d1b375c13",
  );
  assert.equal(
    expectedInstalledTryOnRoute(catalogKey, variantId),
    "#/try-on?catalogKey=product:8a768475-d41b-4b5e-ab9c-c52d1b375c13&variantId=e24dea5e-8b92-4f71-a018-909fdbc6f5b4&mode=ai",
  );
  assert.equal(
    expectedInstalledReturnProductRoute(catalogKey, variantId),
    "#/products/product:8a768475-d41b-4b5e-ab9c-c52d1b375c13?variantId=e24dea5e-8b92-4f71-a018-909fdbc6f5b4",
  );
});

test("enables the VM AI RSS bypass only for the exact opt-in value", () => {
  const original = process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS;
  try {
    delete process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS;
    assert.equal(isVmAcceptanceAiRssSkipEnabled(), false);
    process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = "0";
    assert.equal(isVmAcceptanceAiRssSkipEnabled(), false);
    process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = "true";
    assert.equal(isVmAcceptanceAiRssSkipEnabled(), false);
    process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = "1";
    assert.equal(isVmAcceptanceAiRssSkipEnabled(), true);
  } finally {
    if (original === undefined)
      delete process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS;
    else process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = original;
  }
});

test("replaces the accumulated serial session before the ordinary AI sale", () => {
  const source = readFileSync(installedEntry, "utf8");
  const phase = source.indexOf(
    "export async function runInstalledOrdinarySalePhase",
  );
  const replace = source.indexOf("replaceSerialSessionAndUpdateHandoff", phase);
  const sale = source.indexOf("runInstalledOwnerOrdinarySaleCompletion", phase);
  assert.ok(phase >= 0);
  assert.ok(replace > phase);
  assert.ok(sale > replace);
  assert.match(
    source.slice(phase, sale),
    /handoffPath:\s*options\.handoffPath/,
  );
  assert.match(source.slice(phase, sale), /control:\s*controlPlaneRequest/);
});

test("removes only the collected regional sidecar before an AI retry", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const root = mkdtempSync(join(tmpdir(), "vem-ai-retry-sidecar-"));
  const attemptId = "0198f44e-21bd-7c62-8f52-b7c86cc2d001";
  const target = join(root, `${attemptId}.regional-evidence.json`);
  const stale = join(root, "stale.regional-evidence.json");
  const bytes = Buffer.from('{"attempt":"first"}\n');
  try {
    writeFileSync(target, bytes);
    writeFileSync(stale, '{"attempt":"stale"}\n');
    const stat = lstatSync(target, { bigint: true });
    clearCollectedRegionalEvidenceForRetryForTest(
      {
        attemptId,
        regionalEvidence: {
          bytes,
          path: target,
          physicalIdentity: {
            device: String(stat.dev),
            inode: String(stat.ino),
            size: String(stat.size),
          },
        },
      },
      root,
    );
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(stale), true);
    assert.deepEqual(bytes, Buffer.from('{"attempt":"first"}\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("keeps a pending VM AI attempt active with bounded CDP touches and stops", async () => {
  process.env.NODE_ENV = "test";
  const original = process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE;
  const originalRss = process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS;
  const waits = [];
  const touches = [];
  try {
    delete process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE;
    assert.equal(isVmAcceptanceKeepAiActiveEnabled(), false);
    process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE = "0";
    assert.equal(isVmAcceptanceKeepAiActiveEnabled(), false);
    process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE = "true";
    assert.equal(isVmAcceptanceKeepAiActiveEnabled(), false);
    process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE = "1";
    assert.equal(isVmAcceptanceKeepAiActiveEnabled(), true);
    process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = "1";
    assert.equal(isVmAcceptanceAiRssSkipEnabled(), true);
    const heartbeat = startVmAiActiveHeartbeatForTest(
      {
        async send(method, params) {
          touches.push({ method, params });
        },
      },
      {
        intervalMs: 10_000,
        waitForInterval: () => {
          let resolve;
          const promise = new Promise((resolvePromise) => {
            resolve = resolvePromise;
          });
          const wait = {
            cancel() {
              resolve();
            },
            promise,
            resolve,
          };
          waits.push(wait);
          return wait;
        },
      },
    );
    for (let second = 10; second <= 30; second += 10) {
      while (waits.length === 0) await Promise.resolve();
      waits.shift().resolve();
      while (touches.length < (second / 10) * 2) await Promise.resolve();
    }
    assert.deepEqual(
      touches.map(({ method, params }) => [method, params.type]),
      [
        ["Input.dispatchTouchEvent", "touchStart"],
        ["Input.dispatchTouchEvent", "touchEnd"],
        ["Input.dispatchTouchEvent", "touchStart"],
        ["Input.dispatchTouchEvent", "touchEnd"],
        ["Input.dispatchTouchEvent", "touchStart"],
        ["Input.dispatchTouchEvent", "touchEnd"],
      ],
    );
    await heartbeat.stop();
    const stoppedTouchCount = touches.length;
    await Promise.resolve();
    assert.equal(touches.length, stoppedTouchCount);
  } finally {
    if (original === undefined)
      delete process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE;
    else process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE = original;
    if (originalRss === undefined)
      delete process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS;
    else process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = originalRss;
  }
});

test("fails the pending attempt when its VM AI active heartbeat cannot touch", async () => {
  process.env.NODE_ENV = "test";
  const waits = [];
  const heartbeat = startVmAiActiveHeartbeatForTest(
    {
      async send() {
        throw new Error("CDP touch failed");
      },
    },
    {
      waitForInterval: () => {
        let resolve;
        const promise = new Promise((resolvePromise) => {
          resolve = resolvePromise;
        });
        const wait = { cancel: resolve, promise, resolve };
        waits.push(wait);
        return wait;
      },
    },
  );
  while (waits.length === 0) await Promise.resolve();
  waits.shift().resolve();
  await new Promise(setImmediate);
  await assert.rejects(heartbeat.stop(), /VM AI active heartbeat failed/);
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function writeCanonical(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
  writeFileSync(path, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

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

test("routes corrupt model degradation through the public installed command and runner", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-corrupt-command-"));
  try {
    const guestInput = join(root, "guest-input.json");
    const handoff = join(root, "handoff.json");
    const output = join(root, "corrupt-model-degradation.json");
    writeFileSync(guestInput, "{}\n");
    writeFileSync(handoff, "{}\n");
    const result = spawnSync(
      process.execPath,
      [
        installedEntry,
        "degradation",
        "--fault",
        "corrupt",
        "--guest-input",
        guestInput,
        "--handoff",
        handoff,
        "--out",
        output,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /fault must be missing/);
    assert.match(
      result.stderr,
      /installed degradation daemon handoff is invalid/,
    );
    assert.equal(existsSync(output), false);
    const source = readFileSync(runner, "utf8");
    assert.match(source, /New-TestbedCorruptModelPack/);
    assert.match(source, /Restart-TestbedAiDegradedVisionOwner[^\n]*corrupt/);
    assert.match(source, /degradation --fault corrupt/);
    assert.match(source, /--corrupt-degradation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes official installed worker failure through the public command and runner", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-worker-failure-command-"));
  try {
    const guestInput = join(root, "guest-input.json");
    const handoff = join(root, "handoff.json");
    const output = join(root, "worker-failure-degradation.json");
    writeFileSync(guestInput, "{}\n");
    writeFileSync(handoff, "{}\n");
    const result = spawnSync(
      process.execPath,
      [
        installedEntry,
        "degradation",
        "--fault",
        "worker",
        "--guest-input",
        guestInput,
        "--handoff",
        handoff,
        "--out",
        output,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /fault must be missing or corrupt/);
    assert.match(
      result.stderr,
      /installed degradation daemon handoff is invalid/,
    );
    assert.equal(existsSync(output), false);
    const source = readFileSync(runner, "utf8");
    assert.match(source, /Restart-TestbedAiDegradedVisionOwner[^\n]*worker/);
    assert.match(source, /degradation --fault worker/);
    assert.match(source, /--worker-failure-degradation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proves missing model degradation from product detail without catalog-page evidence", async () => {
  assert.doesNotMatch(
    readFileSync(
      join(repoRoot, "scripts/testbed/ai-installed-degradation.mjs"),
      "utf8",
    ),
    /catalog-page/,
  );
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

test("accepts only exact corrupt model six-truth support", () => {
  const value = {
    facts: {
      degradation: {
        diagnostic: "model_pack_invalid",
        facts: {
          aiReady: false,
          coreReady: true,
          daemonReady: true,
          fastReady: true,
          machineUiAvailable: true,
          saleAvailable: true,
        },
        fault: "corrupt",
      },
    },
    kind: "installed-runtime",
    schemaVersion: "vem.testbed.ai-virtual-try-on-support.v1",
  };
  assert.deepEqual(
    validateCorruptDegradationSupport(value),
    value.facts.degradation.facts,
  );
  const copy = structuredClone(value);
  copy.facts.degradation.facts.saleAvailable = false;
  assert.throws(
    () => validateCorruptDegradationSupport(copy),
    /support evidence is invalid/,
  );
});

test("accepts only exact worker failure six-truth support", () => {
  const value = {
    facts: {
      degradation: {
        diagnostic: "worker_unavailable",
        facts: {
          aiReady: false,
          coreReady: true,
          daemonReady: true,
          fastReady: true,
          machineUiAvailable: true,
          saleAvailable: true,
        },
        fault: "worker",
      },
    },
    kind: "installed-runtime",
    schemaVersion: "vem.testbed.ai-virtual-try-on-support.v1",
  };
  assert.deepEqual(
    validateWorkerFailureDegradationSupport(value),
    value.facts.degradation.facts,
  );
  for (const mutate of [
    (copy) => (copy.facts.degradation.diagnostic = "model_pack_missing"),
    (copy) => (copy.facts.degradation.fault = "missing"),
    (copy) => (copy.facts.degradation.facts.daemonReady = false),
  ]) {
    const copy = structuredClone(value);
    mutate(copy);
    assert.throws(
      () => validateWorkerFailureDegradationSupport(copy),
      /worker model degradation support evidence is invalid/,
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
  assert.match(source, /"--missing-degradation", \$missingFacts/);
  assert.match(source, /Restore-TestbedDefaultVisionOwner/);
  assert.match(source, /default-owner-restoration\.json/);
  assert.match(source, /aiEnvironmentCleared = \$true/);
});

test("AI owner cleanup removes every process from the canonical Vision executable", () => {
  const source = readFileSync(ownerModule, "utf8");
  assert.doesNotMatch(
    source,
    /throw "Vision bootstrap found unknown canonical executable processes/,
  );
  assert.doesNotMatch(source, /Assert-TestbedNoUnknownCanonicalVisionProcesses/);
  assert.match(
    source,
    /remaining = @\(\$processes\.managed\) \+ @\(\$processes\.unknown\)/,
  );
  assert.match(
    source,
    /Stop-Process -Id \(\[int\]\$process\.ProcessId\) -Force/,
  );
});

test("sums ordered directory identities without Measure-Object property binding", () => {
  const source = readFileSync(runner, "utf8");
  assert.doesNotMatch(source, /Measure-Object -Property byteSize/);
  assert.match(source, /foreach \(\$entry in \$actual\)[\s\S]*\$bytes \+= \[long\]\$entry\.byteSize/);
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

test("failed AI tracks retain completed phase artifacts without publishing aggregate acceptance", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(
    source,
    /Complete-TestbedAiAcceptanceArtifacts[\s\S]{0,100}-OutPath \$OutPath[\s\S]{0,100}-TrackSucceeded \$trackSucceeded/,
  );
  const failedCleanup = source.slice(
    source.indexOf("if (-not $trackSucceeded)"),
    source.indexOf("if ($cleanupFailures.Count -gt 0)"),
  );
  assert.doesNotMatch(failedCleanup, /Remove-TestbedAiAcceptanceArtifactRoot/);
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
    "acceptanceAuthorityReceipt",
    "phase",
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
  assert.match(source, /vem\.testbed\.ai-acceptance-authority\/v1/);
  assert.match(source, /\$phase -notin @\("measurement", "formal"\)/);
  assert.match(source, /if \(\$phase -eq "formal"\)/);
  assert.match(source, /run-ai-regional-measurement\.mjs/);
  assert.match(source, /installed AI regional measurement collection failed/);
  assert.doesNotMatch(
    source,
    /AI measurement execution is staged but is not acceptance evidence/,
  );
  assert.doesNotMatch(source, /calibrationSourceRoot/);
  assert.match(
    source,
    /installed Vision core identity does not match acceptance authority/,
  );
  assert.match(
    source,
    /materialized model pack does not match acceptance authority/,
  );
  assert.match(source, /\^https:\/\//);
  assert.doesNotMatch(
    source,
    /Start-Process[^\n]*worker|--probe-runtime|--model-pack/,
  );
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod|WebClient/);
  assert.doesNotMatch(source, /camera|captureUserMedia|getUserMedia/i);
});

test("assembles worker-failure support so only calibration stays fail closed", async () => {
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
      workerFailure: {
        aiReady: false,
        coreReady: true,
        daemonReady: true,
        fastReady: true,
        machineUiAvailable: true,
        saleAvailable: true,
      },
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
  assert.deepEqual(result.report.degradations.workerFailure, {
    aiReady: false,
    coreReady: true,
    daemonReady: true,
    fastReady: true,
    machineUiAvailable: true,
    saleAvailable: true,
  });
  assert.equal(result.report.postAi.ordinarySaleCompleted, true);
  assert.equal(result.acceptance.ok, false);
  assert.deepEqual(result.acceptance.reasons, [
    "AI regional evidence policy awaits Issue10 two-garment calibration",
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("admits calibrated two-garment evidence only with mandatory screenshots and return journeys", async () => {
  process.env.NODE_ENV = "test";
  const root = mkdtempSync(join(tmpdir(), "vem-ai-calibrated-success-"));
  const identities = {
    aiRuntime: "3".repeat(64),
    contract: "2".repeat(64),
    modelPack: "4".repeat(64),
    runtime: "1".repeat(64),
  };
  const policyPath = join(root, "calibrated-policy.json");
  const policy = {
    algorithm: "rgb-absolute-delta-rle/v1",
    atrEvaluator: "schp-atr",
    calibrationStatus: "calibrated_issue10",
    lipEvaluator: "schp-lip",
    maximumProtectedChangedFractionBps: 0,
    maximumProtectedMeanDelta: 0,
    minimumUpperBodyChangedFractionBps: 10_000,
    minimumUpperBodyMeanDelta: 1,
    minimumUpperBodySampledPixels: 1024,
    poseEvaluator: "mediapipe-pose",
    schemaVersion: "vem-ai-regional-evidence-policy/v1",
    sourceDescriptorSha256: "0".repeat(64),
  };
  const policySha256 = writeCanonical(policyPath, policy);
  const receiptPath = join(root, "calibration-receipt.json");
  writeCanonical(receiptPath, {
    acceptanceReportSha256: "a".repeat(64),
    attempts: [{ caseKey: "short" }, { caseKey: "long" }],
    calibrationInputSha256: "b".repeat(64),
    derivedThresholds: {
      maximumProtectedChangedFractionBps: 0,
      maximumProtectedMeanDelta: 0,
      minimumUpperBodyChangedFractionBps: 10_000,
      minimumUpperBodyMeanDelta: 1,
    },
    policySha256,
    acceptanceAuthorityReceiptSha256: "c".repeat(64),
    recoverySupportSha256: "d".repeat(64),
    release: identities,
    releaseProofSha256: "e".repeat(64),
    schemaVersion: "vem-ai-regional-evidence-calibration-receipt/v2",
  });
  const attempt = (digit, caseKey) => ({
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
    surface: { garmentId: `0198f44e-21bd-7c62-8f52-b7c86cc2d00${digit}` },
    regionalEvidence: { bytes: Buffer.from("{}\n") },
    ...(caseKey === "short" ? { screenshots: [] } : {}),
  });
  const input = {
    attempts: [attempt("1", "short"), attempt("5", "long")],
    artifactRoot: root,
    calibratedPolicyPath: policyPath,
    calibrationReceiptPath: receiptPath,
    identities,
    workerFailure: {
      aiReady: false,
      coreReady: true,
      daemonReady: true,
      fastReady: true,
      machineUiAvailable: true,
      saleAvailable: true,
    },
  };
  await assert.rejects(
    assembleInstalledAiTryOnAcceptanceForTest(input, {
      ordinarySale: async () => ({ ok: true }),
    }),
    /installed AI attempt set failed|screenshot evidence|receipt attempt binding/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("does not synthesize a short return owner from attempt array position", async () => {
  process.env.NODE_ENV = "test";
  const root = mkdtempSync(join(tmpdir(), "vem-ai-journey-owner-"));
  const collected = (caseKey, digit) => {
    const attemptId = `0198f44e-21bd-7c62-8f52-b7c86cc2c00${digit}`;
    const garmentId = `0198f44e-21bd-7c62-8f52-b7c86cc2d00${digit}`;
    const selectedCatalogKey = `product:${caseKey}`;
    return {
      attemptId,
      durationMs: 12_000,
      journey: {
        catalogRoute: "#/catalog",
        categorySelector:
          '[data-test="catalog-category"][data-category-key="tshirts"]',
        productRoute: expectedInstalledProductRoute(selectedCatalogKey),
        productSelector: `[data-test="catalog-product"][data-catalog-key="${selectedCatalogKey}"]`,
        resultAttemptId: attemptId,
        resultRoute: expectedInstalledTryOnRoute(
          selectedCatalogKey,
          garmentId,
        ),
        returnedCatalogRoute: "#/catalog",
        returnProductRoute: expectedInstalledReturnProductRoute(
          selectedCatalogKey,
          garmentId,
        ),
        selectedCatalogKey,
        selectedVariantId: garmentId,
        startSelector: '[data-test="try-on-ai"]',
      },
      lifecycle: ["acquiring", "generating", "completed"],
      peakRssBytes: 512 * 1024 * 1024,
      regionalEvidence: { bytes: Buffer.from("{}\n") },
      resultEvidence: {
        contentType: "image/png",
        height: 1024,
        sha256: digit.repeat(64),
        width: 768,
      },
      surface: { garmentId },
    };
  };
  await assert.rejects(
    assembleInstalledAiTryOnAcceptanceForTest(
      {
        artifactRoot: root,
        attempts: [collected("short", "1"), collected("long", "5")],
        identities: {
          aiRuntime: "3".repeat(64),
          contract: "2".repeat(64),
          modelPack: "4".repeat(64),
          runtime: "1".repeat(64),
        },
        workerFailure: {
          aiReady: false,
          coreReady: true,
          daemonReady: true,
          fastReady: true,
          machineUiAvailable: true,
          saleAvailable: true,
        },
      },
      { ordinarySale: async () => ({ ok: true }) },
    ),
    /installed AI attempt set failed/,
  );
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

test("identifies the installed Vision owner by its unique listener when fork children share the executable", () => {
  const productionScript = buildInstalledVisionWorkerSampleScript();
  const body = productionScript.slice(
    productionScript.indexOf("$all="),
    productionScript.indexOf("$owned="),
  );
  const harness = [
    "$mainPath=[IO.Path]::GetFullPath('C:\\VEM\\vision\\app\\vending-vision.exe')",
    "function Get-CimInstance { @([pscustomobject]@{ProcessId=41;ParentProcessId=9;ExecutablePath=$mainPath},[pscustomobject]@{ProcessId=42;ParentProcessId=41;ExecutablePath=$mainPath},[pscustomobject]@{ProcessId=43;ParentProcessId=41;ExecutablePath=$mainPath}) }",
    "function Get-NetTCPConnection { @([pscustomobject]@{OwningProcess=41}) }",
    body,
    "[Console]::Out.Write([string]$main[0].ProcessId)",
  ].join(";");
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", harness],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "41");
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
  assert.doesNotMatch(source, /CreationDate -is \[DateTime\]/);
  assert.match(source, /\$workerFinal=Get-Process/);
  assert.match(source, /\$finalListener=@\(Get-NetTCPConnection/);
  assert.match(source, /\$ownerFinal=Get-Process/);
  assert.match(
    source,
    /D:\\\\runtime-cache\\\\v1\\\\powershell\\\\7\.4\.6\\\\pwsh\.exe/,
  );
  assert.doesNotMatch(source, /execFileAsync\(\s*["']pwsh["']/);
});

test("accepts harmless CIM start-time rounding while retaining handle identity", () => {
  const productionScript = buildInstalledVisionWorkerSampleScript();
  const harness = [
    "function Get-CimInstance { @([pscustomobject]@{ProcessId=41;ParentProcessId=9;ExecutablePath='C:\\VEM\\vision\\app\\vending-vision.exe';CreationDate=[datetime]'2025-01-01T00:00:00.0000000Z'}) }",
    "function Get-NetTCPConnection { @([pscustomobject]@{OwningProcess=41}) }",
    "function Get-Process { [pscustomobject]@{Id=41;Handle=[intptr]1;Path='C:\\VEM\\vision\\app\\vending-vision.exe';StartTime=[datetime]'2025-01-01T00:00:00.0000001Z'} }",
    productionScript,
  ].join(";");
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", harness],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).owner.processId, 41);
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
