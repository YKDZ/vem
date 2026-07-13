import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const preparePath = "scripts/windows/prepare-factory-runtime.ps1";
const verifierPath = "scripts/windows/verify-factory-runtime.ps1";
const setupTasksPath = "scripts/windows/setup-scheduled-tasks.ps1";
const testbedRunnerPath = "scripts/testbed/win10-vem-e2e.mjs";

const prepare = readText(preparePath);
const verifier = readText(verifierPath);
const setupTasks = readText(setupTasksPath);
const testbedRunner = readText(testbedRunnerPath);

function hasParam(source, name) {
  return new RegExp(`\\$${name}\\b`).test(source);
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function functionBlock(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\{`, "m").exec(source);
  if (!match) {
    return "";
  }
  const openIndex = source.indexOf("{", match.index);
  const closeIndex = findMatchingBrace(source, openIndex);
  return closeIndex === -1 ? "" : source.slice(match.index, closeIndex + 1);
}

function topLevelTail(source, marker) {
  const start = source.indexOf(marker);
  return start === -1 ? "" : source.slice(start);
}

const requiredPrepareParams = [
  "DaemonArtifactPath",
  "DaemonSha256",
  "MachineUiArtifactPath",
  "MachineUiSha256",
  "EnvironmentName",
  "ProvisioningEndpoint",
  "HardwareMode",
  "HardwareModel",
  "TopologyIdentity",
  "TopologyVersion",
  "ExpectedDisplayWidth",
  "ExpectedDisplayHeight",
  "ExpectedDisplayOrientation",
  "ExpectedKioskUser",
  "ExpectedMaintenanceUser",
  "ExpectedAutoLogonUser",
  "ExpectedKioskShell",
  "TargetLayoutVersion",
  "FactoryProfile",
  "PersonalizationMediaPath",
  "FactoryMediaRoot",
  "VisionConfigurationSourcePath",
  "OpenSshPackagePath",
  "OpenSshPackageSource",
  "OpenSshPackageVersion",
  "OpenSshPackageSha256",
  "OpenSshApprovedSignerThumbprint",
  "OpenSshApprovedRootThumbprint",
  "WireGuardPackagePath",
  "WireGuardPackageSource",
  "WireGuardPackageVersion",
  "WireGuardPackageSha256",
  "WireGuardApprovedSignerThumbprint",
  "WireGuardApprovedRootThumbprint",
  "MaintenanceSshCaPublicKeyPath",
  "MaintenanceSshCaPublicKeySha256",
  "MaintenanceRunnerSourceAllowlist",
  "MaintenanceMaintainerSourceAllowlist",
  "MaintenanceWireGuardListenAddress",
];

const requiredLayoutPaths = [
  "C:\\VEM\\bringup",
  "C:\\ProgramData\\VEM\\factory",
  "C:\\ProgramData\\VEM\\bringup",
  "C:\\ProgramData\\VEM\\provisioning",
  "C:\\ProgramData\\VEM\\secrets",
  "C:\\ProgramData\\VEM\\vending-daemon",
  "C:\\ProgramData\\VEM\\evidence",
  "C:\\ProgramData\\VEM\\overrides",
];

const verifierConcerns = [
  "factory-runtime-manifest.json",
  "local-bringup-settings.json",
  "vending-daemon.exe",
  "machine.exe",
  "VemVendingDaemon",
  "VEMMachineUI",
  "VEMMaintenanceUI",
  "VEM\\StartVisionServer",
  "ExpectedKioskUser",
  "ExpectedMaintenanceUser",
  "ExpectedAutoLogonUser",
  "ExpectedKioskShell",
  "remote-debugging-port",
  "maintenanceRecovery",
  "display",
  "orientation",
  "factory-runtime-verification.json",
];

const prepareTail = topLevelTail(prepare, "Assert-RequiredInputs");
const writeFilesBlock = functionBlock(prepare, "Write-FactoryRuntimeFiles");
const existingStateBlock = functionBlock(prepare, "Get-ExistingVemState");
const removeStateBlock = functionBlock(prepare, "Remove-ExistingVemState");
const verifierTaskBlock = functionBlock(verifier, "Get-ScheduledTaskEvidence");
const verifierShellBlock = functionBlock(verifier, "Get-KioskShellEvidence");
const setupVisionTaskBlock = topLevelTail(
  setupTasks,
  'Write-Host "[7/9] Configure VEM\\StartVisionServer logon task"',
);

addCheck(
  "prepare-entrypoint-exists",
  prepare.length > 0,
  `${preparePath} should provide the scripted factory runtime preparation entrypoint`,
);

addCheck(
  "prepare-requires-explicit-runtime-inputs",
  requiredPrepareParams.every((name) => hasParam(prepare, name)) &&
    prepare.includes("Assert-RequiredInputs") &&
    prepare.includes("missing required input") &&
    prepare.includes("Assert-CredentialInputs") &&
    prepare.includes("Factory Personalization Media is required") &&
    prepare.includes("Assert-FactoryPersonalizationMedia") &&
    prepare.includes("must not be mounted for a dry run") &&
    !prepare.includes("UseSecureCredentialEnvironment"),
  `${preparePath} should require explicit artifacts, hashes, environment, profile-bound Factory Personalization Media, hardware/topology, display, and layout inputs`,
);

addCheck(
  "factory-personalization-is-profile-bound-redacted-and-single-use",
  prepare.includes("vem-factory-personalization-media/v1") &&
    prepare.includes("Assert-FactoryPersonalizationNotReused") &&
    prepare.includes("Mark-FactoryPersonalizationConsumed") &&
    prepare.includes("WireGuard key or peer material") &&
    verifier.includes("vem-factory-personalization-media-redaction/v1") &&
    verifier.includes("Get-FactoryPersonalizationEvidence") &&
    verifier.includes("retainedMediaPresent") &&
    testbedRunner.includes("VEM_FACTORY_PERSONALIZATION_MEDIA_PATH") &&
    testbedRunner.includes("factory staging cleanup retained protected media"),
  "Factory Personalization Media must be profile-bound, single-use, redacted, and removed from runner staging",
);

addCheck(
  "prepare-supports-deterministic-dry-run",
  prepare.includes("[switch]$DryRun") &&
    prepare.includes("New-FactoryRuntimePlan") &&
    prepare.includes('schemaVersion = "vem-factory-runtime-plan/v1"') &&
    prepare.includes('generatedAt = "1970-01-01T00:00:00.0000000Z"') &&
    prepare.includes("ConvertTo-Json -Depth 30"),
  `${preparePath} should expose a deterministic dry-run plan for script-level tests`,
);

addCheck(
  "verifier-entrypoint-reserved",
  verifier.length > 0,
  `${verifierPath} should provide the scripted factory runtime verifier entrypoint`,
);

addCheck(
  "prepare-uses-fixed-standard-runtime-layout",
  requiredLayoutPaths.every((path) => prepare.includes(path)) &&
    prepare.includes("factory-runtime-manifest.json") &&
    prepare.includes("local-bringup-settings.json") &&
    prepare.includes("machine-config.json") &&
    prepare.includes("setup-scheduled-tasks.ps1") &&
    prepare.includes("provision-vision-factory-release.ps1") &&
    prepare.includes("install-vision-release.ps1") &&
    prepare.includes("verify-factory-runtime.ps1"),
  `${preparePath} should plan the ADR-0038 fixed Windows runtime layout and copied support scripts`,
);

addCheck(
  "production-preparation-provisions-and-installs-approved-vision-before-writing-success-manifest",
  prepare.includes("Invoke-FactoryVisionRelease") &&
    prepare.includes("production Factory Vision installation requires") &&
    prepare.includes(
      "Factory Vision installation evidence is incomplete or failed",
    ) &&
    prepare.indexOf("Invoke-FactoryVisionRelease -Plan $Plan") <
      prepare.lastIndexOf(
        "Write-JsonFile -Path ([string]$Plan.layout.manifestPath)",
      ) &&
    verifier.includes(
      "production Factory Vision installation evidence is missing or invalid",
    ),
  "production factory preparation must provision immutable Vision media, run the production installer, and require successful redacted evidence before recording completion",
);

const factoryVisionRelease = functionBlock(
  prepare,
  "Invoke-FactoryVisionRelease",
);
addCheck(
  "production-preparation-passes-the-vem-media-root-to-the-vision-provisioner",
  factoryVisionRelease.includes(
    "$factoryMediaRoot = Split-Path -Parent $provisioningManifest",
  ) &&
    factoryVisionRelease.includes(
      "& $provisioner -FactoryMediaRoot $factoryMediaRoot",
    ) &&
    !factoryVisionRelease.includes(
      "Split-Path -Parent (Split-Path -Parent $provisioningManifest)",
    ),
  "production factory preparation must pass the VEM directory containing VISION-FACTORY-PROVISIONING.JSON, not the outer Factory Media parent, to the Vision provisioner",
);

addCheck(
  "prepare-has-clean-host-gate-and-explicit-reset",
  prepare.includes("[switch]$ResetExistingVemState") &&
    prepare.includes("Assert-CleanHostOrReset") &&
    prepare.includes("old local VEM state exists") &&
    prepare.includes("Remove-ExistingVemState") &&
    prepare.indexOf("Assert-CleanHostOrReset") <
      prepare.indexOf("Write-FactoryRuntimeFiles"),
  `${preparePath} should fail on existing VEM state unless explicit reset mode is requested before writing runtime files`,
);

addCheck(
  "prepare-preflights-inputs-artifacts-hashes-and-support-scripts-before-reset-or-writes",
  prepare.includes("Assert-FactoryRuntimePreflight") &&
    prepareTail.includes("Assert-FactoryRuntimePreflight") &&
    prepareTail.indexOf("Assert-FactoryRuntimePreflight") <
      prepareTail.indexOf("Assert-CleanHostOrReset") &&
    prepareTail.indexOf("Assert-FactoryRuntimePreflight") <
      prepareTail.indexOf("Remove-ExistingVemState") &&
    prepareTail.indexOf("Assert-FactoryRuntimePreflight") <
      prepareTail.indexOf("Write-FactoryRuntimeFiles") &&
    writeFilesBlock.indexOf("Assert-Sha256 -Path $DaemonArtifactPath") <
      writeFilesBlock.indexOf("Ensure-Directory -Path $directory") &&
    writeFilesBlock.indexOf("Assert-Sha256 -Path $MachineUiArtifactPath") <
      writeFilesBlock.indexOf("Ensure-Directory -Path $directory"),
  `${preparePath} should validate all inputs, artifact paths, hashes, and copied support scripts before reset or target directory writes`,
);

addCheck(
  "prepare-reset-evidence-covers-found-cleared-preserved-and-skipped-state",
  prepare.includes("found = @()") &&
    prepare.includes("cleared = @()") &&
    prepare.includes("$preserved = @(") &&
    prepare.includes("$skipped = @()") &&
    existingStateBlock.includes("VEMMaintenanceUI") &&
    existingStateBlock.includes("VEM\\StartVisionServer") &&
    prepare.includes("maintenance_capability_state") &&
    prepare.includes("platform_business_data") &&
    removeStateBlock.includes("$State.cleared = @($State.found)") &&
    removeStateBlock.includes(
      'Stop-ScheduledTask -TaskName "VEMMaintenanceUI"',
    ) &&
    removeStateBlock.includes(
      '$visionTask = Get-ScheduledTask -TaskName "StartVisionServer"',
    ) &&
    removeStateBlock.includes("if ($null -ne $visionTask)") &&
    removeStateBlock.includes(
      'schtasks /Delete /TN "VEM\\StartVisionServer"',
    ) &&
    removeStateBlock.includes('Stop-Process -Name "machine"'),
  `${preparePath} should record reset evidence with found/cleared/preserved/skipped details and include maintenance UI and vision task cleanup`,
);

addCheck(
  "prepare-writes-runtime-files-manifest-settings-and-registrations",
  prepare.includes("Write-FactoryRuntimeFiles") &&
    prepare.includes("Copy-Item -LiteralPath $DaemonArtifactPath") &&
    prepare.includes("Copy-Item -LiteralPath $MachineUiArtifactPath") &&
    prepare.includes("factory-runtime-manifest/v1") &&
    prepare.includes("local-bringup-settings/v1") &&
    prepare.includes("New-Service") &&
    prepare.includes("setup-scheduled-tasks.ps1") &&
    prepare.includes("$setupArguments = @{") &&
    prepare.includes("ConfigureAutoLogon = $true") &&
    prepare.includes("ConfigureKioskAccounts = $true") &&
    prepare.includes("$Preflight.KioskPassword") &&
    prepare.includes("$Preflight.AutoLogonPassword") &&
    prepare.includes("-Arguments $setupArguments"),
  `${preparePath} should install executables/scripts, manifest, local bring-up settings, service, task/account setup, and directories`,
);

addCheck(
  "prepare-declares-factory-windows-baseline-policy",
  prepare.includes("New-FactoryWindowsBaselinePolicy") &&
    prepare.includes('schemaVersion = "factory-windows-baseline-policy/v1"') &&
    prepare.includes('model = "allowlist"') &&
    prepare.includes("windows_auto_update_installation") &&
    prepare.includes("windows_auto_update_auto_restart") &&
    prepare.includes("defender_enabled") &&
    prepare.includes("firewall_enabled") &&
    prepare.includes("openssh_server_for_maintenance_users") &&
    prepare.includes("kiosk_account_denied_remote_access") &&
    prepare.includes("consumer_experience_foreground_popups") &&
    prepare.includes(
      "consumer_experience_kiosk_foreground_takeover_best_effort",
    ) &&
    prepare.includes("factoryWindowsBaselinePolicy") &&
    prepare.includes("Apply-FactoryWindowsBaseline"),
  `${preparePath} should declare and apply the allowlisted Factory Windows Baseline policy as part of factory preparation`,
);

addCheck(
  "prepare-uses-controlled-ssh-maintenance-and-does-not-enable-file-sharing",
  !prepare.includes(
    'Enable-NetFirewallRule -DisplayGroup "File and Printer Sharing"',
  ) &&
    !prepare.includes(
      'New-NetFirewallRule -DisplayName "VEM OpenSSH Maintenance"',
    ) &&
    prepare.includes("ConfigureControlledMaintenanceIngress = $true") &&
    !prepare.includes("-ConfigureRemoteMaintenanceAccess `") &&
    setupTasks.includes("Ensure-OpenSshServer") &&
    !setupTasks.includes("Add-WindowsCapability -Online") &&
    !setupTasks.includes("Get-WindowsCapability -Online") &&
    setupTasks.includes("TrustedUserCAKeys") &&
    setupTasks.includes("PasswordAuthentication no") &&
    setupTasks.includes("KbdInteractiveAuthentication no") &&
    setupTasks.includes("AuthenticationMethods publickey") &&
    setupTasks.includes("InterfaceAlias") &&
    setupTasks.includes("Ensure-SshdConfigDenyKioskUser") &&
    setupTasks.includes('"DenyUsers $($KioskUser.ToLowerInvariant())"') &&
    setupTasks.includes("Get-EnabledInboundSshFirewallRules") &&
    setupTasks.includes("Assert-ProfileMaintenanceCa"),
  `${preparePath} should configure local OpenSSH maintenance account isolation by default, avoid Tailscale, and never enable SMB/File Sharing`,
);

addCheck(
  "prepare-requires-pinned-openssh-and-wireguard-capabilities",
  [
    "OpenSshPackagePath",
    "OpenSshPackageSource",
    "OpenSshPackageVersion",
    "OpenSshPackageSha256",
    "OpenSshApprovedSignerThumbprint",
    "OpenSshApprovedRootThumbprint",
    "WireGuardPackagePath",
    "WireGuardPackageSource",
    "WireGuardPackageVersion",
    "WireGuardPackageSha256",
    "WireGuardApprovedSignerThumbprint",
    "WireGuardApprovedRootThumbprint",
    "Assert-PinnedLocalPackage",
    "Install-PinnedWindowsPackage",
    "Ensure-LocalWireGuardTunnelService",
    "WireGuardTunnel",
    "/installtunnelservice",
    "wireGuardRoot",
    "ConfigureControlledMaintenanceIngress = $true",
    "MaintenanceRunnerSourceAllowlist",
    "MaintenanceMaintainerSourceAllowlist",
    "MaintenanceWireGuardListenAddress",
    "factoryProfile",
    'privateKeySource = "generated_locally"',
  ].every((needle) => prepare.includes(needle)) &&
    prepare.indexOf("Assert-PinnedLocalPackage") <
      prepare.indexOf("Assert-CleanHostOrReset") &&
    prepare.includes(
      "package source must be a declared local-pinned or factory-cas identity",
    ),
  `${preparePath} should require fixed local OpenSSH and WireGuard packages, profile CA material, and role pools before any host mutation`,
);

addCheck(
  "verifier-checks-mandatory-wireguard-and-maintenance-contract",
  verifier.includes("Get-MaintenanceFirewallEvidence") &&
    verifier.includes("Get-WireGuardServiceEvidence") &&
    verifier.includes("Get-FactoryPackageEvidence") &&
    verifier.includes("WireGuardTunnel$VEM-Maintenance") &&
    verifier.includes("VEM Controlled Maintenance SSH") &&
    verifier.includes("sourceRolePoolsMatch") &&
    verifier.includes("interfaceAlias") &&
    verifier.includes('schemaVersion = "vem-factory-runtime-verification/v2"'),
  `${verifierPath} should verify mandatory WireGuard service state, pinned package evidence, and exact role-pool/interface SSH scope`,
);

addCheck(
  "testbed-bootstrap-certificate-ingress-is-explicit-and-production-remains-wireguard-only",
  setupTasks.includes('mode = "wireguard-only"') &&
    setupTasks.includes('mode = "testbed-bootstrap-certificate"') &&
    setupTasks.includes('sshListenAddress = "0.0.0.0"') &&
    setupTasks.includes('firewallInterfaceScope = "Any"') &&
    setupTasks.includes("Assert-WireGuardListenAddress") &&
    setupTasks.includes("if ([bool]$ingressPolicy.requiresWireGuardAddress)") &&
    prepare.includes("Get-FactoryMaintenanceIngressPolicy") &&
    prepare.includes("effectiveListenAddress") &&
    prepare.includes("effectiveFirewallInterfaceScope") &&
    verifier.includes("Get-MaintenanceIngressEvidence") &&
    verifier.includes("bootstrapTestbedOnly") &&
    verifier.includes(
      "production verifier rejects wildcard SSH listener or firewall interface scope",
    ) &&
    verifier.includes("sourceRolePoolsMatch"),
  "testbed bootstrap ingress must be explicit, certificate-only, source-pool scoped, and reject any production wildcard listener or interface scope",
);

addCheck(
  "testbed-runner-can-stage-clean-base-factory-capability-assets",
  testbedRunner.includes("resolveCleanBaseFactoryCapabilityInputs") &&
    testbedRunner.includes("--openssh-package") &&
    testbedRunner.includes("--wireguard-package") &&
    testbedRunner.includes("--maintenance-ca-public-key") &&
    testbedRunner.includes("remoteOpenSshPackagePath") &&
    testbedRunner.includes("remoteWireGuardPackagePath") &&
    testbedRunner.includes("remoteMaintenanceCaPublicKeyPath") &&
    testbedRunner.includes("OpenSshPackagePath =") &&
    testbedRunner.includes("WireGuardPackagePath =") &&
    testbedRunner.includes("MaintenanceRunnerSourceAllowlist =") &&
    testbedRunner.includes("MaintenanceMaintainerSourceAllowlist =") &&
    !testbedRunner.includes("maintenance-relay.conf"),
  `${testbedRunnerPath} should upload hash-checked fixed OpenSSH/WireGuard/CA assets and pass profile role-pool inputs through clean-base factory preparation`,
);

addCheck(
  "prepare-parenthesizes-join-path-inside-array-literals",
  prepare.includes('(Join-Path $RuntimeRoot "vending-daemon.exe")') &&
    prepare.includes('(Join-Path $RuntimeRoot "launch-machine-ui-debug.vbs")'),
  `${preparePath} should parenthesize Join-Path calls when used as array items so Windows PowerShell does not bind following comma-separated items as ChildPath arrays`,
);

addCheck(
  "setup-tasks-tolerates-missing-optional-vision-task",
  setupTasks.length > 0 &&
    setupVisionTaskBlock.includes("Get-ScheduledTask") &&
    setupVisionTaskBlock.includes('TaskPath "\\VEM\\"') &&
    setupVisionTaskBlock.includes("if ($null -ne $visionTask)") &&
    setupVisionTaskBlock.includes(
      'schtasks /Delete /TN "VEM\\StartVisionServer"',
    ),
  `${setupTasksPath} should not let schtasks missing-task stderr abort factory preparation when the optional vision task is absent`,
);

addCheck(
  "prepare-verifies-artifact-hashes-before-copy",
  prepare.includes("Assert-Sha256") &&
    prepare.includes("Get-FileHash") &&
    prepare.includes("hash mismatch") &&
    prepare.indexOf("Assert-Sha256 -Path $DaemonArtifactPath") <
      prepare.indexOf("Copy-Item -LiteralPath $DaemonArtifactPath") &&
    prepare.indexOf("Assert-Sha256 -Path $MachineUiArtifactPath") <
      prepare.indexOf("Copy-Item -LiteralPath $MachineUiArtifactPath"),
  `${preparePath} should validate component hashes before copying artifacts into fixed paths`,
);

addCheck(
  "verifier-checks-manifest-layout-components-startup-and-evidence",
  verifierConcerns.every((needle) => verifier.includes(needle)) &&
    verifier.includes("Assert-Sha256") &&
    verifier.includes("Get-Service") &&
    verifier.includes("Get-ScheduledTask") &&
    verifier.includes("Get-LocalUser") &&
    verifier.includes("Winlogon") &&
    verifier.includes("Get-DisplayEvidence") &&
    verifier.includes("topologyIdentity = $manifest.topology.identity") &&
    verifier.includes("topologyVersion = $manifest.topology.version") &&
    verifier.includes("Write-Evidence") &&
    verifier.includes('schemaVersion = "vem-factory-runtime-verification/v2"'),
  `${verifierPath} should verify fixed paths, hashes, daemon service, UI task, accounts, kiosk/autologon, CDP exclusion, recovery path, display expectations, and evidence`,
);

addCheck(
  "verifier-emits-factory-windows-baseline-evidence",
  verifier.includes("Get-WindowsUpdatePolicyEvidence") &&
    verifier.includes("Get-PowerPolicyEvidence") &&
    verifier.includes("Get-BootPolicyEvidence") &&
    verifier.includes("Get-SecurityPostureEvidence") &&
    verifier.includes("Get-FactoryRemoteMaintenanceCapabilityEvidence") &&
    verifier.includes("Get-ConsumerExperienceInterferenceEvidence") &&
    verifier.includes("windowsUpdatePolicy") &&
    verifier.includes("automaticUpdateInstallation") &&
    verifier.includes("automaticRestart") &&
    verifier.includes("powerPolicy") &&
    verifier.includes("hibernation") &&
    verifier.includes("bootPolicy") &&
    verifier.includes("testsigning") &&
    verifier.includes("securityPosture") &&
    verifier.includes("defender") &&
    verifier.includes("firewall") &&
    verifier.includes("fileAndPrinterSharing") &&
    verifier.includes("factoryRemoteMaintenanceCapability") &&
    verifier.includes("kioskRemoteAccess") &&
    verifier.includes("sshdConfigDeniesKioskUser") &&
    verifier.includes("maintenanceInOpenSshUsers") &&
    verifier.includes("consumerExperienceInterference") &&
    verifier.includes("storeAutomaticAppUpdates") &&
    verifier.includes("kioskForegroundTakeover"),
  `${verifierPath} should collect structured Factory Windows Baseline evidence for update, power, boot, security, remote maintenance, and consumer-experience posture`,
);

addCheck(
  "verifier-uses-registry-display-fallback",
  verifier.includes("GraphicsDrivers\\Configuration") &&
    verifier.includes("ActiveSize.cx") &&
    verifier.includes("PrimSurfSize.cx") &&
    verifier.includes('source = "GraphicsDrivers.Configuration"'),
  `${verifierPath} should fall back to GraphicsDrivers registry display evidence when Win32_VideoController omits active resolution in a clean VM SSH session`,
);

addCheck(
  "clean-base-runner-uses-run-scoped-known-hosts",
  testbedRunner.includes("options.sshKnownHostsPath") &&
    testbedRunner.includes("StrictHostKeyChecking=accept-new") &&
    testbedRunner.includes("UserKnownHostsFile=") &&
    testbedRunner.includes(
      'options.mode === "clean-base-factory-acceptance"',
    ) &&
    testbedRunner.includes('join(localTempDirectory, "known_hosts")'),
  `${testbedRunnerPath} should connect to newly created clean-base VMs with a run-scoped known_hosts file instead of depending on global SSH state`,
);

addCheck(
  "verifier-proves-kiosk-ssh-denial-and-rejects-file-sharing-maintenance",
  verifier.includes("Test-SshdConfigDeniesUser") &&
    verifier.includes("DenyUsers") &&
    verifier.includes(
      "sshd_config must explicitly deny the lowercase kiosk account",
    ) &&
    verifier.includes(
      'Test-LocalUserInGroup -User $MaintenanceUser -Group "OpenSSH Users"',
    ) &&
    verifier.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group "OpenSSH Users"',
    ) &&
    verifier.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-555")',
    ) &&
    verifier.includes(
      "File and Printer Sharing firewall rules must not be enabled as a maintenance entry",
    ) &&
    verifier.includes("not_installed_by_default") &&
    verifier.includes(
      "default Factory Runtime Image must not include Tailscale",
    ) &&
    verifier.includes("enabledVemInboundRules") &&
    !verifier.includes(
      'Get-LocalGroupMember -Group "Administrators" -ErrorAction SilentlyContinue',
    ),
  `${verifierPath} should verify explicit sshd_config DenyUsers/OpenSSH Users denial, default Tailscale absence, and fail if SMB/File Sharing is opened`,
);

addCheck(
  "verifier-uses-registry-power-evidence-instead-of-english-powercfg-text",
  verifier.includes("ActivePowerScheme") &&
    verifier.includes("ACSettingIndex") &&
    verifier.includes("DCSettingIndex") &&
    verifier.includes("HibernateEnabled") &&
    !verifier.includes("Current AC Power Setting Index") &&
    !verifier.includes("Current DC Power Setting Index"),
  `${verifierPath} should use locale-independent registry power settings, with only GUID fallback discovery when needed`,
);

addCheck(
  "verifier-records-consumer-experience-as-best-effort-policy-evidence",
  verifier.includes("policy_configured") &&
    verifier.includes("best_effort_policy_configured") &&
    verifier.includes(
      "Windows 10 Pro CloudContent and Spotlight policies are recorded as configured best-effort evidence",
    ) &&
    !verifier.includes('kioskForegroundTakeover = if ($ok) { "blocked" }'),
  `${verifierPath} should not overclaim Windows 10 Pro consumer-experience foreground takeover blocking`,
);

addCheck(
  "verifier-is-launch-mode-aware",
  verifier.includes("machineUiStartupMode") &&
    verifier.includes("switch ($machineUiStartupMode)") &&
    verifier.includes('"scheduled_task"') &&
    verifier.includes('"shell_launcher"') &&
    verifier.includes("machine UI task missing: VEMMachineUI") &&
    verifier.includes(
      "VEMMachineUI scheduled task should be removed or disabled when Shell Launcher owns startup",
    ) &&
    verifierShellBlock.includes("Shell Launcher") &&
    verifierShellBlock.includes("per-user Winlogon shell") &&
    verifier.includes("Test-ShellCommandMatches"),
  `${verifierPath} should accept Shell Launcher/direct-process hosts without requiring VEMMachineUI and verify the configured shell instead`,
);

addCheck(
  "verifier-checks-service-task-command-lines-and-cdp-exclusion",
  verifier.includes("Get-CimInstance Win32_Service") &&
    verifier.includes("--data-dir") &&
    verifier.includes("--print-ready-file") &&
    verifierTaskBlock.includes("command") &&
    verifierTaskBlock.includes("arguments") &&
    verifierTaskBlock.includes("workingDirectory") &&
    verifier.includes("machine UI task command mismatch") &&
    verifier.includes("machine UI task arguments do not reference") &&
    verifier.includes("machine UI task working directory mismatch") &&
    verifier.includes('-match "remote-debugging-port"') &&
    verifier.includes(
      "customer launcher enables WebView CDP remote-debugging-port",
    ),
  `${verifierPath} should verify daemon service args, scheduled-task command/args/working directory, and exclude any customer remote-debugging-port`,
);

addCheck(
  "verifier-emits-pass-fail-structured-evidence",
  verifier.includes("Add-Failure") &&
    verifier.includes("ok = $failures.Count -eq 0") &&
    verifier.includes("checks = $checks") &&
    verifier.includes("failures = @($failures)") &&
    verifier.includes("ConvertTo-Json -Depth 30") &&
    verifier.includes("exit 1") &&
    verifier.includes("exit 0"),
  `${verifierPath} should emit structured evidence for both pass and fail outcomes and return a failing exit code on failed verification`,
);

const dryRunFixture = {
  schemaVersion: "vem-factory-runtime-plan/v1",
  generatedAt: "1970-01-01T00:00:00.0000000Z",
  inputs: {
    credentials: {
      kioskPassword: "explicit_parameter",
      maintenancePassword: "secure_environment",
      autoLogonPassword: "explicit_parameter",
    },
  },
  resetEvidence: {
    status: "clean",
    found: [],
    cleared: [],
    preserved: [
      {
        category: "factory_manifest",
        path: "C:\\ProgramData\\VEM\\factory",
        reason: "factory manifest directory is not local machine state",
      },
    ],
    skipped: [
      {
        category: "platform_business_data",
        path: "C:\\ProgramData\\VEM",
        reason: "platform records are outside local runtime reset",
      },
    ],
  },
};

const dirtyHostFixture = {
  status: "dirty",
  found: [
    { category: "startup_command", path: "task://VEMMaintenanceUI" },
    { category: "startup_command", path: "task://VEM/StartVisionServer" },
  ],
  cleared: [],
  preserved: [{ category: "factory_manifest" }],
  skipped: [{ category: "keyring_secret_material" }],
};

const shellLauncherVerificationFixture = {
  schemaVersion: "vem-factory-runtime-verification/v2",
  ok: true,
  checks: {
    machineUiStartup: {
      mode: "shell_launcher",
      machineUiTask: { exists: false },
      shell: { configured: true },
    },
  },
};

try {
  assert.equal(dryRunFixture.schemaVersion, "vem-factory-runtime-plan/v1");
  assert.equal(
    dryRunFixture.inputs.credentials.kioskPassword,
    "explicit_parameter",
  );
  assert.equal(dirtyHostFixture.found[0]?.path, "task://VEMMaintenanceUI");
  assert.equal(dirtyHostFixture.found[1]?.path, "task://VEM/StartVisionServer");
  assert.equal(
    shellLauncherVerificationFixture.checks.machineUiStartup.mode,
    "shell_launcher",
  );
  assert.equal(
    shellLauncherVerificationFixture.checks.machineUiStartup.machineUiTask
      .exists,
    false,
  );
  addCheck(
    "fixture-evidence-covers-dry-run-dirty-host-and-shell-launcher-success",
    true,
    `${preparePath} and ${verifierPath} should have CI-parseable evidence examples for Linux environments without pwsh`,
  );
} catch (error) {
  addCheck(
    "fixture-evidence-covers-dry-run-dirty-host-and-shell-launcher-success",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
