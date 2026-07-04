import { existsSync, readFileSync } from "node:fs";

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

const normalLauncherBlock = functionBlock(setup, "Ensure-MachineUiLauncher");
const configureKioskShellBlock = functionBlock(setup, "Configure-KioskShell");
const startupBringupEvidenceBlock = functionBlock(
  setup,
  "Write-StartupBringupEvidence",
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
    setup.includes("Ensure-LocalAccount") &&
    setup.includes("VEMMaintenanceUI"),
  `${setupPath} should configure separate kiosk and maintenance account paths`,
);

addCheck(
  "setup-configures-controlled-remote-maintenance-access",
  setup.includes("[switch]$ConfigureRemoteMaintenanceAccess") &&
    setup.includes("Ensure-RemoteMaintenanceAccess") &&
    setup.includes("Assert-RemoteMaintenanceAccountSeparation") &&
    setup.includes(
      'Test-LocalUserInGroup -User $MaintenanceUser -Group "Administrators"',
    ) &&
    setup.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group "Administrators"',
    ) &&
    setup.includes("Ensure-TailscaleScopedSshFirewall") &&
    setup.includes("sshd") &&
    setup.includes("Tailscale") &&
    setup.includes("VEM Tailscale SSH") &&
    setup.includes("100.64.0.0/10") &&
    setup.includes("Disable-NetFirewallRule") &&
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
  `${setupPath} should enable a controlled SSH maintenance channel for the Maintenance Account and exclude the Kiosk Account`,
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
  machineUiTaskSection.includes("if (-not $ConfigureKioskShell)") &&
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
  "verifier-records-controlled-remote-maintenance-evidence",
  verifier.includes("[switch]$RemoteMaintenanceConfirmed") &&
    verifier.includes("[string]$NegativeKioskSshEvidence") &&
    verifier.includes("negativeKioskSshEvidence") &&
    verifier.includes('Get-ServiceStateOrNull -Name "sshd"') &&
    verifier.includes("Get-VemTailscaleSshFirewallState") &&
    verifier.includes("VEM Tailscale SSH") &&
    verifier.includes(
      'Test-LocalUserInGroup -User $MaintenanceUser -Group "OpenSSH Users"',
    ) &&
    verifier.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group "OpenSSH Users"',
    ) &&
    verifier.includes(
      'Test-LocalUserInGroup -User $KioskUser -Group "Remote Desktop Users"',
    ) &&
    verifier.includes("Test-SshdConfigDeniesUser") &&
    verifier.includes("$KioskUser.ToLowerInvariant()") &&
    verifier.includes("Get-TailscaleStatus") &&
    verifier.includes("remoteMaintenance"),
  `${verifierPath} should record SSH/Tailscale maintenance access evidence and fail without HITL remote login confirmation`,
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
  "public-runbook-documents-controlled-remote-maintenance-access",
  runbook.includes("受控远程维护访问") &&
    runbook.includes("-ConfigureRemoteMaintenanceAccess") &&
    runbook.includes("-EnableMaintenanceDebugTask") &&
    runbook.includes("-RemoteMaintenanceConfirmed") &&
    runbook.includes("-NegativeKioskSshEvidence") &&
    runbook.includes("Tailscale 支撑的受控 SSH") &&
    runbook.includes("VEM Tailscale SSH") &&
    runbook.includes("100.64.0.0/10") &&
    runbook.includes("自助机账号不得") &&
    runbook.includes("维护账号"),
  `${runbookPath} should document the controlled remote maintenance access setup and HITL acceptance`,
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
