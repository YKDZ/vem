import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const runFullPath = "./run-full-vision-try-on-track.ps1";

function source() {
  return readFileSync(new URL(runFullPath, import.meta.url), "utf8");
}

test("run-full consumes only the pre-verified guest Vision core input", () => {
  const contents = source();
  assert.match(
    contents,
    /function Get-ProvisionedVisionCoreArtifact\(\[object\]\$GuestInput\) \{[\s\S]*runtimeArchive[\s\S]*fixtureArchive[\s\S]*sourceCommit/s,
  );
  assert.match(
    contents,
    /\$guestInput = Get-Content -Raw -LiteralPath \$GuestInputPath[\s\S]*Get-ProvisionedVisionCoreArtifact \$guestInput/s,
  );
  assert.doesNotMatch(contents, /Get-VisionMainArtifactCache/);
  assert.doesNotMatch(contents, /Get-ResolvedVisionMainCommit/);
  assert.doesNotMatch(contents, /resolved-vision-main-commit/);
});

test("run-full preserves the provisioned artifact identities through local candidate conversion", () => {
  const contents = source();
  assert.match(
    contents,
    /Get-FileHash -LiteralPath \(\[string\]\$item\.path\) -Algorithm SHA256[\s\S]*\.Length -ne \[long\]\$item\.identity\.byteSize/s,
  );
  assert.match(
    contents,
    /function Rebuild-ProvisionedVisionCoreDelivery[\s\S]*Convert-VisionCandidateToMainDelivery[\s\S]*-CandidateArchive \(\[string\]\$VisionCore\.runtimeArchive\)[\s\S]*-FixtureArchive \(\[string\]\$VisionCore\.fixtureArchive\)[\s\S]*-Commit \(\[string\]\$VisionCore\.commit\)/s,
  );
  assert.match(
    contents,
    /Assert-VisionCachedArtifacts \$candidateDelivery \(\[string\]\$VisionCore\.commit\)/,
  );
  assert.match(
    contents,
    /Install-VisionMainArtifact[\s\S]*-SkipRuntimeOwnerTask/s,
  );
});

test("run-full rebuilds a pre-seeded same-commit delivery from the current guest bytes", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/testbed/run-full-vision-try-on-track.windows-harness.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.notEqual(output.seededRuntimeSha256, output.rebuiltRuntimeSha256);
  assert.equal(output.rebuiltFromCurrentCandidate, true);
});

test("run-full takes over only after acquisition and restores the default VEMVisionRuntime owner", () => {
  const contents = source();
  assert.match(
    contents,
    /\$visionCore = Get-ProvisionedVisionCoreArtifact \$guestInput[\s\S]*\$managedVisionTakenOver = \$true[\s\S]*Stop-ManagedVision/s,
  );
  assert.match(
    contents,
    /finally \{[\s\S]*if \(\$managedVisionTakenOver\) \{[\s\S]*Stop-ManagedVision[\s\S]*Wait-ForVisionPortRebind[\s\S]*Start-DefaultManagedVision[\s\S]*Wait-ForDefaultManagedVisionReady/s,
  );
  assert.match(
    contents,
    /function Start-DefaultManagedVision\(\) \{[\s\S]*Start-ScheduledTask -TaskName "VEMVisionRuntime"/s,
  );
  assert.match(
    contents,
    /function Wait-ForDefaultManagedVisionReady[\s\S]*Invoke-VisionMainProbe/s,
  );
});

test("run-full waits out managed Vision restarts and diagnoses with structured owner facts", () => {
  const contents = source();
  assert.match(
    contents,
    /function Get-DefaultManagedVisionDiagnostic\(\) \{[\s\S]*processId[\s\S]*task[\s\S]*action[\s\S]*siteConfigurationSha256[\s\S]*listener/s,
  );
  assert.match(
    contents,
    /function Wait-ForDefaultManagedVisionReady[\s\S]*lastDiagnostic[\s\S]*did not become ready: \$\(\$?diagnostic \| ConvertTo-Json -Compress -Depth 8\)/s,
  );
});

test("run-full loops recorded cameras so the real V2 Fast path cannot exhaust a fixture", () => {
  const contents = source();
  assert.equal(contents.match(/loop = \$false/g)?.length, undefined);
  assert.equal(contents.match(/loop = \$true/g)?.length, 2);
});
