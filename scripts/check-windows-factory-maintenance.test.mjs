import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
  if (scenario === "success" || scenario === "fixed")
    writeFileSync(join(mediaRoot, "personalization.json"), personalization);
  writeFileSync(
    runner,
    `param([string]$Mode, [string]$MediaRoot, [string]$DestinationPath, [string]$IngestScript)
$ErrorActionPreference = 'Stop'
New-PSDrive -Name P -PSProvider FileSystem -Root $MediaRoot | Out-Null
function Get-Volume {
  [CmdletBinding()]
  param()
  if ($Mode -eq 'multiple') {
    return @(
      [pscustomobject]@{ FileSystemLabel = 'VEM_PERSONALIZATION'; DriveLetter = 'P'; DriveType = 5 },
      [pscustomobject]@{ FileSystemLabel = 'VEM_PERSONALIZATION'; DriveLetter = 'Q'; DriveType = 5 }
    )
  }
  if ($Mode -eq 'fixed') {
    return @([pscustomobject]@{ FileSystemLabel = 'VEM_PERSONALIZATION'; DriveLetter = 'P'; DriveType = 3 })
  }
  return @([pscustomobject]@{ FileSystemLabel = 'VEM_PERSONALIZATION'; DriveLetter = 'P'; DriveType = 5 })
}
try {
  & $IngestScript -DestinationPath $DestinationPath
} finally {
  Remove-PSDrive -Name P -ErrorAction SilentlyContinue
}
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
    for (const scenario of ["missing", "multiple", "fixed"]) {
      const rejected = runHostPersonalizationIngestFixture({
        root,
        ingestScript,
        scenario,
        personalization,
      });
      assert.notEqual(rejected.status, 0, `${scenario} must be rejected`);
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
    assert.doesNotMatch(productionInvocation, /YKDZ|unraid|simulated/i);
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
    mode: "testbed-bootstrap-certificate",
    effectiveListenAddress: "0.0.0.0",
    effectiveFirewallInterfaceScope: "Any",
    profileBound: true,
    bootstrapTestbedOnly: true,
  });
  assert.equal(
    evidence.checks.factoryRemoteMaintenanceCapability.firewallScope
      .sourceRolePoolsMatch,
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
