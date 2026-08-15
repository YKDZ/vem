import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const modulePath = "scripts/windows/vision-main-artifacts.psm1";
const resolverPath = "scripts/windows/get-vision-main-artifacts.ps1";
const installerPath = "scripts/windows/install-vision-main-artifact.ps1";
const powershell51Paths = [
  "scripts/windows/vision-main-consumer.windows-harness.ps1",
  "scripts/testbed/ai-acceptance-artifacts.psm1",
  "scripts/testbed/run-local-testbed-guest.ps1",
  "scripts/testbed/run-full-ai-virtual-try-on-track.ps1",
];

function source(path) {
  return readFileSync(path, "utf8");
}

test("keeps relative-path calculation compatible with Windows PowerShell 5.1", () => {
  for (const path of powershell51Paths) {
    assert.doesNotMatch(source(path), /\[IO\.Path\]::GetRelativePath/);
  }
});

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
  assert.match(
    module,
    /runtime archive must not contain recorded-video fixtures/,
  );
  assert.match(
    module,
    /_internal\/contracts\/vem_vision_v2\/fixtures\/client-valid\.json/,
  );
  assert.match(module, /unexpectedFixtures/);
  assert.match(module, /recorded-video\/top\.mp4/);
  assert.match(module, /fixture-manifest\.json/);
  assert.match(
    module,
    /recorded-video configuration requires the separate fixture archive/,
  );
  assert.match(module, /recorded-video path must be an extracted fixture/);
  assert.match(
    module,
    /recorded-video path must bind the committed \$\(\$binding\.label\) fixture/,
  );
});

test("adapts the attested candidate v3 layout before using the legacy installer", () => {
  const module = source(modulePath);
  assert.match(module, /function Convert-VisionCandidateToMainDelivery/);
  assert.match(module, /vending-vision-candidate-artifact\/v3/);
  assert.match(module, /candidate payload digest mismatch/);
  assert.match(module, /vending-vision-ai-worker/);
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
  assert.match(
    module,
    /Get-VisionMainOwnedProcessIds[\s\S]*Get-CimInstance Win32_Process[\s\S]*ExecutablePath[\s\S]*CommandLine[\s\S]*Stop-Process -Id \$processId/,
  );
  assert.match(module, /Split-VisionWindowsCommandLine/);
  assert.match(module, /Test-VisionMainCanonicalConfigurationCommandLine/);
  assert.match(module, /Test-VisionMainMultiprocessingForkCommandLine/);
  assert.match(module, /Get-VisionMainCanonicalProcessBinding/);
  assert.doesNotMatch(
    module,
    /CommandLine\)\.Replace\(\[string\]\[char\]34, ''\)\.ToLowerInvariant\(\)\.Contains/,
  );
  assert.doesNotMatch(module, /Get-Process -Name "vending-vision"/);
  assert.match(module, /Start-VisionMainTask/);
  assert.match(module, /\/health/);
  assert.match(module, /vision\.hello/);
  assert.match(module, /vision\.ready/);
  assert.match(module, /while \(-not \$received\.EndOfMessage\)/);
  assert.match(module, /\$MaxMessageBytes = 65536/);
  assert.match(module, /Test-VisionMainProtocolTimestamp/);
  assert.match(module, /Get-VisionV2ContractIdentity/);
  assert.match(module, /_internal\\contracts\\vem_vision_v2\\manifest\.json/);
  assert.match(module, /schemaVersion = \$contractIdentity\.schemaVersion/);
  assert.match(module, /contractDigest = \$contractIdentity\.contractDigest/);
  assert.match(
    module,
    /profile_push", "presence_status", "person_departed", "ambient_light", "try_on_fast/,
  );
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

test("runtime verification checks the installed Vision artifact", () => {
  const verify = source("scripts/windows/verify-vem-runtime.ps1");
  assert.match(verify, /VisionInstallRecord/);
  assert.match(verify, /VisionSiteConfiguration/);
  assert.match(verify, /Invoke-VisionMainProbe/);
  assert.match(verify, /ready\.payload\.fastReady -eq \$true/);
  assert.match(verify, /ready\.payload\.aiReady -is \[bool\]/);
  assert.match(verify, /ready\.payload\.aiReadinessDiagnostic/);
  assert.match(verify, /ready\.payload\.visionBusinessReady -eq \$true/);
  assert.match(
    verify,
    /ready\.payload\.businessReadinessDiagnostic -ceq "ready"/,
  );
});

test("can install Vision files without defining a second runtime owner", () => {
  const module = source(modulePath);
  const installer = source(installerPath);

  assert.match(module, /\[switch\]\$SkipRuntimeOwnerTask/);
  assert.match(
    module,
    /if \(-not \$SkipRuntimeOwnerTask\)[\s\S]*Ensure-VisionMainTask[\s\S]*Start-VisionMainTask/,
  );
  assert.match(module, /kind = "delegated"/);
  assert.match(module, /launcher = if \(\$null -ne \$legacyOwner\)/);
  assert.match(module, /startTask = if \(\$null -ne \$legacyOwner\)/);
  assert.match(installer, /\[switch\]\$SkipRuntimeOwnerTask/);
  assert.match(installer, /Install-VisionMainArtifact @PSBoundParameters/);
});
