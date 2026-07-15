import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const setupPath = "scripts/windows/setup-scheduled-tasks.ps1";
const verifierPath = "scripts/windows/verify-kiosk-lockdown.ps1";
const runbookPath = "public/customer-accessible-kiosk-lockdown.md";

const setup = readText(setupPath);
const verifier = readText(verifierPath);
const runbook = readText(runbookPath);

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

function sectionBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  if (start === -1) {
    return "";
  }
  const end = source.indexOf(endText, start + startText.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

function paramDefault(source, name) {
  const match = new RegExp(
    `\\[string\\]\\$${name}\\s*=\\s*(?<quote>["'])(?<value>.*?)\\k<quote>`,
  ).exec(source);
  return match?.groups?.value ?? null;
}

function containsCall(block, command, taskName) {
  return new RegExp(
    `${command}\\s+\`?[\\s\\S]*?-TaskName\\s+["']${taskName.replaceAll("\\", "\\\\")}["']`,
    "m",
  ).test(block);
}

function allTokensAfter(block, firstToken, laterTokens) {
  const firstIndex = block.indexOf(firstToken);
  return (
    firstIndex !== -1 &&
    laterTokens.every((token) => {
      const laterIndex = block.indexOf(token);
      return laterIndex !== -1 && laterIndex > firstIndex;
    })
  );
}

function normalizeMaintenanceIngressAllowlistForGuard(sourceAllowlist) {
  if (!Array.isArray(sourceAllowlist) || sourceAllowlist.length === 0) {
    throw new Error("missing explicit source allowlist");
  }

  const forbidden = new Set([
    "Any",
    "*",
    "Internet",
    "LocalSubnet",
    "DefaultGateway",
    "DHCP",
    "DNS",
    "WINS",
    "0.0.0.0",
    "::",
    "0.0.0.0/0",
    "::/0",
  ]);
  const normalized = new Set();

  for (const entry of sourceAllowlist) {
    for (const candidate of String(entry).split(",")) {
      const trimmed = candidate.trim();
      if (trimmed.length === 0) {
        throw new Error("empty source");
      }
      if (forbidden.has(trimmed)) {
        throw new Error(`broad source: ${trimmed}`);
      }

      const [address, prefix, unexpected] = trimmed.split("/");
      if (unexpected !== undefined || address.trim().length === 0) {
        throw new Error(`invalid source: ${trimmed}`);
      }

      const version = isIP(address.trim());
      if (version === 0) {
        throw new Error(`invalid source: ${trimmed}`);
      }
      if (prefix !== undefined) {
        const prefixLength = Number(prefix.trim());
        const requiredPrefix = version === 6 ? 128 : 32;
        if (
          !Number.isInteger(prefixLength) ||
          prefixLength !== requiredPrefix
        ) {
          throw new Error(`broad source: ${trimmed}`);
        }
      }

      normalized.add(address.trim().toLowerCase());
    }
  }

  if (normalized.size === 0) {
    throw new Error("missing explicit source allowlist");
  }

  return [...normalized];
}

function rejectsMaintenanceIngressSample(sourceAllowlist) {
  try {
    normalizeMaintenanceIngressAllowlistForGuard(sourceAllowlist);
    return false;
  } catch {
    return true;
  }
}

function acceptsMaintenanceIngressSample(sourceAllowlist) {
  try {
    normalizeMaintenanceIngressAllowlistForGuard(sourceAllowlist);
    return true;
  } catch {
    return false;
  }
}

function allowlistValidatorRejectsRequiredUnsafeSamples(block) {
  const forbiddenSamples = ['"Any"', '"0.0.0.0/0"', '"::/0"'];
  const unsafeSamples = [
    null,
    [""],
    ["Any"],
    ["0.0.0.0/0"],
    ["::/0"],
    ["100.64.0.0/10"],
    ["10.0.0.0/8"],
    ["192.168.0.0/16"],
  ];
  const safeHostSamples = [
    ["10.77.20.2"],
    ["10.77.20.2/32"],
    ["fd00:77:20::2"],
    ["fd00:77:20::2/128"],
  ];

  return (
    unsafeSamples.every(rejectsMaintenanceIngressSample) &&
    safeHostSamples.every(acceptsMaintenanceIngressSample) &&
    block.includes("$null -eq $SourceAllowlist") &&
    block.includes("@($SourceAllowlist).Count -eq 0") &&
    block.includes("[string]::IsNullOrWhiteSpace($trimmed)") &&
    forbiddenSamples.every((sample) => block.includes(sample)) &&
    block.includes("$requiredPrefix") &&
    block.includes("prefixLength -ne $requiredPrefix") &&
    block.includes("[System.Net.Sockets.AddressFamily]::InterNetworkV6") &&
    block.includes("$ip.IPAddressToString") &&
    block.includes("$validated.Contains($normalized)")
  );
}

const normalLauncherBlock = functionBlock(setup, "Ensure-MachineUiLauncher");
const configureKioskShellBlock = functionBlock(setup, "Configure-KioskShell");
const startupBringupEvidenceBlock = functionBlock(
  setup,
  "Write-StartupBringupEvidence",
);
const setupAllowlistValidatorBlock = functionBlock(
  setup,
  "Assert-ControlledMaintenanceIngressSourceAllowlist",
);
const setupControlledMaintenanceIngressBlock = functionBlock(
  setup,
  "Ensure-ControlledMaintenanceIngress",
);
const setupControlledMaintenanceFirewallBlock = functionBlock(
  setup,
  "Ensure-ControlledMaintenanceIngressFirewall",
);
const verifierAllowlistValidatorBlock = functionBlock(
  verifier,
  "Assert-ControlledMaintenanceIngressSourceAllowlist",
);
const verifierControlledMaintenanceFirewallBlock = functionBlock(
  verifier,
  "Get-ControlledMaintenanceIngressFirewallState",
);
const machineUiTaskSection = sectionBetween(
  setup,
  'Write-Host "[5/9] Configure VEMMachineUI kiosk logon task"',
  'Write-Host "[5b/9] Configure VEMMaintenanceUI debug task"',
);
const shellLauncherCimMethodLines = configureKioskShellBlock
  .split(/\r?\n/)
  .filter(
    (line) =>
      line.includes("Invoke-CimMethod") &&
      /-MethodName\s+Set(?:Enabled|CustomShell)/.test(line),
  );

addCheck(
  "normal-machine-ui-launcher-keeps-webview-cdp-disabled",
  normalLauncherBlock.includes("Ensure-MachineUiLauncher") &&
    !normalLauncherBlock.includes("remote-debugging-port") &&
    !normalLauncherBlock.includes("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"),
  `${setupPath} should not enable WebView CDP in the normal customer launch path`,
);

addCheck(
  "maintenance-debug-launcher-is-explicit",
  setup.includes("Ensure-MachineUiDebugLauncher") &&
    setup.includes("--remote-debugging-port=9222") &&
    setup.includes("MachineUiDebugLauncher"),
  `${setupPath} should keep CDP only in an explicit maintenance/debug launcher`,
);

addCheck(
  "default-provisioning-keeps-existing-admin-session",
  paramDefault(setup, "RunAsUser") === "Admin",
  `${setupPath} default -RunAsUser should stay Admin so .\\setup-scheduled-tasks.ps1 remains backwards compatible`,
);

addCheck(
  "kiosk-account-mode-is-explicit",
  setup.includes("[switch]$UseKioskAccount") &&
    setup.includes("$CustomerSessionUser") &&
    setup.includes("-UseKioskAccount"),
  `${setupPath} should require an explicit switch before binding customer logon tasks to the kiosk account`,
);

addCheck(
  "setup-configures-separate-kiosk-and-maintenance-accounts",
  setup.includes("$KioskUser") &&
    setup.includes("$MaintenanceUser") &&
    setup.includes("Ensure-KioskAccount") &&
    setup.includes("VEMMaintenanceUI"),
  `${setupPath} should configure separate kiosk and maintenance account paths`,
);

addCheck(
  "setup-configures-controlled-maintenance-ingress",
  setup.includes("[switch]$ConfigureControlledMaintenanceIngress") &&
    setup.includes("[string[]]$MaintenanceIngressSourceAllowlist") &&
    setup.includes("Assert-ControlledMaintenanceIngressSourceAllowlist") &&
    setup.includes("Ensure-ControlledMaintenanceIngress") &&
    setup.includes("Assert-RemoteMaintenanceAccountSeparation") &&
    setup.includes(
      'Test-LocalUserInGroup -User $MaintenanceUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544")',
    ) &&
    setup.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544")',
    ) &&
    setup.includes("Ensure-ControlledMaintenanceIngressFirewall") &&
    setup.includes("sshd") &&
    setup.includes("VEM Controlled Maintenance SSH") &&
    setup.includes("Reject-ControlledMaintenanceIngressMigration") &&
    setup.includes("ConfigureRemoteMaintenanceAccess has been removed") &&
    !setup.includes("Ensure-TailscaleScopedSshFirewall") &&
    setup.includes("Get-EnabledInboundSshFirewallRules") &&
    setup.includes("New-NetFirewallRule") &&
    setup.includes("OpenSSH Users") &&
    setup.includes("Ensure-SshdConfigDenyKioskUser") &&
    setup.includes('"DenyUsers $($KioskUser.ToLowerInvariant())"') &&
    setup.includes(
      'Add-LocalGroupMember -Group "OpenSSH Users" -Member $MaintenanceUser',
    ) &&
    setup.includes(
      'Remove-LocalGroupMember -Group "OpenSSH Users" -Member $KioskUser',
    ),
  `${setupPath} should enable transport-neutral Controlled Maintenance Ingress with an explicit SSH source allowlist and hard-fail the old Tailscale switch`,
);

addCheck(
  "setup-rejects-required-unsafe-controlled-maintenance-ingress-samples",
  setupAllowlistValidatorBlock.includes(
    'throw "Controlled Maintenance Ingress requires at least one explicit maintenance ingress source address."',
  ) &&
    setupAllowlistValidatorBlock.includes(
      'throw "Controlled Maintenance Ingress source address must not be empty."',
    ) &&
    setupAllowlistValidatorBlock.includes(
      'throw "Controlled Maintenance Ingress source address is too broad: $trimmed"',
    ) &&
    allowlistValidatorRejectsRequiredUnsafeSamples(
      setupAllowlistValidatorBlock,
    ),
  `${setupPath} should reject no allowlist, empty entries, Any, 0.0.0.0/0, ::/0, stale broad CGNAT/private CIDRs like 100.64.0.0/10, 10.0.0.0/8, and 192.168.0.0/16`,
);

addCheck(
  "verifier-rejects-required-unsafe-controlled-maintenance-ingress-samples",
  verifierAllowlistValidatorBlock.includes(
    'throw "Controlled Maintenance Ingress requires at least one explicit maintenance ingress source address."',
  ) &&
    verifierAllowlistValidatorBlock.includes(
      'throw "Controlled Maintenance Ingress source address must not be empty."',
    ) &&
    verifierAllowlistValidatorBlock.includes(
      'throw "Controlled Maintenance Ingress source address is too broad: $trimmed"',
    ) &&
    allowlistValidatorRejectsRequiredUnsafeSamples(
      verifierAllowlistValidatorBlock,
    ),
  `${verifierPath} should reject no allowlist, empty entries, Any, 0.0.0.0/0, ::/0, stale broad CGNAT/private CIDRs like 100.64.0.0/10, 10.0.0.0/8, and 192.168.0.0/16`,
);

addCheck(
  "setup-validates-maintenance-ingress-before-mutating-sshd-firewall-or-groups",
  allTokensAfter(
    setupControlledMaintenanceIngressBlock,
    "$validatedSources = Assert-ControlledMaintenanceIngressSourceAllowlist",
    [
      "Ensure-OpenSshServer",
      "Ensure-SshdConfigDenyKioskUser",
      "Ensure-ControlledMaintenanceIngressFirewall",
      "Ensure-LocalGroupExists",
      "Add-LocalGroupMember",
      "Remove-LocalGroupMember",
      "Start-Service",
    ],
  ) &&
    allTokensAfter(
      setupControlledMaintenanceFirewallBlock,
      "$validatedSources = Assert-ControlledMaintenanceIngressSourceAllowlist",
      [
        "Get-EnabledInboundSshFirewallRules | Remove-NetFirewallRule",
        "Remove-NetFirewallRule",
        "New-NetFirewallRule",
      ],
    ),
  `${setupPath} should validate Controlled Maintenance Ingress allowlist before any sshd, sshd_config, firewall, or group mutation`,
);

addCheck(
  "remote-maintenance-stale-switch-hard-fails",
  setup.includes("[switch]$ConfigureRemoteMaintenanceAccess") &&
    setup.includes("Reject-ControlledMaintenanceIngressMigration") &&
    setup.includes("if ($ConfigureRemoteMaintenanceAccess)") &&
    setup.includes("ConfigureRemoteMaintenanceAccess has been removed") &&
    !setup.includes("Ensure-RemoteMaintenanceAccess"),
  `${setupPath} should reject stale -ConfigureRemoteMaintenanceAccess commands instead of preserving a compatibility alias`,
);

addCheck(
  "maintenance-debug-task-is-explicit-and-default-removes-legacy-task",
  setup.includes("[switch]$EnableMaintenanceDebugTask") &&
    setup.includes("if ($EnableMaintenanceDebugTask)") &&
    setup.includes(
      'Remove-ScheduledTaskIfExists -TaskName "VEMMaintenanceUI"',
    ) &&
    setup.includes(
      "Maintenance debug UI task not enabled. Re-run with -EnableMaintenanceDebugTask",
    ),
  `${setupPath} should only register the VEMMaintenanceUI debug task behind an explicit switch and remove old default registrations`,
);

addCheck(
  "setup-applies-os-level-shell-lockdown",
  setup.includes("Configure-KioskShell") &&
    setup.includes("Shell Launcher") &&
    setup.includes(
      "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon",
    ) &&
    setup.includes("SetCustomShell"),
  `${setupPath} should apply an OS-level kiosk shell/gesture lockdown, not only fullscreen UI`,
);

addCheck(
  "kiosk-shell-does-not-write-global-restrictive-policies",
  !/HKLM:\\SOFTWARE\\Policies/i.test(configureKioskShellBlock) &&
    !/DisableCMD|NoWinKeys/i.test(configureKioskShellBlock),
  `${setupPath} should not set global HKLM restrictive policies from Configure-KioskShell`,
);

addCheck(
  "kiosk-shell-launches-machine-process-directly",
  setup.includes(
    "Configure-KioskShell -User $KioskUser -ShellPath $MachineUiExe",
  ) && setup.includes("$shellCommand = ('\"{0}\"' -f $ShellPath)"),
  `${setupPath} should let Shell Launcher monitor machine.exe directly instead of a wrapper that exits`,
);

addCheck(
  "kiosk-shell-and-machine-ui-task-are-mutually-exclusive",
  machineUiTaskSection.includes("if (-not $ShellLauncherOwnsStartup)") &&
    containsCall(
      machineUiTaskSection,
      "Register-InteractiveLogonTask",
      "VEMMachineUI",
    ) &&
    containsCall(
      machineUiTaskSection,
      "Remove-ScheduledTaskIfExists",
      "VEMMachineUI",
    ),
  `${setupPath} should not leave VEMMachineUI active when Shell Launcher owns the kiosk customer session`,
);

addCheck(
  "setup-writes-production-startup-bringup-evidence",
  startupBringupEvidenceBlock.includes("Write-StartupBringupEvidence") &&
    setup.includes("StartupBringupEvidenceFile") &&
    startupBringupEvidenceBlock.includes(
      'configuredBy = "scripts/windows/setup-scheduled-tasks.ps1"',
    ) &&
    startupBringupEvidenceBlock.includes("productionBringup = $true") &&
    startupBringupEvidenceBlock.includes(
      "daemonOwnedInitialization = $false",
    ) &&
    startupBringupEvidenceBlock.includes("autoLogon") &&
    startupBringupEvidenceBlock.includes("startupCommands") &&
    startupBringupEvidenceBlock.includes("DefaultUserName") &&
    startupBringupEvidenceBlock.includes("DefaultDomainName") &&
    !startupBringupEvidenceBlock.includes("DefaultPassword") &&
    !startupBringupEvidenceBlock.includes("AutoLogonPassword"),
  `${setupPath} should emit production bring-up startup evidence without writing auto-logon password values to evidence`,
);

addCheck(
  "shell-launcher-cim-return-values-are-checked",
  setup.includes("Assert-CimMethodSucceeded") &&
    configureKioskShellBlock.includes("SetEnabled") &&
    configureKioskShellBlock.includes("SetCustomShell") &&
    shellLauncherCimMethodLines.length === 2 &&
    shellLauncherCimMethodLines.every((line) => /^\s*\$\w+\s*=/.test(line)) &&
    shellLauncherCimMethodLines.every((line) => !line.includes("|")),
  `${setupPath} should fail when Shell Launcher CIM methods return non-zero HRESULTs`,
);

addCheck(
  "verifier-records-lockdown-evidence",
  verifier.includes("Test-NetConnection") &&
    verifier.includes("9222") &&
    verifier.includes("Shell Launcher") &&
    verifier.includes("manualTouchChecks") &&
    verifier.includes("ConvertTo-Json"),
  `${verifierPath} should record automated checks plus manual touch verification evidence`,
);

addCheck(
  "verifier-checks-expected-shell-and-task-principals",
  verifier.includes("$MachineUiExe") &&
    verifier.includes("$expectedShell") &&
    verifier.includes("expectedShell") &&
    verifier.includes("VEMMachineUI task still targets kiosk user") &&
    verifier.includes(
      "VEMMaintenanceUI task principal is not the maintenance user",
    ),
  `${verifierPath} should fail when the runtime shell or scheduled task principals do not match kiosk lockdown expectations`,
);

addCheck(
  "verifier-records-controlled-maintenance-ingress-evidence",
  verifier.includes("[string[]]$MaintenanceIngressSourceAllowlist") &&
    verifier.includes("[switch]$MaintenanceIngressConfirmed") &&
    verifier.includes("[string]$NegativeKioskSshEvidence") &&
    verifier.includes("negativeKioskSshEvidence") &&
    verifier.includes('Get-ServiceStateOrNull -Name "sshd"') &&
    verifier.includes("Get-ControlledMaintenanceIngressFirewallState") &&
    verifier.includes("VEM Controlled Maintenance SSH") &&
    verifier.includes("Assert-ControlledMaintenanceIngressSourceAllowlist") &&
    verifier.includes(
      'Test-LocalUserInGroup -User $MaintenanceUser -Group "OpenSSH Users"',
    ) &&
    verifier.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group "OpenSSH Users"',
    ) &&
    verifier.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-555")',
    ) &&
    verifier.includes("Test-SshdConfigDeniesUser") &&
    verifier.includes("$KioskUser.ToLowerInvariant()") &&
    verifier.includes("controlledMaintenanceIngress") &&
    !verifier.includes("Get-TailscaleStatus") &&
    !verifier.includes("VEM Tailscale SSH"),
  `${verifierPath} should record controlled maintenance ingress evidence and fail without explicit ingress confirmation`,
);

addCheck(
  "verifier-requires-exact-normalized-maintenance-ingress-firewall-addresses",
  verifierControlledMaintenanceFirewallBlock.includes(
    "$normalizedExpectedRemoteAddresses = Assert-ControlledMaintenanceIngressSourceAllowlist",
  ) &&
    verifierControlledMaintenanceFirewallBlock.includes(
      "$normalizedRemoteAddresses = Assert-ControlledMaintenanceIngressSourceAllowlist",
    ) &&
    verifierControlledMaintenanceFirewallBlock.includes(
      "$missingRemoteAddresses",
    ) &&
    verifierControlledMaintenanceFirewallBlock.includes(
      "$extraRemoteAddresses",
    ) &&
    verifierControlledMaintenanceFirewallBlock.includes(
      "$normalizedRemoteAddresses.Count -eq $normalizedExpectedRemoteAddresses.Count",
    ) &&
    verifierControlledMaintenanceFirewallBlock.includes(
      "$missingRemoteAddresses.Count -eq 0",
    ) &&
    verifierControlledMaintenanceFirewallBlock.includes(
      "$extraRemoteAddresses.Count -eq 0",
    ) &&
    verifierControlledMaintenanceFirewallBlock.includes(
      "normalizedRemoteAddress",
    ) &&
    verifierControlledMaintenanceFirewallBlock.includes("extraRemoteAddress"),
  `${verifierPath} should fail unless firewall RemoteAddress exactly equals the normalized explicit allowlist with no extra or broad sources`,
);

addCheck(
  "kiosk-verifier-proves-wireguard-scoped-certificate-only-ssh",
  verifier.includes("MaintenanceWireGuardInterfaceAlias") &&
    verifier.includes("MaintenanceWireGuardListenAddress") &&
    verifier.includes("Get-WireGuardListenAddressEvidence") &&
    verifier.includes("Get-ControlledMaintenanceIngressSshdState") &&
    verifier.includes("trustedusercakeys") &&
    verifier.includes("pubkeyauthentication") &&
    verifier.includes("passwordauthentication") &&
    verifier.includes("kbdinteractiveauthentication") &&
    verifier.includes("authorizedkeysfile") &&
    verifier.includes("wireGuardListenAddressEvidence") &&
    verifier.includes("sshdEffectiveConfig") &&
    verifier.includes("wireGuardInterfaceAlias") &&
    verifier.includes("wireGuardListenAddress"),
  `${verifierPath} should require a declared WireGuard listener/interface and record effective CA certificate-only sshd policy evidence`,
);

addCheck(
  "verifier-requires-default-maintenance-debug-task-disabled",
  verifier.includes("[switch]$MaintenanceDebugTaskExpected") &&
    verifier.includes(
      "unexpected VEMMaintenanceUI maintenance debug task is registered",
    ) &&
    verifier.includes(
      "VEMMaintenanceUI maintenance debug task is not registered",
    ) &&
    verifier.includes("MaintenanceDebugTaskExpected"),
  `${verifierPath} should treat VEMMaintenanceUI as disabled by default and only accept it when explicitly expected`,
);

addCheck(
  "public-runbook-documents-hitl-lockdown-verification",
  runbook.includes("顾客可接触自助机锁定") &&
    runbook.includes("自助机账号") &&
    runbook.includes("维护账号") &&
    runbook.includes("WebView CDP") &&
    runbook.includes("verify-kiosk-lockdown.ps1"),
  `${runbookPath} should document account setup, OS lockdown, CDP policy, and HITL checklist`,
);

addCheck(
  "public-runbook-documents-controlled-maintenance-ingress",
  runbook.includes("Controlled Maintenance Ingress") &&
    runbook.includes("受控维护入口") &&
    runbook.includes("-ConfigureControlledMaintenanceIngress") &&
    runbook.includes("-MaintenanceIngressSourceAllowlist") &&
    runbook.includes("-EnableMaintenanceDebugTask") &&
    runbook.includes("-MaintenanceIngressConfirmed") &&
    runbook.includes("-NegativeKioskSshEvidence") &&
    runbook.includes("VEM Controlled Maintenance SSH") &&
    runbook.includes("显式来源 allowlist") &&
    runbook.includes("自助机账号不得") &&
    runbook.includes("维护账号") &&
    !runbook.includes("-ConfigureRemoteMaintenanceAccess") &&
    !runbook.includes("VEM Tailscale SSH"),
  `${runbookPath} should document transport-neutral Controlled Maintenance Ingress setup and HITL acceptance`,
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
