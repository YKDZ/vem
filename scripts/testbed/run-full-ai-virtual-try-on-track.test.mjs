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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assembleInstalledAiTryOnAcceptanceForTest,
  sampleInstalledVisionPeakRssForTest,
} from "./ai-virtual-try-on-installed-entry.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const runner = join(
  repoRoot,
  "scripts/testbed/run-full-ai-virtual-try-on-track.ps1",
);
const ownerModule = join(repoRoot, "scripts/testbed/ai-vision-owner.psm1");

test("AI track owns the importable short/long/default Vision owner lifecycle", () => {
  assert.equal(existsSync(ownerModule), true);
  const source = readFileSync(runner, "utf8");
  assert.match(source, /Import-Module[^\n]*ai-vision-owner\.psm1/);
  assert.match(source, /Restart-TestbedAiVisionOwner[^\n]*short/);
  assert.match(source, /Restart-TestbedAiVisionOwner[^\n]*long/);
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
  assert.match(
    guest,
    /AI acceptance artifact root is not the exact owned regular directory/,
  );
  assert.match(guest, /FileAttributes\]::ReparsePoint/);
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
  assert.match(
    source,
    /D:\\\\runtime-cache\\\\v1\\\\powershell\\\\7\.4\.6\\\\pwsh\.exe/,
  );
  assert.doesNotMatch(source, /execFileAsync\(\s*["']pwsh["']/);
});
