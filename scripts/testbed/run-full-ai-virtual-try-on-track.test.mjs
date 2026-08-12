import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const runner = join(
  repoRoot,
  "scripts/testbed/run-full-ai-virtual-try-on-track.ps1",
);

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
