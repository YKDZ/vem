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
import test from "node:test";

import {
  factoryBootstrapScript,
  factoryOobeCompletionScript,
  factoryOobeBootstrapPreparationScript,
  hostPersonalizationIngestScript,
} from "./factory/build-factory-media.mjs";
import {
  buildRemotePowerShellScript,
  resolveCleanBaseFactoryCapabilityInputs,
} from "./testbed/win10-vem-e2e.mjs";

function run(command, args) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function assertPowerShellParses(path) {
  const result = run("pwsh", [
    "-NoProfile",
    "-Command",
    [
      "$tokens = $null",
      "$errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${path.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null`,
      "if (@($errors).Count -gt 0) { $errors | ForEach-Object { Write-Error ([string]$_) }; exit 1 }",
    ].join("; "),
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function runHostPersonalizationIngestFixture({
  root,
  ingestScript,
  scenario,
  personalization,
}) {
  const mediaRoot = join(root, `personalization-media-${scenario}`);
  const destination = join(
    root,
    `personalization-destination-${scenario}`,
    "one-time-personalization.json",
  );
  const runner = join(root, `run-personalization-ingest-${scenario}.ps1`);
  mkdirSync(mediaRoot, { recursive: true });
  if (scenario === "success" || scenario === "fixed" || scenario === "mixed")
    writeFileSync(join(mediaRoot, "personalization.json"), personalization);
  writeFileSync(
    runner,
    `param([string]$Mode, [string]$MediaRoot, [string]$DestinationPath, [string]$IngestScript)
$ErrorActionPreference = 'Stop'
$root = [pscustomobject]@{ FullName = $MediaRoot }
$valid = [pscustomobject]@{ IsReady = $true; VolumeLabel = 'VEM_PERSONALIZATION'; DriveType = 5; RootDirectory = $root }
$drives = switch ($Mode) {
  'multiple' { @($valid, $valid) }
  'mixed' { @($valid, [pscustomobject]@{ IsReady = $true; VolumeLabel = 'VEM_PERSONALIZATION'; DriveType = 3; RootDirectory = $root }) }
  'fixed' { @([pscustomobject]@{ IsReady = $true; VolumeLabel = 'VEM_PERSONALIZATION'; DriveType = 3; RootDirectory = $root }) }
  'missing' { @([pscustomobject]@{ IsReady = $true; VolumeLabel = 'OTHER'; DriveType = 5; RootDirectory = $root }) }
  default { @($valid) }
}
& $IngestScript -DestinationPath $DestinationPath -CandidateDrives $drives
`,
  );
  const result = run("pwsh", [
    "-NoLogo",
    "-NoProfile",
    "-File",
    runner,
    scenario,
    mediaRoot,
    destination,
    ingestScript,
  ]);
  return {
    destination,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status,
  };
}

test("host personalization ingest runs under required PowerShell without Factory builder tools", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-host-personalization-"));
  try {
    const ingestScript = join(root, "ingest-host-personalization.ps1");
    const personalization = '{"secret":"host-only-personalization"}\n';
    writeFileSync(ingestScript, hostPersonalizationIngestScript(), "utf8");
    const success = runHostPersonalizationIngestFixture({
      root,
      ingestScript,
      scenario: "success",
      personalization,
    });
    assert.equal(success.status, 0, success.output);
    assert.equal(readFileSync(success.destination, "utf8"), personalization);
    assert.doesNotMatch(success.output, /host-only-personalization/);
    const rejectedScenarios = new Map([
      ["missing", "VEM_PERSONALIZATION_MEDIA_COUNT_INVALID"],
      ["multiple", "VEM_PERSONALIZATION_MEDIA_COUNT_INVALID"],
      ["mixed", "VEM_PERSONALIZATION_MEDIA_COUNT_INVALID"],
      ["fixed", "VEM_PERSONALIZATION_MEDIA_TYPE_INVALID"],
    ]);
    for (const [scenario, errorCode] of rejectedScenarios) {
      const rejected = runHostPersonalizationIngestFixture({
        root,
        ingestScript,
        scenario,
        personalization,
      });
      assert.notEqual(rejected.status, 0, `${scenario} must be rejected`);
      assert.match(rejected.output, new RegExp(errorCode));
      assert.doesNotMatch(rejected.output, /host-only-personalization/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PowerShell behavior fixtures execute through the real binder", () => {
  const result = run("pwsh", [
    "-NoProfile",
    "-File",
    "scripts/windows/test-factory-maintenance-fixtures.ps1",
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /executable PowerShell probes passed/);
});

test("Factory OOBE cleanup keeps its task through reboot and completes only after a kiosk console session", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-oobe-cleanup-reentry-"));
  const fixturePath = join(root, "fixture.ps1");
  const bootstrapStatusPath = join(root, "oobe-bootstrap-status.json");
  const cleanupStatusPath = join(root, "oobe-cleanup-status.json");
  const kioskAutologonStatePath = join(root, "oobe-kiosk-autologon-password");
  try {
    writeFileSync(
      bootstrapStatusPath,
      JSON.stringify({
        schemaVersion: "vem-factory-oobe-bootstrap-status/v1",
        state: "succeeded",
        stage: "complete",
        errorType: "",
      }),
    );
    writeFileSync(kioskAutologonStatePath, "fixture-kiosk-password");
    const escapedRoot = root.replaceAll("'", "''");
    const completion = factoryOobeCompletionScript().replace(
      "$factoryRoot = 'C:\\ProgramData\\VEM\\factory'",
      `$factoryRoot = '${escapedRoot}'`,
    );
    assert.doesNotMatch(completion, /C:\\ProgramData\\VEM\\factory/);
    writeFileSync(
      fixturePath,
      `$ErrorActionPreference = 'Stop'
$script:TaskRegistered = $true
$script:Winlogon = @{}
$script:RestartRequests = 0
$env:COMPUTERNAME = 'VEM-TESTBED'
function Get-ItemProperty { param($LiteralPath, $ErrorAction) [pscustomobject]@{ OOBEInProgress = 0; SystemSetupInProgress = 0; SetupType = 0 } }
function Get-LocalUser { param($Name, $ErrorAction) if ($Name -ceq 'VEMOobeBootstrap') { [pscustomobject]@{ Name = $Name } } }
function Get-CimInstance { param($ClassName, $ErrorAction) if ($ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{ LastBootUpTime = [DateTime]'2026-07-15T00:00:00Z' } }; throw "unexpected CIM class: $ClassName" }
function Set-ItemProperty { param($Path, $Name, $Value, [switch]$Force) $script:Winlogon[$Name] = $Value }
function Remove-ItemProperty { param($Path, $Name, $ErrorAction) }
function Remove-LocalUser { param($Name, $ErrorAction) }
function Get-Volume { param($ErrorAction) @() }
function New-Object { param($ComObject) [pscustomobject]@{} }
function Start-Sleep { param($Seconds) throw "initial cleanup must not busy-wait: $Seconds" }
function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) $script:TaskRegistered = $false }
function Get-ScheduledTask { param($TaskName, $ErrorAction) if ($script:TaskRegistered) { [pscustomobject]@{ TaskName = $TaskName } } }
function shutdown.exe { if (($args -join ' ') -cne '/r /t 0 /f') { throw 'cleanup restart must be immediate and forced' }; $script:RestartRequests += 1; throw 'restart service temporarily unavailable' }
try { ${completion}; throw 'cleanup reboot failure fixture unexpectedly succeeded' } catch { if ([string]$_ -notmatch 'handoff reboot request 1 failed') { throw } }
if (-not $script:TaskRegistered) { throw 'cleanup task was removed before the requested reboot' }
if ($script:RestartRequests -cne 1) { throw "cleanup must make one scheduler-managed restart request; got $script:RestartRequests" }
if ($script:Winlogon.AutoAdminLogon -cne '1') { throw 'AutoAdminLogon was not restored' }
if ($script:Winlogon.ForceAutoLogon -cne '1') { throw 'ForceAutoLogon was not restored' }
if ($script:Winlogon.DefaultUserName -cne 'VEMKiosk') { throw 'DefaultUserName was not restored' }
if ($script:Winlogon.DefaultDomainName -cne 'VEM-TESTBED') { throw 'DefaultDomainName was not restored' }
if ($script:Winlogon.DefaultPassword -cne 'fixture-kiosk-password') { throw 'DefaultPassword was not restored from the persisted handoff' }
if (Test-Path -LiteralPath '${kioskAutologonStatePath.replaceAll("'", "''")}') { throw 'kiosk autologon handoff was not consumed' }
$cleanupStatus = Get-Content -LiteralPath '${cleanupStatusPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
if ($cleanupStatus.phase -cne 'reboot-pending') { throw 'cleanup did not persist reboot-pending before restart' }
if ($cleanupStatus.rebootOriginBootIdentity -cne '2026-07-15T00:00:00.0000000Z') { throw 'cleanup did not persist the pre-reboot boot identity' }
if ($cleanupStatus.rebootAttemptCount -ne 1) { throw 'cleanup did not persist the first restart attempt' }
if ([string]::IsNullOrWhiteSpace([string]$cleanupStatus.lastRebootFailure)) { throw 'cleanup did not persist the restart failure' }
`,
    );
    const result = run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      fixturePath,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const sameBootReentryFixturePath = join(root, "same-boot-reentry.ps1");
    writeFileSync(
      cleanupStatusPath,
      JSON.stringify({
        schemaVersion: "vem-factory-oobe-cleanup-status/v1",
        phase: "reboot-pending",
        rebootOriginBootIdentity: "2026-07-15T00:00:00.0000000Z",
        rebootAttemptCount: 1,
        lastRebootFailure: "restart service temporarily unavailable",
      }),
    );
    writeFileSync(
      sameBootReentryFixturePath,
      `$ErrorActionPreference = 'Stop'
$script:TaskRegistered = $true
$script:RestartRequests = 0
function Get-ItemProperty { param($LiteralPath, $ErrorAction) [pscustomobject]@{ OOBEInProgress = 0; SystemSetupInProgress = 0; SetupType = 0 } }
function Get-LocalUser { param($Name, $ErrorAction) $null }
function Get-CimInstance { param($ClassName, $ErrorAction) if ($ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{ LastBootUpTime = [DateTime]'2026-07-15T00:00:00Z' } }; throw "unexpected CIM class: $ClassName" }
function Start-Sleep { param($Seconds) throw "same-boot reentry must not busy-wait: $Seconds" }
function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) $script:TaskRegistered = $false }
function Get-ScheduledTask { param($TaskName, $ErrorAction) if ($script:TaskRegistered) { [pscustomobject]@{ TaskName = $TaskName } } }
function shutdown.exe { $script:RestartRequests += 1; throw 'restart service temporarily unavailable' }
try { ${completion}; throw 'same-boot retry fixture unexpectedly succeeded' } catch { if ([string]$_ -notmatch 'handoff reboot request 2 failed') { throw } }
if ($script:RestartRequests -ne 1) { throw "same-boot reentry must make one retry request; got $script:RestartRequests" }
$cleanupStatus = Get-Content -LiteralPath '${cleanupStatusPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
if ($cleanupStatus.rebootAttemptCount -ne 2) { throw 'same-boot reentry did not persist the bounded second attempt' }
if ([string]::IsNullOrWhiteSpace([string]$cleanupStatus.lastRebootFailure)) { throw 'same-boot reentry did not persist the retry failure' }
`,
    );
    const sameBootReentry = run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      sameBootReentryFixturePath,
    ]);
    assert.equal(
      sameBootReentry.status,
      0,
      `${sameBootReentry.stdout}\n${sameBootReentry.stderr}`,
    );

    writeFileSync(
      cleanupStatusPath,
      JSON.stringify({
        schemaVersion: "vem-factory-oobe-cleanup-status/v1",
        phase: "reboot-pending",
        rebootOriginBootIdentity: "2026-07-15T00:00:00.0000000Z",
      }),
    );
    const afterRebootFixturePath = join(root, "after-reboot.ps1");
    writeFileSync(
      afterRebootFixturePath,
      `$ErrorActionPreference = 'Stop'
$script:TaskRegistered = $true
$script:RestartRequests = 0
$env:COMPUTERNAME = 'VEM-TESTBED'
function Get-ItemProperty { param($LiteralPath, $ErrorAction) [pscustomobject]@{ OOBEInProgress = 0; SystemSetupInProgress = 0; SetupType = 0 } }
function Get-LocalUser { param($Name, $ErrorAction) $null }
function Get-CimInstance { param($ClassName, $ErrorAction) if ($ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{ LastBootUpTime = [DateTime]'2026-07-15T00:10:00Z' } }; if ($ClassName -eq 'Win32_ComputerSystem') { return [pscustomobject]@{ UserName = 'VEM-TESTBED\\VEMKiosk' } }; throw "unexpected CIM class: $ClassName" }
function Start-Sleep { param($Seconds) throw "unexpected post-reboot wait: $Seconds" }
function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) $script:TaskRegistered = $false }
function Get-ScheduledTask { param($TaskName, $ErrorAction) if ($script:TaskRegistered) { [pscustomobject]@{ TaskName = $TaskName } } }
function shutdown.exe { $script:RestartRequests += 1 }
${completion}
if ($script:TaskRegistered) { throw 'cleanup task was not removed after kiosk console proof' }
if ($script:RestartRequests -ne 0) { throw 'post-reboot cleanup must not request another reboot' }
$cleanupStatus = Get-Content -LiteralPath '${cleanupStatusPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
if ($cleanupStatus.phase -cne 'complete') { throw 'post-reboot cleanup did not reach complete' }
if ($cleanupStatus.completedBootIdentity -cne '2026-07-15T00:10:00.0000000Z') { throw 'post-reboot cleanup did not record the completed boot identity' }
if ($cleanupStatus.kioskConsoleSession.user -cne 'VEMKiosk') { throw 'post-reboot cleanup did not record the VEMKiosk console session' }
`,
    );
    const afterReboot = run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      afterRebootFixturePath,
    ]);
    assert.equal(
      afterReboot.status,
      0,
      `${afterReboot.stdout}\n${afterReboot.stderr}`,
    );

    const completedReentryFixturePath = join(root, "completed-reentry.ps1");
    writeFileSync(
      completedReentryFixturePath,
      `$ErrorActionPreference = 'Stop'
$script:TaskRegistered = $true
$script:RestartRequests = 0
function Get-ItemProperty { param($LiteralPath, $ErrorAction) [pscustomobject]@{ OOBEInProgress = 0; SystemSetupInProgress = 0; SetupType = 0 } }
function Get-LocalUser { param($Name, $ErrorAction) $null }
function Start-Sleep { param($Seconds) throw "completed cleanup must not wait: $Seconds" }
function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) $script:TaskRegistered = $false }
function Get-ScheduledTask { param($TaskName, $ErrorAction) if ($script:TaskRegistered) { [pscustomobject]@{ TaskName = $TaskName } } }
function shutdown.exe { $script:RestartRequests += 1 }
${completion}
if ($script:TaskRegistered) { throw 'completed cleanup reentry did not remove its retained task' }
if ($script:RestartRequests -ne 0) { throw 'completed cleanup reentry requested another reboot' }
`,
    );
    const completedReentry = run("pwsh", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      completedReentryFixturePath,
    ]);
    assert.equal(
      completedReentry.status,
      0,
      `${completedReentry.stdout}\n${completedReentry.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Factory OOBE cleanup refuses credentials-removed while kiosk autologon handoff is retained", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-oobe-cleanup-retained-"));
  const bootstrapStatusPath = join(root, "oobe-bootstrap-status.json");
  const cleanupStatusPath = join(root, "oobe-cleanup-status.json");
  const kioskAutologonStatePath = join(root, "oobe-kiosk-autologon-password");
  const personalizationPath = join(root, "one-time-personalization.json");
  try {
    writeFileSync(
      bootstrapStatusPath,
      JSON.stringify({
        schemaVersion: "vem-factory-oobe-bootstrap-status/v1",
        state: "succeeded",
        stage: "complete",
        errorType: "",
      }),
    );
    const escapedRoot = root.replaceAll("'", "''");
    const completion = factoryOobeCompletionScript().replace(
      "$factoryRoot = 'C:\\ProgramData\\VEM\\factory'",
      `$factoryRoot = '${escapedRoot}'`,
    );
    const commonPrefix = `$ErrorActionPreference = 'Stop'
function Get-ItemProperty { param($LiteralPath, $ErrorAction) [pscustomobject]@{ OOBEInProgress = 0; SystemSetupInProgress = 0; SetupType = 0 } }
function Get-LocalUser { param($Name, $ErrorAction) $null }
function Start-Sleep { param($Seconds) throw "retained cleanup fixture must not wait: $Seconds" }
`;

    for (const [scenario, removeItemOverride, expected] of [
      [
        "delete-fails",
        `function Remove-Item { param($LiteralPath, [switch]$Force, $ErrorAction) if ($LiteralPath -ceq '${kioskAutologonStatePath.replaceAll("'", "''")}') { throw 'simulated kiosk handoff retention' }; Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }`,
        /simulated kiosk handoff retention/,
      ],
      [
        "retained-after-delete",
        `function Remove-Item { param($LiteralPath, [switch]$Force, $ErrorAction) if ($LiteralPath -ceq '${kioskAutologonStatePath.replaceAll("'", "''")}') { return }; Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction $ErrorAction }`,
        /Factory OOBE kiosk autologon handoff remains after cleanup/,
      ],
    ]) {
      writeFileSync(kioskAutologonStatePath, "fixture-kiosk-password", "utf8");
      writeFileSync(personalizationPath, "fixture-personalization", "utf8");
      writeFileSync(
        cleanupStatusPath,
        JSON.stringify({
          schemaVersion: "vem-factory-oobe-cleanup-status/v1",
          phase: "account-removed",
        }),
      );
      const fixturePath = join(root, `${scenario}.ps1`);
      writeFileSync(
        fixturePath,
        `${commonPrefix}
${removeItemOverride}
try { ${completion}; throw '${scenario} unexpectedly succeeded' } catch { if ([string]$_ -notmatch '${expected.source.replaceAll("'", "''")}') { throw } }
$cleanupStatus = Get-Content -LiteralPath '${cleanupStatusPath.replaceAll("'", "''")}' -Raw | ConvertFrom-Json
if ($cleanupStatus.phase -cne 'account-removed') { throw '${scenario} recorded credentials-removed despite retained kiosk handoff' }
if (-not (Test-Path -LiteralPath '${kioskAutologonStatePath.replaceAll("'", "''")}')) { throw '${scenario} fixture lost retained kiosk handoff proof' }
`,
      );
      const result = run("pwsh", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fixturePath,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all factory maintenance PowerShell entrypoints parse", () => {
  for (const path of [
    "scripts/windows/prepare-factory-runtime.ps1",
    "scripts/windows/setup-scheduled-tasks.ps1",
    "scripts/windows/verify-factory-runtime.ps1",
    "scripts/windows/test-factory-maintenance-fixtures.ps1",
  ]) {
    assertPowerShellParses(path);
  }

  const root = mkdtempSync(join(tmpdir(), "vem-factory-generated-powershell-"));
  try {
    for (const profile of ["production", "testbed"]) {
      for (const [name, source] of [
        [
          "prepare-oobe-bootstrap",
          factoryOobeBootstrapPreparationScript(profile),
        ],
        ["bootstrap-factory-runtime", factoryBootstrapScript(profile)],
        ["complete-oobe-bootstrap", factoryOobeCompletionScript()],
      ]) {
        const path = join(root, `${profile}-${name}.ps1`);
        writeFileSync(path, source);
        assertPowerShellParses(path);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Factory bootstrap capability hashing stays compatible with Windows PowerShell 5.1", () => {
  const preparation = readFileSync(
    "scripts/windows/prepare-factory-runtime.ps1",
    "utf8",
  );
  const factoryWriter = preparation.slice(
    preparation.indexOf("function Write-FactoryRuntimeFiles"),
  );

  assert.doesNotMatch(
    factoryWriter,
    /\[Security\.Cryptography\.SHA256\]::HashData/,
  );
  assert.doesNotMatch(factoryWriter, /\[Convert\]::ToHexString/);
  assert.match(factoryWriter, /\[Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(factoryWriter, /\.ComputeHash\(/);
  assert.match(
    factoryWriter,
    /\[BitConverter\]::ToString\([^)]*\)\.Replace\("-", ""\)\.ToLowerInvariant\(\)/,
  );

  // The target applies this entrypoint through inbox Windows PowerShell, while
  // CI's parser check keeps the source syntactically valid before it reaches a
  // Windows acceptance host.
  const testbed = readFileSync("scripts/testbed/win10-vem-e2e.mjs", "utf8");
  assert.match(
    testbed,
    /& powershell\.exe -NoProfile -ExecutionPolicy Bypass -File \$verifierPath/,
  );
  assertPowerShellParses("scripts/windows/prepare-factory-runtime.ps1");
});

test("factory preparation hardens maintenance login before network package installation", () => {
  const preparation = readFileSync(
    "scripts/windows/prepare-factory-runtime.ps1",
    "utf8",
  );
  const writeRuntime = preparation.slice(
    preparation.indexOf("function Write-FactoryRuntimeFiles"),
  );
  assert.ok(
    writeRuntime.indexOf("Set-FactoryMaintenanceAccountPassword") <
      writeRuntime.indexOf("Install-PinnedWindowsPackage"),
  );
  assert.match(
    preparation,
    /Start-Process[\s\S]+WebView2 Runtime installer failed[\s\S]+Get-WebView2RuntimeEvidence/,
  );
  assert.match(
    writeRuntime,
    /Install-WebView2Runtime[\s\S]+Install-PinnedWindowsPackage/,
  );
  const passwordSetter = preparation.slice(
    preparation.indexOf("function Set-FactoryMaintenanceAccountPassword"),
    preparation.indexOf("function New-EvidenceItem"),
  );
  assert.match(passwordSetter, /Set-LocalUser[\s\S]+Enable-LocalUser/);
  const rolePoolValidator = preparation.slice(
    preparation.indexOf("function ConvertTo-ExactHostAddresses"),
    preparation.indexOf("function Invoke-NamedPowerShellScript"),
  );
  assert.match(rolePoolValidator, /\$prefix -ne \$requiredPrefix/);
  assert.doesNotMatch(rolePoolValidator, /\$maximumPrefix/);
  assert.match(rolePoolValidator, /\$address\.IPAddressToString/);
  assert.match(rolePoolValidator, /Runner = \$runner/);
  assert.match(rolePoolValidator, /Maintainer = \$maintainer/);
  assert.doesNotMatch(
    preparation,
    /icacls\.exe[^\r\n]+(?:\bSYSTEM\b|\bAdministrators\b)/,
  );
  assert.match(
    preparation,
    /icacls\.exe[^\r\n]+"\*S-1-5-18:F"[^\r\n]+"\*S-1-5-32-544:F"[\s\S]+\$LASTEXITCODE -ne 0/,
  );

  const scheduledTasks = readFileSync(
    "scripts/windows/setup-scheduled-tasks.ps1",
    "utf8",
  );
  const autoLogon = scheduledTasks.slice(
    scheduledTasks.indexOf("function Configure-WinlogonAutoLogon"),
    scheduledTasks.indexOf("function Get-ScheduledTaskStartupEvidence"),
  );
  assert.ok(
    autoLogon.indexOf("AutoLogonCount") < autoLogon.indexOf("AutoAdminLogon"),
  );
  const configureKioskShell = scheduledTasks.slice(
    scheduledTasks.indexOf("function Configure-KioskShell"),
    scheduledTasks.indexOf("function Ensure-DaemonDataDirectory"),
  );
  assert.match(
    configureKioskShell,
    /if \(\$null -ne \$shellLauncher\)[\s\S]+Set-PerUserWinlogonShell[\s\S]+else \{[\s\S]+sole kiosk UI owner/,
  );
  assert.doesNotMatch(
    configureKioskShell.slice(configureKioskShell.indexOf("} else {")),
    /Set-PerUserWinlogonShell/,
  );
});

test("WebView2 preparation normalizes and enforces the exact pinned runtime version", () => {
  const preparation = readFileSync(
    "scripts/windows/prepare-factory-runtime.ps1",
    "utf8",
  );
  const functions = preparation.slice(
    preparation.indexOf("function ConvertTo-WebView2ManifestVersion"),
    preparation.indexOf("function Test-PinnedVersionEquivalent"),
  );
  const fixture = `${functions}
$script:InstalledVersion = '150.0.4078.65'
$script:InstallerRuns = 0
function Get-ItemProperty { param($LiteralPath, $ErrorAction) [pscustomobject]@{ pv = $script:InstalledVersion } }
function Start-Process { param($FilePath, $ArgumentList, [switch]$PassThru, [switch]$Wait) $script:InstallerRuns += 1; $script:InstalledVersion = '150.0.4078.65'; [pscustomobject]@{ ExitCode = 0 } }
$package = [pscustomobject]@{ localInstallPath = 'fixture.exe'; version = '150.0.4078+65' }
$matching = Install-WebView2Runtime -Package $package
if (-not $matching.skipped -or $script:InstallerRuns -ne 0) { throw 'matching runtime must skip installation' }
$script:InstalledVersion = '149.0.4022.98'
$installed = Install-WebView2Runtime -Package $package
if ($installed.skipped -or $script:InstallerRuns -ne 1) { throw 'mismatched runtime must execute the pinned installer' }
if ((ConvertTo-WebView2ManifestVersion -Version '150.0.4078.65') -cne '150.0.4078+65') { throw 'four-part version normalization failed' }
`;
  const result = run("pwsh", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    fixture,
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("generated clean-base orchestration is profile-neutral and parses", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-issue09-node-"));
  try {
    const common = {
      mode: "clean-base-factory-acceptance",
      runId: "ISSUE09-CONTRACT",
      cleanBaseSource: "factory-media://clean-windows",
      cleanBaseSnapshot: "before-vem",
      remoteSupportScriptRoot: "C:\\Windows\\Temp\\vem-issue09",
      remoteUploadedArtifactRoot:
        "C:\\Windows\\Temp\\vem-issue09\\input-artifacts",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
      factoryHardwareModel: "declared-hardware-model",
      factoryTopologyIdentity: "declared-topology",
      factoryTopologyVersion: "v1",
      openSshPackageVersion: "9.8.1",
      wireGuardPackageVersion: "0.5.3",
      openSshApprovedSignerThumbprint: "1".repeat(40),
      openSshApprovedRootThumbprint: "2".repeat(40),
      wireGuardApprovedSignerThumbprint: "3".repeat(40),
      wireGuardApprovedRootThumbprint: "4".repeat(40),
      maintenanceWireGuardListenAddress: "10.77.0.10",
      maintenanceRunnerSourceAllowlist: "10.77.0.2",
      maintenanceMaintainerSourceAllowlist: "10.77.0.3",
      remoteOpenSshPackagePath: "C:\\Windows\\Temp\\OpenSSH.msi",
      remoteWireGuardPackagePath: "C:\\Windows\\Temp\\WireGuard.msi",
      remoteMaintenanceCaPublicKeyPath: "C:\\Windows\\Temp\\maintenance-ca.pub",
      factoryMediaRoot: "C:\\VEM\\factory-media",
      visionConfigurationSourcePath:
        "C:\\VEM\\factory-media\\assets\\vision-configuration.json",
      maintenanceCaPublicKeySha256: "c".repeat(64),
      openSshPackageSha256: "d".repeat(64),
      wireGuardPackageSha256: "e".repeat(64),
      platformApiBaseUrl: "https://api.production.invalid/api",
      platformMqttUrl: "mqtts://mqtt.production.invalid:8883",
    };
    const production = buildRemotePowerShellScript({
      ...common,
      factoryProfile: "production",
    });
    const testbed = buildRemotePowerShellScript({
      ...common,
      factoryProfile: "testbed",
      platformApiBaseUrl: "http://test-platform.invalid/api",
      platformMqttUrl: "mqtt://test-platform.invalid:1883",
    });

    const productionInvocation = production.slice(
      production.indexOf("run scripted clean-base factory runtime preparation"),
      production.indexOf("run scripted clean-base factory runtime verifier"),
    );
    assert.match(productionInvocation, /HardwareMode = 'production'/);
    assert.match(productionInvocation, /ExpectedMaintenanceUser = 'Admin'/);
    assert.match(productionInvocation, /FactoryProfile = 'production'/);
    assert.match(
      productionInvocation,
      /FactoryMediaRoot = 'C:\\VEM\\factory-media'/,
    );
    assert.match(
      productionInvocation,
      /VisionConfigurationSourcePath = 'C:\\VEM\\factory-media\\assets\\vision-configuration\.json'/,
    );
    assert.doesNotMatch(
      productionInvocation,
      /YKDZ|legacy-provider|simulated/i,
    );
    assert.match(
      productionInvocation,
      /MaintenanceWireGuardListenAddress = '10\.77\.0\.10'/,
    );
    assert.match(
      production,
      /Invoke-FactoryChildPowerShell -Actions .* -Name .* -ScriptPath .* -Arguments/s,
    );

    const testbedInvocation = testbed.slice(
      testbed.indexOf("run scripted clean-base factory runtime preparation"),
      testbed.indexOf("run scripted clean-base factory runtime verifier"),
    );
    assert.match(testbedInvocation, /HardwareMode = 'simulated'/);
    assert.match(testbedInvocation, /ExpectedMaintenanceUser = 'YKDZ'/);
    assert.match(testbedInvocation, /FactoryProfile = 'testbed'/);

    const productionPath = join(root, "production.ps1");
    const testbedPath = join(root, "testbed.ps1");
    writeFileSync(productionPath, production, "utf8");
    writeFileSync(testbedPath, testbed, "utf8");
    assertPowerShellParses(productionPath);
    assertPowerShellParses(testbedPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture evidence contains no credential or private-key material", () => {
  const evidence = JSON.parse(
    readFileSync(
      "scripts/windows/factory-maintenance-fixtures/clean-state-evidence.json",
      "utf8",
    ),
  );
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.schemaVersion, "vem-factory-runtime-verification/v2");
  assert.equal(evidence.checks.passwordAuthentication.passwordFallback, false);
  assert.deepEqual(evidence.checks.factoryRemoteMaintenanceCapability.ingress, {
    profile: "testbed",
    mode: "testbed-runner-direct-plus-wireguard",
    effectiveListenAddress: "0.0.0.0",
    effectiveFirewallInterfaceScope: "Any",
    expectedMode: "testbed-runner-direct-plus-wireguard",
    expectedListenAddress: "0.0.0.0",
    expectedFirewallInterfaceScope: "Any",
    profileBound: true,
    wireGuardOnly: false,
    runnerDirectPlusWireGuard: true,
  });
  assert.equal(
    evidence.checks.factoryRemoteMaintenanceCapability.firewallScope
      .roleScopedRulesMatch,
    true,
  );
  assert.doesNotMatch(
    serialized,
    /BEGIN .*PRIVATE KEY|privateKeyValue|VEM_.*PASSWORD|shared-password/i,
  );
});

test("production orchestration rejects testbed platform and identity inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-issue09-production-"));
  try {
    const openSsh = join(root, "OpenSSH.msi");
    const wireGuard = join(root, "WireGuard.msi");
    const ca = join(root, "maintenance-ca.pub");
    writeFileSync(openSsh, "openssh", "utf8");
    writeFileSync(wireGuard, "wireguard", "utf8");
    writeFileSync(
      ca,
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFactoryFixture vem-maintenance-ca:production\n",
      "utf8",
    );
    const options = {
      mode: "clean-base-factory-acceptance",
      factoryProfile: "production",
      openSshPackage: openSsh,
      wireGuardPackage: wireGuard,
      maintenanceCaPublicKey: ca,
      openSshPackageVersion: "9.8.1",
      wireGuardPackageVersion: "0.5.3",
      openSshApprovedSignerThumbprint: "1".repeat(40),
      openSshApprovedRootThumbprint: "2".repeat(40),
      wireGuardApprovedSignerThumbprint: "3".repeat(40),
      wireGuardApprovedRootThumbprint: "4".repeat(40),
      maintenanceWireGuardListenAddress: "10.91.16.10",
      maintenanceRunnerSourceAllowlist: "10.91.1.0/24",
      maintenanceMaintainerSourceAllowlist: "10.91.3.0/24",
      factoryHardwareModel: "production-cabinet-v1",
      factoryTopologyIdentity: "production-topology-v1",
      factoryTopologyVersion: "v1",
      remote: "Admin@factory-host",
      platformApiBaseUrl: "http://118.25.104.160:26849/api",
      platformMqttUrl: "mqtt://118.25.104.160:1883",
    };
    assert.throws(
      () => resolveCleanBaseFactoryCapabilityInputs(options),
      /production factory capability rejects testbed or simulator inputs/,
    );

    const accepted = resolveCleanBaseFactoryCapabilityInputs({
      ...options,
      platformApiBaseUrl: "https://api.production.invalid/api",
      platformMqttUrl: "mqtts://mqtt.production.invalid:8883",
    });
    assert.equal(accepted.maintenanceUser, "Admin");
    assert.equal(accepted.hardwareMode, "production");
    assert.equal(accepted.wireGuardListenAddress, "10.91.16.10");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
