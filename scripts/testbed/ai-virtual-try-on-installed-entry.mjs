#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  AI_REGIONAL_EVIDENCE_POLICY,
  AI_REGIONAL_EVIDENCE_POLICY_SHA256,
  validateAiRegionalEvidenceSet,
} from "./ai-regional-evidence.mjs";
import { runInstalledOwnerOrdinarySaleCompletion } from "./fast-route-stress-sale.mjs";
import { AI_SUPPORT_EVIDENCE_SCHEMA } from "./full-workflow-evidence-manifest.mjs";
import { catalogProductSelectorForFixture } from "./full-workflow-fixtures.mjs";
import { restoreCatalogHomeFromClient } from "./full-workflow-orchestrator.mjs";
import { validateAiAttemptSet } from "./full-workflow-validator.mjs";
import {
  CdpClient,
  discoverMachineUiTarget,
  enablePageRuntime,
  rewriteWebSocketDebuggerUrl,
  activateVisibleSelector,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { collectInstalledAiTryOnAttempt } from "./vision-try-on-acceptance.mjs";

const CASES = Object.freeze({
  short: "tshirt_short_sleeve",
  long: "tshirt_long_sleeve",
});
const execFileAsync = promisify(execFile);
const TRUSTED_POWERSHELL = "D:\\runtime-cache\\v1\\powershell\\7.4.6\\pwsh.exe";

async function readInstalledVisionWorkerSample() {
  if (process.platform !== "win32")
    throw new Error("installed Vision RSS sampling requires Windows");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$mainPath=[IO.Path]::GetFullPath('C:\\VEM\\vision\\app\\vending-vision.exe')",
    "$workerPath=[IO.Path]::GetFullPath('C:\\VEM\\vision\\app\\vending-vision-ai-worker\\vending-vision-ai-worker.exe')",
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class VemMemory { [StructLayout(LayoutKind.Sequential)] public struct PMC { public uint cb; public uint PageFaultCount; public UIntPtr PeakWorkingSetSize; public UIntPtr WorkingSetSize; public UIntPtr QuotaPeakPagedPoolUsage; public UIntPtr QuotaPagedPoolUsage; public UIntPtr QuotaPeakNonPagedPoolUsage; public UIntPtr QuotaNonPagedPoolUsage; public UIntPtr PagefileUsage; public UIntPtr PeakPagefileUsage; } [DllImport(\"psapi.dll\",SetLastError=true)] public static extern bool GetProcessMemoryInfo(IntPtr hProcess,out PMC counters,uint size); }'",
    "$all=@(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$main=@($all|Where-Object{$_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $mainPath})",
    "$listener=@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 7892 -State Listen -ErrorAction Stop)",
    "if($main.Count -ne 1 -or $listener.Count -ne 1 -or [int]$listener[0].OwningProcess -ne [int]$main[0].ProcessId){throw 'canonical Vision owner identity is ambiguous'}",
    "$owned=[Collections.Generic.HashSet[int]]::new();[void]$owned.Add([int]$main[0].ProcessId)",
    "do{$changed=$false;foreach($p in $all){if($owned.Contains([int]$p.ParentProcessId)-and $owned.Add([int]$p.ProcessId)){$changed=$true}}}while($changed)",
    "$workers=@($all|Where-Object{$owned.Contains([int]$_.ProcessId)-and $_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $workerPath})",
    "$workerFacts=@($workers|ForEach-Object{$p=Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop;$c=[VemMemory+PMC]::new();$c.cb=[Runtime.InteropServices.Marshal]::SizeOf($c);if(-not [VemMemory]::GetProcessMemoryInfo($p.Handle,[ref]$c,$c.cb)){throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())};[ordered]@{processId=[int]$p.Id;startTime=$p.StartTime.ToUniversalTime().Ticks;peakWorkingSetBytes=[uint64]$c.PeakWorkingSetSize}})",
    "$owner=Get-Process -Id ([int]$main[0].ProcessId) -ErrorAction Stop",
    "[Console]::Out.Write((@{owner=@{processId=[int]$owner.Id;startTime=$owner.StartTime.ToUniversalTime().Ticks};workers=$workerFacts}|ConvertTo-Json -Compress -Depth 4))",
  ].join(";");
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
      sample.owner?.startTime !== ownerIdentity.startTime
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
        startTime: worker.startTime,
      };
      if (
        worker.processId !== workerIdentity.processId ||
        worker.startTime !== workerIdentity.startTime
      )
        throw new Error("installed AI worker identity changed during attempt");
      peakRssBytes = Math.max(peakRssBytes, worker.peakWorkingSetBytes);
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

function provisionalSidecarManifest(attempts, artifactRoot) {
  return {
    files: attempts.map((attempt) => {
      const path = resolve(artifactRoot, attempt.regionalEvidence.path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("AI regional evidence member is not regular");
      const bytes = readFileSync(path);
      return {
        byteLength: bytes.byteLength,
        kind: "supportingEvidence",
        path,
        sha256: sha256(bytes),
        track: "aiVirtualTryOn",
      };
    }),
  };
}

function supportEvidence(kind, facts) {
  return { facts, kind, schemaVersion: AI_SUPPORT_EVIDENCE_SCHEMA };
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

function attemptReport(collected, caseKey, archived) {
  const sidecar = JSON.parse(collected.regionalEvidence.bytes.toString("utf8"));
  const facts = sidecarAttemptFacts(sidecar, collected, caseKey);
  const durationMs = collected.durationMs;
  const peakRssBytes = collected.peakRssBytes;
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    !Number.isSafeInteger(peakRssBytes) ||
    peakRssBytes <= 0
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
    result: {
      contentType: "image/png",
      decodedHeight: collected.resultEvidence.height,
      decodedWidth: collected.resultEvidence.width,
      durationMs,
      peakRssBytes,
      sha256: facts.resultSha256,
    },
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
      ownerProcessId: resource.ownerIdentity.processId,
      ownerStartTime: resource.ownerIdentity.startTime,
      peakRssBytes: resource.peakRssBytes,
      sampleCount: resource.sampleCount,
      workerProcessId: resource.workerIdentity.processId,
      workerStartTime: resource.workerIdentity.startTime,
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

export async function runInstalledAiAttemptPhase(options) {
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
    const acceptance = guestInput.visionAcceptance?.aiTryOnCases?.find(
      (entry) => entry?.caseKey === options.caseKey,
    );
    if (!acceptance || acceptance.template !== CASES[options.caseKey])
      throw new Error(
        `${options.caseKey} installed AI garment case is unavailable`,
      );
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
    const expectedTryOnRoute = `#/try-on?catalogKey=${acceptance.selectedCatalogKey}&variantId=${acceptance.selectedVariantId}`;
    const startedAt = performance.now();
    let completed = false;
    const attemptPromise = collectInstalledAiTryOnAttempt({
      client,
      expectedTryOnRoute,
      regionalEvidenceRoot: options.regionalEvidenceRoot,
    }).finally(() => {
      completed = true;
    });
    const [collected, resource] = await Promise.all([
      attemptPromise,
      sampleInstalledAiWorkerPeakRss(() => completed),
    ]);
    if (collected.surface.variantId !== acceptance.selectedVariantId)
      throw new Error(
        `${options.caseKey} installed UI selected variant mismatched its seeded garment association`,
      );
    collected.durationMs = Math.max(
      1,
      Math.ceil(performance.now() - startedAt),
    );
    collected.peakRssBytes = resource.peakRssBytes;
    collected.expectedGarmentId = acceptance.garmentId;
    collected.expectedGarmentSha256 = requireDigest(
      acceptance.garmentSha256,
      `${options.caseKey} seeded garment digest`,
    );
    const archived = archiveSidecar(
      collected,
      options.caseKey,
      options.artifactRoot,
    );
    const report = attemptReport(collected, options.caseKey, archived);
    const bytes = canonicalBytes(
      supportEvidence("installed-runtime", {
        attempt: report,
        observation: attemptSupportRecord(
          collected,
          options.caseKey,
          report,
          resource,
        ).facts,
      }),
    );
    writeFileSync(options.phaseOutputPath, bytes, { flag: "wx", mode: 0o600 });
    return report;
  } finally {
    await client.close().catch(() => {});
  }
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
    const report = await runInstalledOwnerOrdinarySaleCompletion({
      client,
      guestInput,
      handoff,
      serialSession: handoff.commissioningSerialSession,
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
  if (!Array.isArray(attempts) || attempts.length !== 2)
    throw new Error("two installed AI attempt facts are required");
  const runtimeTrace = attempts.flatMap((attempt) =>
    attempt.stateTrace.map((state) => ({
      attemptId: attempt.attemptId,
      mode: "ai",
      state,
    })),
  );
  if (!validateAiAttemptSet(attempts, runtimeTrace))
    throw new Error("installed AI attempt set failed the shared v2 contract");
  const evidenceManifest =
    input.evidenceManifest ??
    provisionalSidecarManifest(attempts, input.artifactRoot);
  const regional = validateAiRegionalEvidenceSet(
    attempts,
    input.artifactRoot,
    evidenceManifest,
  );
  const calibrationPending =
    regional.reason ===
    "AI regional evidence policy awaits Issue10 two-garment calibration";
  if (!regional.ok && !calibrationPending) throw new Error(regional.reason);
  const report = {
    attempts,
    degradations: {},
    error:
      "installed degradation probes not executed; AI regional evidence policy awaits Issue10 two-garment calibration",
    execution: {
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
      "installed degradation probes not executed",
      "AI regional evidence policy awaits Issue10 two-garment calibration",
    ],
  };
  return { acceptance, report };
}

export async function assembleInstalledAiTryOnAcceptanceFiles(options) {
  const supportRecords = [
    readCanonicalJson(options.shortAttemptPath, "short attempt facts"),
    readCanonicalJson(options.longAttemptPath, "long attempt facts"),
  ];
  const attempts = supportRecords.map((value, index) => {
    if (
      value.schemaVersion !== AI_SUPPORT_EVIDENCE_SCHEMA ||
      value.kind !== "installed-runtime" ||
      value.facts?.attempt?.caseKey !== (index === 0 ? "short" : "long")
    )
      throw new Error("installed AI attempt support evidence is invalid");
    return value.facts.attempt;
  });
  const saleSupport = readCanonicalJson(
    options.salePath,
    "ordinary sale facts",
  );
  if (
    saleSupport.schemaVersion !== AI_SUPPORT_EVIDENCE_SCHEMA ||
    saleSupport.kind !== "installed-runtime" ||
    saleSupport.facts?.sale?.ok !== true
  )
    throw new Error("ordinary sale support evidence is invalid");
  const sale = saleSupport.facts.sale;
  const proof = readCanonicalJson(
    join(options.windowsProofInputDirectory, "precutover-ai-proof.json"),
    "trusted Windows proof",
  );
  const candidateManifest = readCanonicalJson(
    join(options.candidateInputDirectory, "candidate-manifest.json"),
    "candidate manifest",
    { trailingNewline: false },
  );
  const candidateManifestRaw = readFileSync(
    join(options.candidateInputDirectory, "candidate-manifest.json"),
  );
  const contract = readCanonicalJson(
    resolve(
      dirname(pathToFileURL(import.meta.url).pathname),
      "../../packages/shared/generated/vision-v2/manifest.json",
    ),
    "generated Vision V2 manifest",
  );
  const result = await assembleInstalledAiTryOnAcceptance(
    {
      attempts,
      artifactRoot: options.artifactRoot,
      identities: {
        aiRuntime: proof.resources.runtimeDescriptorSha256,
        contract: contract.bundleDigest,
        modelPack: proof.modelPack.archive.sha256,
        runtime: proof.candidate.subjectSha256,
      },
      saleInput: null,
    },
    { ordinarySale: async () => sale },
  );
  if (
    candidateManifest.sourceCommit !== proof.candidate.sourceCommit ||
    proof.candidate.embeddedManifestSha256 !== sha256(candidateManifestRaw) ||
    sale.ok !== true
  )
    throw new Error("installed AI assembly input identity mismatched");
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
        pose: "mediapipe-pose",
        sourceDescriptorSha256:
          AI_REGIONAL_EVIDENCE_POLICY.sourceDescriptorSha256,
      },
      kind: "regional-evidence",
      masks: {
        height: collected.resultEvidence.height,
        protectedRegion: { encoding: "rle-row-major/v1", runs: [[1, 1]] },
        upperBody: { encoding: "rle-row-major/v1", runs: [[0, 1]] },
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
          changedPixels: 1,
          meanDelta: 1,
          sampledPixels: 1,
          verdict: "changed",
        },
      },
      policy: {
        schemaVersion: AI_REGIONAL_EVIDENCE_POLICY.schemaVersion,
        sha256: AI_REGIONAL_EVIDENCE_POLICY_SHA256,
      },
      schemaVersion: "vem-ai-regional-evidence/v1",
      verdict: "passed",
    };
    collected.regionalEvidence.bytes = canonicalBytes(sidecar);
    collected.expectedGarmentSha256 = sidecar.attempt.garmentSha256;
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
  const evidenceManifest = {
    files: attempts.map((attempt) => {
      const path = resolve(input.artifactRoot, attempt.regionalEvidence.path);
      const bytes = readFileSync(path);
      return {
        track: "aiVirtualTryOn",
        kind: "supportingEvidence",
        path,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      };
    }),
  };
  return assembleInstalledAiTryOnAcceptance(
    { ...input, attempts, evidenceManifest },
    dependencies,
  );
}

function parseCli(argv) {
  const [command, ...tokens] = argv;
  if (!["attempt", "sale", "assemble"].includes(command))
    throw new Error(
      "installed AI entry command must be attempt, sale, or assemble",
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
  return assembleInstalledAiTryOnAcceptanceFiles({
    artifactRoot: options["artifact-root"],
    candidateInputDirectory: options["candidate-input-directory"],
    longAttemptPath: options["long-attempt"],
    outPath: options.out,
    salePath: options.sale,
    shortAttemptPath: options["short-attempt"],
    windowsProofInputDirectory: options["windows-proof-input-directory"],
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}
