import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const modulePath = "scripts/windows/vision-main-artifacts.psm1";
const resolverPath = "scripts/windows/get-vision-main-artifacts.ps1";
const installerPath = "scripts/windows/install-vision-main-artifact.ps1";

function source(path) {
  return readFileSync(path, "utf8");
}

test("consumes the published Vision main Actions artifact contract", () => {
  const module = source(modulePath);
  assert.match(module, /hbhjt\/vending-vision/);
  assert.match(module, /vending-vision-main-/);
  assert.match(module, /vending-vision-windows-x86_64\.zip/);
  assert.match(module, /vending-vision-test-fixtures\.zip/);
  assert.match(module, /vending-vision-main-artifacts\.json/);
  assert.match(module, /vending-vision-main-artifacts\/v1/);
  assert.match(module, /head_branch -ceq "main"/);
  assert.match(module, /conclusion -ceq "success"/);
  assert.match(module, /foreach \(\$run in @\(Get-VisionEligibleMainRuns/);
  assert.match(module, /if \(\$matches\.Count -eq 0\) \{ continue \}/);
  assert.match(module, /Join-Path \$CacheRoot \$commit/);
});

test("keeps the runtime and recorded-video fixture archives separate", () => {
  const module = source(modulePath);
  assert.match(module, /runtime archive must not contain recorded-video fixtures/);
  assert.match(module, /recorded-video\/top\.mp4/);
  assert.match(module, /fixture-manifest\.json/);
  assert.match(module, /recorded-video configuration requires the separate fixture archive/);
  assert.match(module, /recorded-video path must be an extracted fixture/);
  assert.match(module, /recorded-video path must bind the committed \$\(\$binding\.label\) fixture/);
});

test("installs one fixed app directory and probes health plus machine protocol", () => {
  const module = source(modulePath);
  const installer = source(installerPath);
  assert.match(module, /C:\\VEM\\vision\\app/);
  assert.match(module, /C:\\ProgramData\\VEM\\vision\\site\.json/);
  assert.match(module, /C:\\ProgramData\\VEM\\vision\\runtime/);
  assert.match(module, /VISION_WORKDIR/);
  assert.match(module, /Ensure-VisionMainRuntimeWorkDirectory/);
  assert.match(module, /\(OI\)\(CI\)\(M\)/);
  assert.match(module, /Stop-VisionMainTask/);
  assert.match(module, /Start-VisionMainTask/);
  assert.match(module, /\/health/);
  assert.match(module, /vision\.hello/);
  assert.match(module, /vision\.ready/);
  assert.match(module, /while \(-not \$received\.EndOfMessage\)/);
  assert.match(module, /\$MaxMessageBytes = 65536/);
  assert.match(module, /Test-VisionMainProtocolTimestamp/);
  assert.match(module, /profile_push", "presence_status", "person_departed", "try_on_session/);
  assert.doesNotMatch(module, /serverVersion -cne \$health\.version/);
  assert.match(module, /Ensure-VisionMainTask/);
  assert.match(module, /vending-vision\.exe`" --config/);
  assert.match(module, /downloadManifest/);
  assert.match(module, /siteConfiguration = \[ordered\]@\{/);
  assert.match(module, /executableSha256 = \(Get-VisionSha256/);
  assert.match(module, /health\s*=\s*@\{\s*version\s*=\s*\$healthVersion/);
  assert.match(
    module,
    /Write-VisionMainLauncher[\s\S]*Ensure-VisionMainTask[\s\S]*Start-VisionMainTask/,
  );
  assert.match(installer, /Install-VisionMainArtifact/);
  assert.doesNotMatch(installer, /Library/);
});

test("builds bracketed IPv6 loopback URIs without changing IPv4", () => {
  const module = source(modulePath);
  assert.match(module, /Get-VisionMainUris/);
  assert.match(module, /\[\$HostName\]/);
});

test("removes retired candidate delivery entrypoints without a compatibility path", () => {
  for (const path of [
    "scripts/windows/install-vision-release.ps1",
    "scripts/windows/provision-vision-factory-release.ps1",
    "scripts/windows/test-vision-candidate.ps1",
    "scripts/windows/test-vision-candidate.fixtures.ps1",
    "scripts/windows/test-vision-candidate.windows-harness.ps1",
    "scripts/windows/vision-release-materialization.psm1",
    "scripts/windows/vision-diagnostic-redaction.psm1",
    "scripts/windows/vision-release-install.test.mjs",
    "scripts/windows/vision-release-install.fixtures.ps1",
    "scripts/windows/vision-release-install.windows-harness.ps1",
    "scripts/windows/vision-release-install-harness.behavior.ps1",
  ]) {
    assert.equal(existsSync(path), false, `${path} must remain deleted`);
  }
  const combined = `${source(modulePath)}\n${source(resolverPath)}\n${source(installerPath)}`;
  assert.doesNotMatch(combined, /candidate|approval|attestation|sbom|provenance|rollback|factory manifest|allowlist/i);
});

test("runtime verification cannot reintroduce versioned release selection", () => {
  const verify = source("scripts/windows/verify-vem-runtime.ps1");
  assert.match(verify, /VisionInstallRecord/);
  assert.match(verify, /VisionSiteConfiguration/);
  assert.match(verify, /Invoke-VisionMainProbe/);
  assert.doesNotMatch(verify, /healthVersion|health\.version/);
  assert.doesNotMatch(
    verify,
    /VisionSelection|approvalDigest|attestation|release-metadata|rollback/i,
  );
});
