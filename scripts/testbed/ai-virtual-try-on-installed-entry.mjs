#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { collectInstalledAiDegradationEvidence } from "./ai-installed-degradation.mjs";
import {
  controlPlaneRequest,
  runInstalledOwnerOrdinarySaleCompletion,
} from "./fast-route-stress-sale.mjs";
import { AI_SUPPORT_EVIDENCE_SCHEMA } from "./full-workflow-evidence-manifest.mjs";
import {
  catalogCategorySelectorForFixture,
  catalogProductSelectorForFixture,
} from "./full-workflow-fixtures.mjs";
import { restoreCatalogHomeFromClient } from "./full-workflow-orchestrator.mjs";
import { validateAiAttemptSet } from "./full-workflow-validator.mjs";
import {
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  rewriteWebSocketDebuggerUrl,
  activateVisibleSelector,
  captureScreenshot,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.mjs";
import { AI_ATTEMPT_ACCEPTANCE_TIMEOUT_MS } from "./try-on-timeouts.mjs";
import { collectInstalledAiTryOnAttempt } from "./vision-try-on-acceptance.mjs";

const CASES = Object.freeze({
  short: "tshirt_short_sleeve",
  long: "tshirt_long_sleeve",
});
const execFileAsync = promisify(execFile);
const TRUSTED_POWERSHELL = "D:\\runtime-cache\\v1\\powershell\\7.4.6\\pwsh.exe";
const OWNER_EXECUTABLE = "C:\\VEM\\vision\\app\\vending-vision.exe";
const WORKER_EXECUTABLE =
  "C:\\VEM\\vision\\app\\vending-vision-ai-worker\\vending-vision-ai-worker.exe";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RETRY_LIFECYCLE = Object.freeze(["acquiring", "generating", "completed"]);

export function isVmAcceptanceAiRssSkipEnabled() {
  return process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS === "1";
}

export function isVmAcceptanceKeepAiActiveEnabled() {
  return process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE === "1";
}

function projectInstalledAiRetryLifecycle(lifecycle, attemptId) {
  if (!Array.isArray(lifecycle) || !UUID_PATTERN.test(attemptId ?? ""))
    throw new Error("AI retry lifecycle is invalid");
  const projected = [];
  for (const entry of lifecycle) {
    if (
      entry?.attemptId !== attemptId ||
      !RETRY_LIFECYCLE.includes(entry.phase) ||
      projected.at(-1) === entry.phase
    )
      continue;
    projected.push(entry.phase);
  }
  if (JSON.stringify(projected) !== JSON.stringify(RETRY_LIFECYCLE))
    throw new Error("AI retry lifecycle is invalid");
  return projected;
}

export function projectInstalledAiRetryLifecycleForTest(lifecycle, attemptId) {
  if (process.env.NODE_ENV !== "test")
    throw new Error("AI retry lifecycle test boundary requires NODE_ENV=test");
  return projectInstalledAiRetryLifecycle(lifecycle, attemptId);
}

function waitForHeartbeatInterval(intervalMs) {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  const timer = setTimeout(resolve, intervalMs);
  return {
    cancel() {
      clearTimeout(timer);
      resolve();
    },
    promise,
  };
}

function startVmAiActiveHeartbeat(
  client,
  { intervalMs = 10_000, waitForInterval = waitForHeartbeatInterval } = {},
) {
  let stopped = false;
  let currentWait = null;
  let failure = null;
  const task = (async () => {
    while (!stopped) {
      currentWait = waitForInterval(intervalMs);
      await currentWait.promise;
      currentWait = null;
      if (stopped) return;
      await client.send("Input.dispatchTouchEvent", {
        touchPoints: [{ x: 1, y: 1 }],
        type: "touchStart",
      });
      await client.send("Input.dispatchTouchEvent", {
        touchPoints: [],
        type: "touchEnd",
      });
    }
  })().catch((error) => {
    failure = error;
  });
  return {
    async stop() {
      stopped = true;
      currentWait?.cancel();
      await task;
      if (failure)
        throw new Error("VM AI active heartbeat failed", { cause: failure });
    },
  };
}

export function startVmAiActiveHeartbeatForTest(client, options) {
  if (process.env.NODE_ENV !== "test")
    throw new Error(
      "VM AI active heartbeat test boundary requires NODE_ENV=test",
    );
  return startVmAiActiveHeartbeat(client, options);
}

async function collectInstalledAiTryOnAttemptWithVmHeartbeat(options) {
  const heartbeat = isVmAcceptanceKeepAiActiveEnabled()
    ? startVmAiActiveHeartbeat(options.client)
    : null;
  try {
    return await collectInstalledAiTryOnAttempt(options);
  } finally {
    if (heartbeat) await heartbeat.stop();
  }
}

export async function collectInstalledAiOwnerAttempts({
  collectAttempt = collectInstalledAiTryOnAttemptWithVmHeartbeat,
  initialOptions,
  retryOptions = null,
  readRuntimeTraceSnapshot,
  afterInitial = null,
  onInitialSettled = null,
  onInitialStarted = null,
}) {
  if (
    typeof collectAttempt !== "function" ||
    typeof readRuntimeTraceSnapshot !== "function" ||
    !initialOptions ||
    typeof initialOptions !== "object" ||
    (retryOptions !== null &&
      (!retryOptions || typeof retryOptions !== "object")) ||
    (afterInitial !== null && typeof afterInitial !== "function") ||
    (onInitialSettled !== null && typeof onInitialSettled !== "function") ||
    (onInitialStarted !== null && typeof onInitialStarted !== "function")
  )
    throw new Error("installed AI owner inputs are invalid");
  let initial;
  try {
    initial = await collectAttempt({
      ...initialOptions,
      activationSelector:
        initialOptions.activationSelector ?? '[data-test="try-on-ai"]',
      onStarted: onInitialStarted,
      readRuntimeTraceSnapshot,
      timeoutMs: AI_ATTEMPT_ACCEPTANCE_TIMEOUT_MS,
    });
  } finally {
    await onInitialSettled?.();
  }
  await afterInitial?.(initial);
  const retry = retryOptions
    ? await collectAttempt({
        ...retryOptions,
        activationSelector:
          retryOptions.activationSelector ?? '[data-test="try-on-retry"]',
        readRuntimeTraceSnapshot,
        timeoutMs: AI_ATTEMPT_ACCEPTANCE_TIMEOUT_MS,
      })
    : null;
  return { initial, retry };
}

export function buildInstalledVisionWorkerSampleScript() {
  return [
    "$ErrorActionPreference='Stop'",
    `$mainPath=[IO.Path]::GetFullPath('${OWNER_EXECUTABLE}')`,
    `$workerPath=[IO.Path]::GetFullPath('${WORKER_EXECUTABLE}')`,
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class VemMemory { [StructLayout(LayoutKind.Sequential)] public struct PMC { public uint cb; public uint PageFaultCount; public UIntPtr PeakWorkingSetSize; public UIntPtr WorkingSetSize; public UIntPtr QuotaPeakPagedPoolUsage; public UIntPtr QuotaPagedPoolUsage; public UIntPtr QuotaPeakNonPagedPoolUsage; public UIntPtr QuotaNonPagedPoolUsage; public UIntPtr PagefileUsage; public UIntPtr PeakPagefileUsage; } [DllImport(\"psapi.dll\",SetLastError=true)] public static extern bool GetProcessMemoryInfo(IntPtr hProcess,out PMC counters,uint size); }'",
    "$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$canonical=@($all|Where-Object{$_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $mainPath})",
    "$listener=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 7892 -State Listen -ErrorAction Stop)",
    "if($listener.Count -ne 1){throw 'canonical Vision owner identity is ambiguous'}",
    "$main=@($canonical|Where-Object{[int]$_.ProcessId -eq [int]$listener[0].OwningProcess})",
    "if($main.Count -ne 1){throw 'canonical Vision owner identity is ambiguous'}",
    "$owned=[Collections.Generic.HashSet[int]]::new();[void]$owned.Add([int]$main[0].ProcessId)",
    "do{$changed=$false;foreach($p in $all){if($owned.Contains([int]$p.ParentProcessId)-and $owned.Add([int]$p.ProcessId)){$changed=$true}}}while($changed)",
    "$workers=@($all|Where-Object{$owned.Contains([int]$_.ProcessId)-and $_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $workerPath})",
    "$workerFacts=@($workers|ForEach-Object{$cim=$_;$p=Get-Process -Id ([int]$cim.ProcessId) -ErrorAction Stop;$handle=$p.Handle;$start=[string]$p.StartTime.ToUniversalTime().Ticks;$exe=[IO.Path]::GetFullPath($p.Path);if($exe -ine $workerPath -or [int]$cim.ParentProcessId -ne [int]$main[0].ProcessId){throw 'worker process handle identity mismatched'};$c=[VemMemory+PMC]::new();$c.cb=[Runtime.InteropServices.Marshal]::SizeOf($c);if(-not [VemMemory]::GetProcessMemoryInfo($handle,[ref]$c,$c.cb)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};$workerFinal=Get-Process -Id ([int]$cim.ProcessId) -ErrorAction Stop;if([IO.Path]::GetFullPath($workerFinal.Path) -ine $workerPath -or [string]$workerFinal.StartTime.ToUniversalTime().Ticks -cne $start){throw 'worker PID was reused'};[ordered]@{executablePath=$workerPath;parentProcessId=[int]$cim.ParentProcessId;peakWorkingSetBytes=[string][uint64]$c.PeakWorkingSetSize;processId=[int]$p.Id;startTimeTicks=$start}})",
    "$ownerCim=$main[0];$owner=Get-Process -Id ([int]$ownerCim.ProcessId) -ErrorAction Stop;$ownerHandle=$owner.Handle;$ownerStart=[string]$owner.StartTime.ToUniversalTime().Ticks;$ownerExe=[IO.Path]::GetFullPath($owner.Path);if($ownerExe -ine $mainPath){throw 'owner process handle identity mismatched'}",
    "$finalListener=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 7892 -State Listen -ErrorAction Stop);$ownerFinal=Get-Process -Id ([int]$owner.Id) -ErrorAction Stop;if($finalListener.Count -ne 1 -or [int]$finalListener[0].OwningProcess -ne [int]$owner.Id -or [IO.Path]::GetFullPath($ownerFinal.Path) -ine $mainPath -or [string]$ownerFinal.StartTime.ToUniversalTime().Ticks -cne $ownerStart){throw 'owner process final identity mismatched'}",
    "[Console]::Out.Write((@{owner=@{executablePath=$mainPath;processId=[int]$owner.Id;startTimeTicks=$ownerStart};workers=$workerFacts}|ConvertTo-Json -Compress -Depth 4))",
  ].join(";");
}

async function readInstalledVisionWorkerSample() {
  if (process.platform !== "win32")
    throw new Error("installed Vision RSS sampling requires Windows");
  const script = buildInstalledVisionWorkerSampleScript();
  const { stdout } = await execFileAsync(
    TRUSTED_POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

async function sampleInstalledAiWorkerPeakRss(completed) {
  const deadline = performance.now() + 120_000;
  let ownerIdentity = null;
  let workerIdentity = null;
  let peakRssBytes = 0;
  let sampleCount = 0;
  while (performance.now() < deadline) {
    const sample = await readInstalledVisionWorkerSample();
    ownerIdentity ??= sample.owner;
    if (
      sample.owner?.processId !== ownerIdentity.processId ||
      sample.owner?.startTimeTicks !== ownerIdentity.startTimeTicks
    )
      throw new Error(
        "installed Vision owner identity changed during AI attempt",
      );
    if (sample.workers.length > 1)
      throw new Error("installed AI worker identity is ambiguous");
    if (sample.workers.length === 1) {
      const worker = sample.workers[0];
      workerIdentity ??= {
        processId: worker.processId,
        startTimeTicks: worker.startTimeTicks,
        executablePath: worker.executablePath,
        parentProcessId: worker.parentProcessId,
      };
      if (
        worker.processId !== workerIdentity.processId ||
        worker.startTimeTicks !== workerIdentity.startTimeTicks ||
        worker.executablePath !== workerIdentity.executablePath ||
        worker.parentProcessId !== workerIdentity.parentProcessId
      )
        throw new Error("installed AI worker identity changed during attempt");
      if (!/^[1-9][0-9]*$/.test(worker.peakWorkingSetBytes))
        throw new Error("installed AI worker peak RSS is invalid");
      const observedPeak = Number(worker.peakWorkingSetBytes);
      if (!Number.isSafeInteger(observedPeak))
        throw new Error("installed AI worker peak RSS exceeds safe JSON range");
      peakRssBytes = Math.max(peakRssBytes, observedPeak);
      sampleCount += 1;
    }
    if (completed()) {
      if (!workerIdentity || peakRssBytes <= 0)
        throw new Error("installed AI worker RSS was not observed");
      return { peakRssBytes, sampleCount, workerIdentity, ownerIdentity };
    }
    await sleep(100);
  }
  throw new Error("installed AI worker RSS sampler timed out");
}

async function samplePeakRss(
  expectedIdentity,
  readSample,
  completed,
  { timeoutMs = 120_000, intervalMs = 100 } = {},
) {
  const deadline = performance.now() + timeoutMs;
  let peakRssBytes = 0;
  let sampleCount = 0;
  while (true) {
    if (performance.now() >= deadline)
      throw new Error("installed Vision RSS sampler timed out");
    const sample = await readSample();
    if (
      sample?.processId !== expectedIdentity.processId ||
      sample?.startTime !== expectedIdentity.startTime
    )
      throw new Error(
        "installed Vision process identity changed during RSS sampling",
      );
    if (
      !Number.isSafeInteger(sample.workingSetBytes) ||
      sample.workingSetBytes <= 0
    )
      throw new Error("installed Vision RSS sample is invalid");
    peakRssBytes = Math.max(peakRssBytes, sample.workingSetBytes);
    sampleCount += 1;
    if (await completed()) return { peakRssBytes, sampleCount };
    await sleep(intervalMs);
  }
}

export async function sampleInstalledVisionPeakRssForTest(
  expectedIdentity,
  readSample,
  completed,
) {
  if (process.env.NODE_ENV !== "test")
    throw new Error(
      "installed Vision RSS sampler test boundary requires NODE_ENV=test",
    );
  return samplePeakRss(expectedIdentity, readSample, completed, {
    timeoutMs: 1_000,
    intervalMs: 0,
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCanonicalJson(path, label, { trailingNewline = true } = {}) {
  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
  const expected = trailingNewline
    ? canonicalBytes(value)
    : Buffer.from(JSON.stringify(canonical(value)));
  if (!bytes.equals(expected))
    throw new Error(`${label} is not canonical JSON`);
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

function writeExclusiveCanonical(path, value) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("AI acceptance output path must be absolute");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, canonicalBytes(value), { flag: "wx", mode: 0o600 });
}

function resolveContainedArtifactMember(artifactRoot, memberPath, label) {
  const root = resolve(artifactRoot);
  const path = resolve(root, memberPath);
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error(`${label} is outside the artifact root`);
  return path;
}

function provisionalSidecarManifest(attempts, artifactRoot) {
  return {
    files: attempts.flatMap((attempt) => {
      const sidecarPath = resolveContainedArtifactMember(
        artifactRoot,
        attempt.regionalEvidence.path,
        "AI regional evidence member",
      );
      const stat = lstatSync(sidecarPath);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("AI regional evidence member is not regular");
      const bytes = readFileSync(sidecarPath);
      return [
        {
          byteLength: bytes.byteLength,
          kind: "supportingEvidence",
          path: sidecarPath,
          sha256: sha256(bytes),
          track: "aiVirtualTryOn",
        },
        ...attempt.screenshots.map((screenshot) => {
          const path = resolve(artifactRoot, screenshot.path);
          const image = readFileSync(path);
          return {
            byteLength: image.byteLength,
            kind: "screenshots",
            path,
            sha256: sha256(image),
            track: "aiVirtualTryOn",
          };
        }),
      ];
    }),
  };
}

function validateArchivedRegionalSidecars(attempts, artifactRoot, manifest) {
  for (const attempt of attempts) {
    const reference = attempt.regionalEvidence;
    const path = resolveContainedArtifactMember(
      artifactRoot,
      reference.path,
      "AI regional evidence member",
    );
    const stat = lstatSync(path);
    const bytes = readFileSync(path);
    const manifestOwned = manifest.files?.some(
      (file) =>
        file.track === "aiVirtualTryOn" &&
        file.kind === "supportingEvidence" &&
        file.path === path &&
        file.byteLength === bytes.byteLength &&
        file.sha256 === reference.sha256,
    );
    const sidecar = readCanonicalJson(path, "AI regional evidence member");
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      sha256(bytes) !== reference.sha256 ||
      !manifestOwned ||
      sidecar.verdict !== "passed" ||
      sidecar.attempt?.inputSha256 !== attempt.input.sha256 ||
      sidecar.attempt?.garmentSha256 !== attempt.garment.sha256 ||
      sidecar.attempt?.resultSha256 !== attempt.result.sha256 ||
      sidecar.attempt?.decodedWidth !== attempt.result.decodedWidth ||
      sidecar.attempt?.decodedHeight !== attempt.result.decodedHeight
    )
      throw new Error("AI regional evidence archive binding is invalid");
  }
}

function validateAttemptScreenshotArtifacts(attempts, artifactRoot, manifest) {
  for (const attempt of attempts) {
    for (const screenshot of attempt.screenshots ?? []) {
      const path = resolve(artifactRoot, screenshot.path);
      const stat = lstatSync(path);
      const bytes = readFileSync(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        bytes.byteLength !== screenshot.byteLength ||
        sha256(bytes) !== screenshot.sha256 ||
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        !manifest.files?.some(
          (file) =>
            file.track === "aiVirtualTryOn" &&
            file.kind === "screenshots" &&
            resolve(file.path) === path &&
            file.byteLength === screenshot.byteLength &&
            file.sha256 === screenshot.sha256,
        )
      )
        throw new Error(
          "AI attempt screenshot evidence is invalid or not manifest-owned",
        );
    }
  }
}

function supportEvidence(kind, facts) {
  return { facts, kind, schemaVersion: AI_SUPPORT_EVIDENCE_SCHEMA };
}

const DEGRADATION_FACT_KEYS = Object.freeze([
  "aiReady",
  "coreReady",
  "daemonReady",
  "fastReady",
  "machineUiAvailable",
  "saleAvailable",
]);

function validateDegradationSupport(value, expectedFault, expectedDiagnostic) {
  const degradation = value?.facts?.degradation;
  const facts = degradation?.facts;
  if (
    JSON.stringify(Object.keys(value ?? {}).sort()) !==
      JSON.stringify(["facts", "kind", "schemaVersion"]) ||
    value.schemaVersion !== AI_SUPPORT_EVIDENCE_SCHEMA ||
    value.kind !== "installed-runtime" ||
    JSON.stringify(Object.keys(value.facts ?? {}).sort()) !==
      JSON.stringify(["degradation"]) ||
    JSON.stringify(Object.keys(degradation ?? {}).sort()) !==
      JSON.stringify(["diagnostic", "facts", "fault"]) ||
    JSON.stringify(Object.keys(facts ?? {}).sort()) !==
      JSON.stringify(DEGRADATION_FACT_KEYS) ||
    degradation.diagnostic !== expectedDiagnostic ||
    degradation.fault !== expectedFault ||
    facts.aiReady !== false ||
    DEGRADATION_FACT_KEYS.filter((key) => key !== "aiReady").some(
      (key) => facts[key] !== true,
    )
  )
    throw new Error(
      `${expectedFault} model degradation support evidence is invalid`,
    );
  return facts;
}

export function validateMissingDegradationSupport(value) {
  return validateDegradationSupport(value, "missing", "model_pack_missing");
}

export function validateCorruptDegradationSupport(value) {
  return validateDegradationSupport(value, "corrupt", "model_pack_invalid");
}

export function validateWorkerFailureDegradationSupport(value) {
  return validateDegradationSupport(value, "worker", "worker_unavailable");
}

export function validateVerifiedOwnerRecoverySupport(value, proof) {
  const recovery = value?.facts?.recovery;
  if (
    JSON.stringify(Object.keys(value ?? {}).sort()) !==
      JSON.stringify(["facts", "kind", "schemaVersion"]) ||
    value.schemaVersion !== AI_SUPPORT_EVIDENCE_SCHEMA ||
    value.kind !== "installed-runtime" ||
    JSON.stringify(Object.keys(value.facts ?? {}).sort()) !==
      JSON.stringify(["recovery"]) ||
    JSON.stringify(Object.keys(recovery ?? {}).sort()) !==
      JSON.stringify([
        "aiReadinessDiagnostic",
        "aiReady",
        "modelPackSha256",
        "runtimeDescriptorSha256",
        "sourceCommit",
        "workerExecutableSha256",
      ]) ||
    recovery.aiReady !== true ||
    recovery.aiReadinessDiagnostic !== "ready" ||
    recovery.modelPackSha256 !== proof.modelPack.archive.sha256 ||
    recovery.runtimeDescriptorSha256 !==
      proof.resources.runtimeDescriptorSha256 ||
    recovery.sourceCommit !== proof.candidate.sourceCommit ||
    typeof recovery.workerExecutableSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(recovery.workerExecutableSha256)
  )
    throw new Error("verified AI owner recovery support evidence is invalid");
  return recovery;
}

function requireDigest(value, label) {
  const normalized = String(value ?? "").replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(normalized))
    throw new Error(`${label} is invalid`);
  return normalized;
}

function sidecarAttemptFacts(value, collected, caseKey) {
  if (
    value?.schemaVersion !== "vem-ai-regional-evidence/v1" ||
    value?.kind !== "regional-evidence" ||
    value?.attempt?.resultSha256 !== collected.resultEvidence.sha256 ||
    value?.attempt?.decodedWidth !== collected.resultEvidence.width ||
    value?.attempt?.decodedHeight !== collected.resultEvidence.height
  )
    throw new Error(`${caseKey} regional sidecar does not bind its result`);
  if (value.attempt.garmentSha256 !== collected.expectedGarmentSha256)
    throw new Error(`${caseKey} regional sidecar does not bind its garment`);
  const garmentId = collected.expectedGarmentId;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      garmentId ?? "",
    )
  )
    throw new Error(`${caseKey} installed UI did not expose garment identity`);
  return {
    garmentId,
    garmentSha256: requireDigest(
      value.attempt.garmentSha256,
      `${caseKey} garment digest`,
    ),
    inputSha256: requireDigest(
      value.attempt.inputSha256,
      `${caseKey} input digest`,
    ),
    resultSha256: requireDigest(
      value.attempt.resultSha256,
      `${caseKey} result digest`,
    ),
  };
}

function attemptReport(
  collected,
  caseKey,
  archived,
  { skipAiRss = false } = {},
) {
  const sidecar = JSON.parse(collected.regionalEvidence.bytes.toString("utf8"));
  const facts = sidecarAttemptFacts(sidecar, collected, caseKey);
  const durationMs = collected.durationMs;
  const peakRssBytes = collected.peakRssBytes;
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    (!skipAiRss && (!Number.isSafeInteger(peakRssBytes) || peakRssBytes <= 0))
  )
    throw new Error(`${caseKey} runtime resource facts are missing`);
  return {
    attemptId: collected.attemptId,
    caseKey,
    garment: {
      contentType: "image/png",
      garmentId: facts.garmentId,
      sha256: facts.garmentSha256,
    },
    input: { contentType: "image/png", sha256: facts.inputSha256 },
    journey: collected.journey,
    mode: "ai",
    outputFacts: {
      decodable: true,
      differsFromGarment: facts.resultSha256 !== facts.garmentSha256,
      differsFromInput: facts.resultSha256 !== facts.inputSha256,
      nonPlaceholder: collected.resultEvidence.byteLength >= 64,
    },
    regionalEvidence: {
      path: archived.path,
      schemaVersion: "vem-ai-regional-evidence-reference/v1",
      sha256: archived.sha256,
      verdict: sidecar.verdict,
    },
    ...(collected.retry ? { retry: collected.retry } : {}),
    result: {
      contentType: "image/png",
      decodedHeight: collected.resultEvidence.height,
      decodedWidth: collected.resultEvidence.width,
      durationMs,
      ...(skipAiRss ? {} : { peakRssBytes }),
      sha256: facts.resultSha256,
    },
    screenshots: collected.screenshots,
    stateTrace: ["acquiring", "generating", "completed"],
    template: CASES[caseKey],
  };
}

function attemptSupportRecord(collected, caseKey, report, resource) {
  return supportEvidence("resource-observation", {
    attemptId: report.attemptId,
    caseKey,
    garmentAssociation: {
      garmentId: report.garment.garmentId,
      garmentSha256: report.garment.sha256,
      selectedVariantId: collected.surface.variantId,
    },
    resource: {
      ownerExecutablePath: resource.ownerIdentity.executablePath,
      ownerProcessId: resource.ownerIdentity.processId,
      ownerStartTimeTicks: resource.ownerIdentity.startTimeTicks,
      peakRssBytes: resource.peakRssBytes,
      sampleCount: resource.sampleCount,
      workerExecutablePath: resource.workerIdentity.executablePath,
      workerParentProcessId: resource.workerIdentity.parentProcessId,
      workerProcessId: resource.workerIdentity.processId,
      workerStartTimeTicks: resource.workerIdentity.startTimeTicks,
    },
  });
}

function archiveSidecar(collected, caseKey, artifactRoot) {
  const relative = `regional/${caseKey}/${collected.attemptId}.regional-evidence.json`;
  const destination = resolve(artifactRoot, relative);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  let sourceFd = null;
  let createdDestination = false;
  try {
    sourceFd = openSync(
      collected.regionalEvidence.path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const sourceBefore = fstatSync(sourceFd, { bigint: true });
    const expectedIdentity = collected.regionalEvidence.physicalIdentity;
    if (
      String(sourceBefore.dev) !== expectedIdentity.device ||
      String(sourceBefore.ino) !== expectedIdentity.inode ||
      String(sourceBefore.size) !== expectedIdentity.size
    )
      throw new Error(`${caseKey} regional evidence source identity changed`);
    const heldBytes = Buffer.alloc(Number(sourceBefore.size));
    let offset = 0;
    while (offset < heldBytes.length) {
      const count = readSync(
        sourceFd,
        heldBytes,
        offset,
        heldBytes.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    if (
      offset !== heldBytes.length ||
      !heldBytes.equals(collected.regionalEvidence.bytes)
    )
      throw new Error(`${caseKey} regional evidence source bytes changed`);
    const fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(fd, collected.regionalEvidence.bytes);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, destination);
    createdDestination = true;
    rmSync(temporary, { force: true });
    const sourceAfter = fstatSync(sourceFd, { bigint: true });
    const pathAfter = lstatSync(collected.regionalEvidence.path, {
      bigint: true,
    });
    if (
      sourceBefore.dev !== sourceAfter.dev ||
      sourceBefore.ino !== sourceAfter.ino ||
      sourceBefore.size !== sourceAfter.size ||
      sourceBefore.mtimeNs !== sourceAfter.mtimeNs ||
      sourceBefore.ctimeNs !== sourceAfter.ctimeNs ||
      sourceAfter.dev !== pathAfter.dev ||
      sourceAfter.ino !== pathAfter.ino
    )
      throw new Error(`${caseKey} regional evidence changed during archive`);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (createdDestination) rmSync(destination, { force: true });
    throw error;
  } finally {
    if (sourceFd !== null) closeSync(sourceFd);
  }
  const archived = readFileSync(destination);
  if (!archived.equals(collected.regionalEvidence.bytes)) {
    rmSync(destination, { force: true });
    throw new Error(`${caseKey} regional evidence changed while archiving`);
  }
  return { path: relative, sha256: sha256(archived) };
}

function clearCollectedRegionalEvidenceForRetry(collected, root) {
  const attemptId = collected?.attemptId;
  const evidence = collected?.regionalEvidence;
  if (
    !UUID_PATTERN.test(attemptId ?? "") ||
    typeof root !== "string" ||
    !isAbsolute(root) ||
    typeof evidence?.path !== "string" ||
    !Buffer.isBuffer(evidence.bytes)
  )
    throw new Error("AI retry regional evidence is invalid");
  const expectedPath = resolve(root, `${attemptId}.regional-evidence.json`);
  if (resolve(evidence.path) !== expectedPath)
    throw new Error(
      "AI retry regional evidence path is not bound to its attempt",
    );
  const stat = lstatSync(expectedPath, { bigint: true });
  const identity = evidence.physicalIdentity;
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    String(stat.dev) !== identity?.device ||
    String(stat.ino) !== identity?.inode ||
    String(stat.size) !== identity?.size
  )
    throw new Error("AI retry regional evidence identity changed");
  rmSync(expectedPath);
}

export function clearCollectedRegionalEvidenceForRetryForTest(collected, root) {
  if (process.env.NODE_ENV !== "test")
    throw new Error(
      "AI retry regional evidence test boundary requires NODE_ENV=test",
    );
  clearCollectedRegionalEvidenceForRetry(collected, root);
}

function installedAiScreenshotCapture(artifactRoot, caseKey) {
  if (typeof artifactRoot !== "string" || !isAbsolute(artifactRoot))
    throw new Error("AI screenshot artifact root must be absolute");
  if (!Object.hasOwn(CASES, caseKey))
    throw new Error("AI screenshot case is invalid");
  return async ({ client, stage, attemptId }) => {
    if (!new Set(["acquisition", "result"]).has(stage))
      throw new Error("AI screenshot stage is invalid");
    if (!UUID_PATTERN.test(attemptId ?? ""))
      throw new Error("AI screenshot attempt identity is invalid");
    const relative = `screenshots/${caseKey}/${attemptId}-${stage}.png`;
    const path = resolve(artifactRoot, relative);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return captureScreenshot(client, {
      format: "png",
      label: `${caseKey}-${stage}`,
      screenshotSink: ({ bytes }) => {
        writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
        return { ref: relative };
      },
      validatePng: true,
    }).then((screenshot) => ({
      byteLength: screenshot.byteLength,
      path: relative,
      sha256: screenshot.sha256,
      stage,
    }));
  };
}

async function returnInstalledAiAttemptToCatalog(client, resultAttemptId) {
  if (!UUID_PATTERN.test(resultAttemptId ?? ""))
    throw new Error("AI try-on return attempt identity is invalid");
  const resultRoute = (
    await client.send("Runtime.evaluate", {
      expression: "location.hash",
      returnByValue: true,
    })
  )?.result?.value;
  await activateVisibleSelector(client, '[data-test="try-on-return"]', {
    kind: "touch",
    timeoutMs: 30_000,
  });
  await waitForRoute(client, /^#\/products\//, {
    timeoutMs: 30_000,
    pollMs: 250,
  });
  const productRoute = (
    await client.send("Runtime.evaluate", {
      expression: "location.hash",
      returnByValue: true,
    })
  )?.result?.value;
  await activateVisibleSelector(
    client,
    '[data-test="product-detail-return-catalog"]',
    { kind: "touch", timeoutMs: 30_000 },
  );
  await waitForRoute(client, "#/catalog", { timeoutMs: 30_000, pollMs: 250 });
  const observation = await client.send("Runtime.evaluate", {
    expression: "location.hash",
    returnByValue: true,
  });
  const catalogRoute = observation?.result?.value;
  if (catalogRoute !== "#/catalog")
    throw new Error("AI try-on return did not reach the public catalog route");
  if (
    typeof resultRoute !== "string" ||
    !resultRoute.startsWith("#/try-on?") ||
    typeof productRoute !== "string" ||
    !productRoute.startsWith("#/products/")
  )
    throw new Error("AI try-on return route observation is invalid");
  return {
    resultAttemptId,
    resultRoute,
    returnedCatalogRoute: catalogRoute,
    returnProductRoute: productRoute,
  };
}

export async function runInstalledAiAttemptPhase(options) {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const validatedInputIdentityPath = join(
    options.artifactRoot,
    "validated-input-identity.json",
  );
  if (existsSync(validatedInputIdentityPath)) {
    writeFileSync(
      validatedInputIdentityPath,
      canonicalBytes({
        facts: {
          validatedInputIdentity: JSON.parse(
            readFileSync(validatedInputIdentityPath, "utf8"),
          ),
        },
        kind: "installed-runtime",
        schemaVersion: AI_SUPPORT_EVIDENCE_SCHEMA,
      }),
    );
  }
  writeFileSync(
    join(options.artifactRoot, "attempt-debug.json"),
    canonicalBytes({
      facts: {
        functional: guestInput.aiVirtualTryOn?.functional ?? null,
        skipAiRssFlag: guestInput.aiVirtualTryOn?.skipAiRss ?? null,
      },
      kind: "installed-runtime",
      schemaVersion: AI_SUPPORT_EVIDENCE_SCHEMA,
    }),
  );
  if (guestInput.aiVirtualTryOn?.skipAiRss === true) {
    process.env.VEM_VM_ACCEPTANCE_SKIP_AI_RSS = "1";
  }
  if (guestInput.aiVirtualTryOn?.keepAiActive === true) {
    process.env.VEM_VM_ACCEPTANCE_KEEP_AI_ACTIVE = "1";
  }
  const handoff = readJson(options.handoffPath, "runtime handoff");
  const target = await discoverMachineUiTarget({
    endpoint: handoff.cdp.endpoint,
    expectedTargetId: handoff.cdp.targetId,
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      handoff.cdp.endpoint,
    ),
  );
  try {
    await client.connect();
    await enablePageRuntime(client);
    const acceptance = guestInput.visionAcceptance?.aiTryOnCases?.find(
      (entry) => entry?.caseKey === options.caseKey,
    );
    if (!acceptance || acceptance.template !== CASES[options.caseKey])
      throw new Error(
        `${options.caseKey} installed AI garment case is unavailable`,
      );
    await restoreCatalogHomeFromClient({ client });
    const catalogRoute = (
      await client.send("Runtime.evaluate", {
        expression: "location.hash",
        returnByValue: true,
      })
    )?.result?.value;
    if (catalogRoute !== "#/catalog")
      throw new Error(
        "AI try-on did not start from the observed catalog route",
      );
    const categorySelector =
      '[data-test="catalog-category"][data-category-key="tshirts"]';
    const productSelector = `[data-test="catalog-product"][data-catalog-key="${acceptance.selectedCatalogKey}"]`;
    await activateVisibleSelector(client, categorySelector, {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await activateVisibleSelector(client, productSelector, {
      kind: "touch",
      timeoutMs: 30_000,
    });
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    const productRoute = (
      await client.send("Runtime.evaluate", {
        expression: "location.hash",
        returnByValue: true,
      })
    )?.result?.value;
    const expectedProductRoute = expectedInstalledProductRoute(
      acceptance.selectedCatalogKey,
    );
    if (productRoute !== expectedProductRoute)
      throw new Error(
        "AI try-on product route does not bind the selected catalog item",
      );
    await activateVisibleSelector(
      client,
      `[data-test="product-size-option"][data-size="${acceptance.size}"]`,
      { kind: "touch", timeoutMs: 30_000 },
    );
    const startSelector = '[data-test="try-on-ai"]';
    const expectedTryOnRoute = expectedInstalledTryOnRoute(
      acceptance.selectedCatalogKey,
      acceptance.selectedVariantId,
    );
    const readRuntimeTraceSnapshot = async () =>
      (
        await client.send("Runtime.evaluate", {
          expression: "window.__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__ || null",
          returnByValue: true,
        })
      )?.result?.value;
    const startedAt = performance.now();
    let completed = false;
    let archived = null;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const ownerPromise = collectInstalledAiOwnerAttempts({
      initialOptions: {
        client,
        captureAttemptScreenshot: installedAiScreenshotCapture(
          options.artifactRoot,
          options.caseKey,
        ),
        expectedTryOnRoute,
        regionalEvidenceRoot: options.regionalEvidenceRoot,
      },
      retryOptions:
        options.caseKey === "short"
          ? {
              client,
              expectedTryOnRoute,
              regionalEvidenceRoot: options.regionalEvidenceRoot,
            }
          : null,
      readRuntimeTraceSnapshot,
      onInitialSettled: () => {
        completed = true;
      },
      afterInitial: (collected) => {
        if (options.caseKey !== "short") return;
        archived = archiveSidecar(
          collected,
          options.caseKey,
          options.artifactRoot,
        );
        clearCollectedRegionalEvidenceForRetry(
          collected,
          options.regionalEvidenceRoot,
        );
      },
      onInitialStarted: () => markStarted(),
    });
    const skipAiRss =
      isVmAcceptanceAiRssSkipEnabled() ||
      guestInput.aiVirtualTryOn?.skipAiRss === true;
    const sampler = skipAiRss
      ? Promise.resolve(null)
      : (async () => {
          await started;
          return sampleInstalledAiWorkerPeakRss(() => completed);
        })();
    const [ownerAttempts, resource] = await Promise.all([
      ownerPromise,
      sampler,
    ]);
    const collected = ownerAttempts.initial;
    const retried = ownerAttempts.retry;
    if (retried) {
      if (retried.attemptId === collected.attemptId)
        throw new Error(
          "AI try-on retry reused the completed attempt identity",
        );
      collected.retry = {
        completedAttemptId: collected.attemptId,
        lifecycle: projectInstalledAiRetryLifecycle(
          retried.lifecycle,
          retried.attemptId,
        ),
        result: {
          decodedHeight: retried.resultEvidence.height,
          decodedWidth: retried.resultEvidence.width,
          sha256: retried.resultEvidence.sha256,
        },
        retriedAttemptId: retried.attemptId,
      };
    }
    if (collected.surface.variantId !== acceptance.selectedVariantId)
      throw new Error(
        `${options.caseKey} installed UI selected variant mismatched its seeded garment association`,
      );
    collected.durationMs = Math.max(
      1,
      Math.ceil(performance.now() - startedAt),
    );
    if (resource) collected.peakRssBytes = resource.peakRssBytes;
    collected.expectedGarmentId = acceptance.garmentId;
    collected.expectedGarmentSha256 = requireDigest(
      acceptance.garmentSha256,
      `${options.caseKey} seeded garment digest`,
    );
    const resultAttemptId =
      collected.retry?.retriedAttemptId ?? collected.attemptId;
    collected.journey = {
      catalogRoute,
      categorySelector,
      productRoute,
      productSelector,
      ...(await returnInstalledAiAttemptToCatalog(client, resultAttemptId)),
      selectedCatalogKey: acceptance.selectedCatalogKey,
      selectedVariantId: acceptance.selectedVariantId,
      startSelector,
    };
    archived ??= archiveSidecar(
      collected,
      options.caseKey,
      options.artifactRoot,
    );
    const report = attemptReport(collected, options.caseKey, archived, {
      skipAiRss,
    });
    const bytes = canonicalBytes(
      supportEvidence("installed-runtime", {
        attempt: report,
        ...(resource
          ? {
              observation: attemptSupportRecord(
                collected,
                options.caseKey,
                report,
                resource,
              ).facts,
            }
          : {}),
      }),
    );
    writeFileSync(options.phaseOutputPath, bytes, { flag: "wx", mode: 0o600 });
    return report;
  } finally {
    await client.close().catch(() => {});
  }
}

export function expectedInstalledProductRoute(catalogKey) {
  return `#/products/${catalogKey}`;
}

export function expectedInstalledTryOnRoute(catalogKey, variantId) {
  return `#/try-on?catalogKey=${catalogKey}&variantId=${variantId}&mode=ai`;
}

export function expectedInstalledReturnProductRoute(catalogKey, variantId) {
  return `${expectedInstalledProductRoute(catalogKey)}?variantId=${variantId}`;
}

export async function runInstalledOrdinarySalePhase(options) {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const handoff = readJson(options.handoffPath, "runtime handoff");
  const target = await discoverMachineUiTarget({
    endpoint: handoff.cdp.endpoint,
    expectedTargetId: handoff.cdp.targetId,
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      handoff.cdp.endpoint,
    ),
  );
  try {
    await client.connect();
    await enablePageRuntime(client);
    await restoreCatalogHomeFromClient({ client });
    await replaceSerialSessionAndUpdateHandoff({
      guestInput,
      handoff,
      handoffPath: options.handoffPath,
      sessionId: handoff.commissioningSerialSession?.sessionId,
      control: controlPlaneRequest,
    });
    const report = await runInstalledOwnerOrdinarySaleCompletion({
      client,
      guestInput,
      handoff,
      serialSession: handoff.commissioningSerialSession,
      categorySelector: catalogCategorySelectorForFixture(
        guestInput.fixtureAllocation,
        "aiVirtualTryOn",
      ),
      productSelector: catalogProductSelectorForFixture(
        guestInput.fixtureAllocation,
        "aiVirtualTryOn",
      ),
    });
    writeFileSync(
      options.phaseOutputPath,
      canonicalBytes(supportEvidence("installed-runtime", { sale: report })),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return report;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runInstalledAiDegradationPhase(options) {
  const guestInput = readJson(options.guestInputPath, "guest input");
  const handoff = readJson(options.handoffPath, "runtime handoff");
  const healthzUrl = handoff.daemon?.ready?.healthzUrl;
  const daemonToken = handoff.daemon?.ready?.ipcToken;
  if (
    typeof healthzUrl !== "string" ||
    !healthzUrl.endsWith("/healthz") ||
    typeof daemonToken !== "string" ||
    daemonToken.length < 1
  )
    throw new Error("installed degradation daemon handoff is invalid");
  const target = await discoverMachineUiTarget({
    endpoint: handoff.cdp.endpoint,
    expectedTargetId: handoff.cdp.targetId,
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      handoff.cdp.endpoint,
    ),
  );
  try {
    await client.connect();
    await enablePageRuntime(client);
    const acceptance = guestInput.visionAcceptance?.aiTryOnCases?.[0];
    if (!acceptance?.selectedCatalogKey || !acceptance?.size)
      throw new Error("installed degradation product fixture is unavailable");
    await restoreCatalogHomeFromClient({ client });
    await activateVisibleSelector(
      client,
      '[data-test="catalog-category"][data-category-key="tshirts"]',
      { kind: "touch", timeoutMs: 30_000 },
    );
    await activateVisibleSelector(
      client,
      `[data-test="catalog-product"][data-catalog-key="${acceptance.selectedCatalogKey}"]`,
      { kind: "touch", timeoutMs: 30_000 },
    );
    await waitForRoute(client, /^#\/products\//, {
      timeoutMs: 30_000,
      pollMs: 250,
    });
    await activateVisibleSelector(
      client,
      `[data-test="product-size-option"][data-size="${acceptance.size}"]`,
      { kind: "touch", timeoutMs: 30_000 },
    );
    const facts = await collectInstalledAiDegradationEvidence({
      client,
      daemonOrigin: healthzUrl.slice(0, -"/healthz".length),
      daemonToken,
      expectedDiagnostic: options.expectedDiagnostic,
      machineCode: guestInput.machineCode,
    });
    writeExclusiveCanonical(
      options.phaseOutputPath,
      supportEvidence("installed-runtime", {
        degradation: {
          diagnostic: options.expectedDiagnostic,
          fault: options.fault,
          facts,
        },
      }),
    );
    return facts;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runInstalledAiRestoreCatalogPhase(options) {
  const handoff = readJson(options.handoffPath, "runtime handoff");
  const target = await discoverMachineUiTarget({
    endpoint: handoff.cdp.endpoint,
    expectedTargetId: handoff.cdp.targetId,
  });
  const client = new CdpClient(
    rewriteWebSocketDebuggerUrl(
      target.webSocketDebuggerUrl,
      handoff.cdp.endpoint,
    ),
  );
  try {
    await client.connect();
    await enablePageRuntime(client);
    await restoreCatalogHomeFromClient({ client });
  } finally {
    await client.close().catch(() => {});
  }
}

export async function assembleInstalledAiTryOnAcceptance(
  input,
  dependencies = {},
) {
  const ordinarySale =
    dependencies.ordinarySale ?? runInstalledOwnerOrdinarySaleCompletion;
  const sale = await ordinarySale(input.saleInput);
  if (sale?.ok !== true)
    throw new Error("ordinary installed-owner sale did not complete");
  const attempts = input.attempts;
  const skipAiRss = input.skipAiRss === true;
  if (skipAiRss && !isVmAcceptanceAiRssSkipEnabled())
    throw new Error("VM AI RSS bypass is not enabled");
  if (!Array.isArray(attempts) || attempts.length !== 2)
    throw new Error("two installed AI attempt facts are required");
  const runtimeTrace = attempts.flatMap((attempt) =>
    attempt.stateTrace.map((state) => ({
      attemptId: attempt.attemptId,
      mode: "ai",
      state,
    })),
  );
  if (!validateAiAttemptSet(attempts, runtimeTrace, { skipAiRss }))
    throw new Error("installed AI attempt set failed the shared v2 contract");
  const regionalManifest = provisionalSidecarManifest(
    attempts,
    input.artifactRoot,
  );
  const evidenceManifest = input.evidenceManifest ?? regionalManifest;
  validateAttemptScreenshotArtifacts(
    attempts,
    input.artifactRoot,
    evidenceManifest,
  );
  validateArchivedRegionalSidecars(
    attempts,
    input.artifactRoot,
    regionalManifest,
  );
  const regionalPassed = attempts.every(
    (attempt) => attempt.regionalEvidence.verdict === "passed",
  );
  const workerFailurePending = input.workerFailure === undefined;
  const successful = regionalPassed && !workerFailurePending;
  if (successful) {
    const report = {
      attempts,
      degradations: { workerFailure: input.workerFailure },
      error: null,
      execution: {
        functional: input.functional === true,
        ...(skipAiRss ? { aiRssObservation: "skipped_by_vm_acceptance" } : {}),
        identities: Object.fromEntries(
          Object.entries(input.identities).map(([key, value]) => [
            key,
            `sha256:${requireDigest(value, `${key} identity`)}`,
          ]),
        ),
        noDirectWorker: true,
        protocol: "vem.vision.v2",
        recordedSources: ["front", "top"],
        source: "installed_machine_ui_cdp",
      },
      ok: true,
      postAi: {
        browseAvailable: true,
        ordinarySaleCompleted: true,
        saleAvailable: true,
      },
      reasons: [],
      runtimeTrace,
      schemaVersion: "vem-ai-virtual-try-on-acceptance/v2",
    };
    return { acceptance: { ok: true, reasons: [] }, report };
  }
  const report = {
    attempts,
    degradations: workerFailurePending
      ? {}
      : { workerFailure: input.workerFailure },
    error: workerFailurePending
      ? "installed worker failure probe not executed"
      : "regional_check_failed",
    execution: {
      functional: input.functional === true,
      ...(skipAiRss ? { aiRssObservation: "skipped_by_vm_acceptance" } : {}),
      identities: Object.fromEntries(
        Object.entries(input.identities).map(([key, value]) => [
          key,
          `sha256:${requireDigest(value, `${key} identity`)}`,
        ]),
      ),
      noDirectWorker: true,
      protocol: "vem.vision.v2",
      recordedSources: ["front", "top"],
      source: "installed_machine_ui_cdp",
    },
    ok: false,
    postAi: {
      browseAvailable: true,
      ordinarySaleCompleted: true,
      saleAvailable: true,
    },
    runtimeTrace,
    schemaVersion: "vem-ai-virtual-try-on-acceptance/v2",
  };
  const acceptance = {
    ok: false,
    reasons: [
      ...(workerFailurePending
        ? ["installed worker failure probe not executed"]
        : []),
      ...(!regionalPassed ? ["regional_check_failed"] : []),
    ],
  };
  return { acceptance, report };
}

export function validateInstalledAiAttemptSupport(value, expectedCase) {
  const skipAiRss = isVmAcceptanceAiRssSkipEnabled();
  const attempt = value?.facts?.attempt;
  if (
    JSON.stringify(Object.keys(value ?? {}).sort()) !==
      JSON.stringify(["facts", "kind", "schemaVersion"]) ||
    value.schemaVersion !== AI_SUPPORT_EVIDENCE_SCHEMA ||
    value.kind !== "installed-runtime" ||
    !Object.hasOwn(CASES, expectedCase) ||
    attempt?.caseKey !== expectedCase
  )
    throw new Error("installed AI attempt support evidence is invalid");
  if (skipAiRss) {
    if (
      JSON.stringify(Object.keys(value.facts ?? {}).sort()) !==
      JSON.stringify(["attempt"])
    )
      throw new Error("installed AI attempt support evidence is invalid");
    return attempt;
  }
  const observation = value.facts.observation;
  const resource = observation?.resource;
  const association = observation?.garmentAssociation;
  if (
    JSON.stringify(Object.keys(value.facts ?? {}).sort()) !==
      JSON.stringify(["attempt", "observation"]) ||
    JSON.stringify(Object.keys(observation ?? {}).sort()) !==
      JSON.stringify([
        "attemptId",
        "caseKey",
        "garmentAssociation",
        "resource",
      ]) ||
    JSON.stringify(Object.keys(association ?? {}).sort()) !==
      JSON.stringify(["garmentId", "garmentSha256", "selectedVariantId"]) ||
    JSON.stringify(Object.keys(resource ?? {}).sort()) !==
      JSON.stringify([
        "ownerExecutablePath",
        "ownerProcessId",
        "ownerStartTimeTicks",
        "peakRssBytes",
        "sampleCount",
        "workerExecutablePath",
        "workerParentProcessId",
        "workerProcessId",
        "workerStartTimeTicks",
      ]) ||
    observation.attemptId !== attempt.attemptId ||
    observation.caseKey !== expectedCase ||
    association.garmentId !== attempt.garment?.garmentId ||
    association.garmentSha256 !== attempt.garment?.sha256 ||
    !UUID_PATTERN.test(association.selectedVariantId ?? "") ||
    resource.ownerExecutablePath !== OWNER_EXECUTABLE ||
    resource.workerExecutablePath !== WORKER_EXECUTABLE ||
    resource.peakRssBytes !== attempt.result?.peakRssBytes ||
    !Number.isSafeInteger(resource.sampleCount) ||
    resource.sampleCount <= 0 ||
    !Number.isSafeInteger(resource.ownerProcessId) ||
    resource.ownerProcessId <= 0 ||
    !Number.isSafeInteger(resource.workerProcessId) ||
    resource.workerProcessId <= 0 ||
    resource.workerProcessId === resource.ownerProcessId ||
    !Number.isSafeInteger(resource.workerParentProcessId) ||
    resource.workerParentProcessId !== resource.ownerProcessId ||
    !/^[1-9][0-9]*$/.test(resource.ownerStartTimeTicks ?? "") ||
    !/^[1-9][0-9]*$/.test(resource.workerStartTimeTicks ?? "")
  )
    throw new Error("installed AI attempt support evidence is invalid");
  return attempt;
}

export async function assembleInstalledAiTryOnAcceptanceFiles(options) {
  const supportRecords = [
    readCanonicalJson(options.shortAttemptPath, "short attempt facts"),
    readCanonicalJson(options.longAttemptPath, "long attempt facts"),
  ];
  const attempts = supportRecords.map((value, index) =>
    validateInstalledAiAttemptSupport(value, index === 0 ? "short" : "long"),
  );
  const saleSupport = readCanonicalJson(
    options.salePath,
    "ordinary sale facts",
  );
  const degradationSupport = readCanonicalJson(
    options.missingDegradationPath,
    "missing model degradation facts",
  );
  const corruptDegradationSupport = readCanonicalJson(
    options.corruptDegradationPath,
    "corrupt model degradation facts",
  );
  const workerFailureDegradationSupport = readCanonicalJson(
    options.workerFailureDegradationPath,
    "worker failure degradation facts",
  );
  if (
    saleSupport.schemaVersion !== AI_SUPPORT_EVIDENCE_SCHEMA ||
    saleSupport.kind !== "installed-runtime" ||
    saleSupport.facts?.sale?.ok !== true
  )
    throw new Error("ordinary sale support evidence is invalid");
  const sale = saleSupport.facts.sale;
  const functionalIdentity = options.functionalIdentity;
  if (functionalIdentity) {
    for (const key of [
      "modelPackSha256",
      "runtimeDescriptorSha256",
      "runtimeSha256",
    ]) {
      requireDigest(functionalIdentity[key], `${key}`);
    }
    if (!/^[a-f0-9]{40}$/.test(functionalIdentity.sourceCommit ?? ""))
      throw new Error("functional AI source commit is invalid");
  }
  if (!functionalIdentity) {
    throw new Error("functional AI identity is required");
  }
  const proof = {
    modelPack: { archive: { sha256: functionalIdentity.modelPackSha256 } },
    resources: {
      runtimeDescriptorSha256: functionalIdentity.runtimeDescriptorSha256,
    },
    candidate: { sourceCommit: functionalIdentity.sourceCommit },
  };
  const missingDegradation =
    validateMissingDegradationSupport(degradationSupport);
  const corruptDegradation = validateCorruptDegradationSupport(
    corruptDegradationSupport,
  );
  const workerFailureDegradation = validateWorkerFailureDegradationSupport(
    workerFailureDegradationSupport,
  );
  const recoverySupport = readCanonicalJson(
    options.recoveryPath,
    "verified AI owner recovery facts",
  );
  validateVerifiedOwnerRecoverySupport(recoverySupport, proof);
  const contract = readCanonicalJson(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../packages/shared/generated/vision-v2/manifest.json",
    ),
    "generated Vision V2 manifest",
  );
  const result = await assembleInstalledAiTryOnAcceptance(
    {
      attempts,
      artifactRoot: options.artifactRoot,
      identities: {
        aiRuntime: functionalIdentity
          ? functionalIdentity.runtimeDescriptorSha256
          : proof.resources.runtimeDescriptorSha256,
        contract: contract.bundleDigest,
        modelPack: functionalIdentity
          ? functionalIdentity.modelPackSha256
          : proof.modelPack.archive.sha256,
        runtime: functionalIdentity
          ? functionalIdentity.runtimeSha256
          : proof.candidate.subjectSha256,
      },
      saleInput: null,
      skipAiRss:
        isVmAcceptanceAiRssSkipEnabled() ||
        options.functionalIdentity?.skipAiRss === true,
      functional: Boolean(functionalIdentity),
      workerFailure: workerFailureDegradation,
    },
    { ordinarySale: async () => sale },
  );
  result.report.degradations.missingPack = missingDegradation;
  result.report.degradations.corruptPack = corruptDegradation;
  if (!functionalIdentity) {
    const candidateManifest = readCanonicalJson(
      join(options.candidateInputDirectory, "candidate-manifest.json"),
      "candidate manifest",
      { trailingNewline: false },
    );
    const candidateManifestRaw = readFileSync(
      join(options.candidateInputDirectory, "candidate-manifest.json"),
    );
    if (
      candidateManifest.sourceCommit !== proof.candidate.sourceCommit ||
      proof.candidate.embeddedManifestSha256 !== sha256(candidateManifestRaw) ||
      sale.ok !== true
    )
      throw new Error("installed AI assembly input identity mismatched");
  } else if (sale.ok !== true) {
    throw new Error("installed AI assembly input identity mismatched");
  }
  writeExclusiveCanonical(options.outPath, result.report);
  return result;
}

export async function assembleInstalledAiTryOnAcceptanceForTest(
  input,
  dependencies,
) {
  if (process.env.NODE_ENV !== "test")
    throw new Error(
      "AI installed assembly test boundary requires NODE_ENV=test",
    );
  const regionalSampledPixels = 1;
  const attempts = input.attempts.map((collected, index) => {
    const caseKey = index === 0 ? "short" : "long";
    const sidecar = {
      attempt: {
        acquisitionSource: "direct_recorded_frame",
        decodedHeight: collected.resultEvidence.height,
        decodedWidth: collected.resultEvidence.width,
        garmentSha256: String(Number(index === 0 ? "3" : "7")).repeat(64),
        inputSha256: "a".repeat(64),
        recordedFixtureSha256: "8".repeat(64),
        resultSha256: collected.resultEvidence.sha256,
        sourceCamera: "front",
      },
      evaluator: {
        algorithm: "rgb-absolute-delta-rle/v1",
        atr: "schp-atr",
        lip: "schp-lip",
        pose: "mediapipe-pose-or-frame-proportional",
        sourceDescriptorSha256: "0".repeat(64),
      },
      kind: "regional-evidence",
      masks: {
        height: collected.resultEvidence.height,
        protectedRegion: {
          encoding: "rle-row-major/v1",
          runs: [[regionalSampledPixels, 1]],
        },
        upperBody: {
          encoding: "rle-row-major/v1",
          runs: [[0, regionalSampledPixels]],
        },
        width: collected.resultEvidence.width,
      },
      measurements: {
        protectedRegion: {
          changedFractionBps: 0,
          changedPixels: 0,
          meanDelta: 0,
          sampledPixels: 1,
          verdict: "preserved",
        },
        upperBody: {
          changedFractionBps: 10000,
          changedPixels: regionalSampledPixels,
          meanDelta: 1,
          sampledPixels: regionalSampledPixels,
          verdict: "changed",
        },
      },
      policy: {
        schemaVersion: "vem-ai-regional-evidence-policy/v1",
        sha256: "0".repeat(64),
      },
      schemaVersion: "vem-ai-regional-evidence/v1",
      verdict: collected.regionalVerdict ?? "passed",
    };
    collected.regionalEvidence.bytes = canonicalBytes(sidecar);
    collected.screenshots ??= ["acquisition", "result"].map((stage) => {
      const relative = `screenshots/${caseKey}/${collected.attemptId}-${stage}.png`;
      const path = resolve(input.artifactRoot, relative);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const png = Buffer.alloc(24);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
      png.writeUInt32BE(13, 8);
      png.write("IHDR", 12, "ascii");
      png.writeUInt32BE(1080, 16);
      png.writeUInt32BE(1920, 20);
      writeFileSync(path, png, { flag: "wx", mode: 0o600 });
      return {
        byteLength: png.byteLength,
        path: relative,
        sha256: sha256(png),
        stage,
      };
    });
    collected.expectedGarmentSha256 = sidecar.attempt.garmentSha256;
    if (caseKey === "short")
      collected.retry ??= {
        completedAttemptId: collected.attemptId,
        lifecycle: ["acquiring", "generating", "completed"],
        result: {
          decodedHeight: collected.resultEvidence.height,
          decodedWidth: collected.resultEvidence.width,
          sha256: "e".repeat(64),
        },
        retriedAttemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2b009",
      };
    const selectedCatalogKey = `product:${caseKey}`;
    const selectedVariantId = collected.surface.garmentId;
    collected.journey ??= {
      catalogRoute: "#/catalog",
      categorySelector:
        '[data-test="catalog-category"][data-category-key="tshirts"]',
      productRoute: expectedInstalledProductRoute(selectedCatalogKey),
      productSelector: `[data-test="catalog-product"][data-catalog-key="${selectedCatalogKey}"]`,
      resultAttemptId: collected.retry?.retriedAttemptId ?? collected.attemptId,
      resultRoute: expectedInstalledTryOnRoute(
        selectedCatalogKey,
        selectedVariantId,
      ),
      returnedCatalogRoute: "#/catalog",
      returnProductRoute: expectedInstalledReturnProductRoute(
        selectedCatalogKey,
        selectedVariantId,
      ),
      selectedCatalogKey,
      selectedVariantId,
      startSelector: '[data-test="try-on-ai"]',
    };
    collected.expectedGarmentId = collected.surface.garmentId;
    const sourceRoot = join(input.artifactRoot, `.source-${caseKey}`);
    mkdirSync(sourceRoot, { mode: 0o700 });
    const sourcePath = join(
      sourceRoot,
      `${collected.attemptId}.regional-evidence.json`,
    );
    writeFileSync(sourcePath, collected.regionalEvidence.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    const sourceStat = lstatSync(sourcePath, { bigint: true });
    collected.regionalEvidence.path = sourcePath;
    collected.regionalEvidence.physicalIdentity = {
      device: String(sourceStat.dev),
      inode: String(sourceStat.ino),
      size: String(sourceStat.size),
    };
    collected.resultEvidence.byteLength = 1024;
    const archived = archiveSidecar(collected, caseKey, input.artifactRoot);
    return attemptReport(collected, caseKey, {
      path: `regional/${caseKey}/${collected.attemptId}.regional-evidence.json`,
      sha256: archived.sha256,
    });
  });
  input.mutateArchivedSidecars?.({
    attempts,
    artifactRoot: input.artifactRoot,
  });
  const evidenceManifest = {
    files: attempts.flatMap((attempt) => {
      const path = resolve(input.artifactRoot, attempt.regionalEvidence.path);
      const bytes = readFileSync(path);
      return [
        {
          track: "aiVirtualTryOn",
          kind: "supportingEvidence",
          path,
          byteLength: bytes.byteLength,
          sha256: sha256(bytes),
        },
        ...attempt.screenshots.map((screenshot) => ({
          track: "aiVirtualTryOn",
          kind: "screenshots",
          path: resolve(input.artifactRoot, screenshot.path),
          byteLength: screenshot.byteLength,
          sha256: screenshot.sha256,
        })),
      ];
    }),
  };
  return assembleInstalledAiTryOnAcceptance(
    { ...input, attempts, evidenceManifest },
    dependencies,
  );
}

function parseCli(argv) {
  const [command, ...tokens] = argv;
  if (
    !["attempt", "degradation", "restore-catalog", "sale", "assemble"].includes(
      command,
    )
  )
    throw new Error(
      "installed AI entry command must be attempt, degradation, restore-catalog, sale, or assemble",
    );
  const values = { command };
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      throw new Error("installed AI entry arguments are invalid");
    const key = flag.slice(2);
    if (Object.hasOwn(values, key)) throw new Error(`duplicate --${key}`);
    values[key] = value;
  }
  return values;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.command === "attempt") {
    if (!CASES[options.case])
      throw new Error("attempt case must be short or long");
    return runInstalledAiAttemptPhase({
      artifactRoot: options["artifact-root"],
      caseKey: options.case,
      expectedTryOnRoute: options["expected-route"],
      guestInputPath: options["guest-input"],
      handoffPath: options.handoff,
      phaseOutputPath: options.out,
      regionalEvidenceRoot: options["regional-root"],
    });
  }
  if (options.command === "sale") {
    return runInstalledOrdinarySalePhase({
      guestInputPath: options["guest-input"],
      handoffPath: options.handoff,
      phaseOutputPath: options.out,
    });
  }
  if (options.command === "degradation") {
    const diagnostics = {
      corrupt: "model_pack_invalid",
      missing: "model_pack_missing",
      worker: "worker_unavailable",
    };
    if (!Object.hasOwn(diagnostics, options.fault))
      throw new Error(
        "installed degradation fault must be missing, corrupt, or worker",
      );
    return runInstalledAiDegradationPhase({
      expectedDiagnostic: diagnostics[options.fault],
      fault: options.fault,
      guestInputPath: options["guest-input"],
      handoffPath: options.handoff,
      phaseOutputPath: options.out,
    });
  }
  if (options.command === "restore-catalog") {
    return runInstalledAiRestoreCatalogPhase({
      guestInputPath: options["guest-input"],
      handoffPath: options.handoff,
    });
  }
  return assembleInstalledAiTryOnAcceptanceFiles({
    artifactRoot: options["artifact-root"],
    corruptDegradationPath: options["corrupt-degradation"],
    functionalIdentity:
      options.functional === "true"
        ? {
            modelPackSha256: options["model-sha"],
            runtimeDescriptorSha256: options["runtime-descriptor-sha"],
            runtimeSha256: options["runtime-sha"],
            skipAiRss: options["skip-ai-rss"] === "true",
            sourceCommit: options["source-commit"],
          }
        : null,
    candidateInputDirectory: options["candidate-input-directory"],
    longAttemptPath: options["long-attempt"],
    missingDegradationPath: options["missing-degradation"],
    recoveryPath: options.recovery,
    outPath: options.out,
    salePath: options.sale,
    shortAttemptPath: options["short-attempt"],
    windowsProofInputDirectory: options["windows-proof-input-directory"],
    workerFailureDegradationPath: options["worker-failure-degradation"],
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}
