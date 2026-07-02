import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const scriptPath = "scripts/windows/apply-managed-update.ps1";
const runbookPath = "public/managed-machine-update.md";

const script = readText(scriptPath);
const runbook = readText(runbookPath);

function functionBlock(source, name) {
  const match = new RegExp(`function\\s+${name}\\b[\\s\\S]*?\\n\\}`, "m").exec(
    source,
  );
  return match?.[0] ?? "";
}

const daemonBlock = functionBlock(script, "Restart-DaemonComponent");
const uiBlock = functionBlock(script, "Restart-UiComponent");
const rollbackBlock = functionBlock(script, "Restore-ComponentBackup");
const convertBlock = functionBlock(script, "ConvertTo-ComponentSpec");
const componentsBlock = functionBlock(script, "Get-RequestedComponents");
const daemonHealthBlock = functionBlock(script, "Test-DaemonHealth");
const uiHealthBlock = functionBlock(script, "Test-UiHealth");
const stopBlock = functionBlock(script, "Stop-ComponentForReplace");

addCheck(
  "script-exists",
  script.length > 0,
  `${scriptPath} should provide the Windows managed update entrypoint`,
);

addCheck(
  "accepts-manifest-and-direct-input",
  script.includes("[string]$ManifestPath") &&
    script.includes("[string]$Component") &&
    script.includes("[string]$ArtifactPath") &&
    script.includes("[string]$Sha256") &&
    script.includes("[string]$TargetPath"),
  `${scriptPath} should accept either a manifest file or direct single-component parameters`,
);

addCheck(
  "supports-daemon-and-ui-components",
  script.includes('ValidateSet("daemon", "ui")') &&
    script.includes("VemVendingDaemon") &&
    script.includes("VEMMachineUI") &&
    script.includes("machine.exe") &&
    script.includes("vending-daemon.exe"),
  `${scriptPath} should cover both daemon and machine UI artifacts`,
);

addCheck(
  "verifies-artifact-hash-before-install",
  script.includes("Get-FileHash") &&
    script.includes("Assert-Sha256") &&
    script.includes("hash mismatch") &&
    script.indexOf("Assert-Sha256") < script.indexOf("Install-Component"),
  `${scriptPath} should verify SHA256 before replacing the active executable`,
);

addCheck(
  "backs-up-active-exe-before-replace",
  script.includes("New-BackupPath") &&
    script.includes("Copy-Item") &&
    script.includes("backupPath") &&
    script.indexOf("Copy-Item -LiteralPath $Spec.targetPath") <
      script.indexOf("Stop-ComponentForReplace -Component $Spec.component") &&
    script.indexOf("Stop-ComponentForReplace -Component $Spec.component") <
      script.indexOf("Copy-Item -LiteralPath $Spec.artifactPath"),
  `${scriptPath} should back up the active executable before replacement`,
);

addCheck(
  "binds-components-to-allowed-target-paths",
  script.includes("Get-DefaultTargetPath") &&
    script.includes('"C:\\VEM\\bringup\\vending-daemon.exe"') &&
    script.includes('"C:\\VEM\\bringup\\machine.exe"') &&
    convertBlock.includes("Assert-AllowedTargetPath") &&
    convertBlock.includes("targetPath") &&
    script.includes(
      "targetPath for daemon must be C:\\VEM\\bringup\\vending-daemon.exe",
    ) &&
    script.includes("targetPath for ui must be C:\\VEM\\bringup\\machine.exe"),
  `${scriptPath} should reject manifest/direct inputs that bind a component to the wrong production executable`,
);

addCheck(
  "rejects-empty-components-array",
  componentsBlock.includes("@($manifest.components).Count -eq 0") &&
    componentsBlock.includes("manifest components array must not be empty"),
  `${scriptPath} should fail an empty manifest components array before writing misleading evidence`,
);

addCheck(
  "daemon-update-does-not-stop-ui",
  daemonBlock.includes("Restart-Service") &&
    !daemonBlock.includes("Stop-ScheduledTask") &&
    !daemonBlock.includes("Stop-Process"),
  `${scriptPath} daemon updates should restart only VemVendingDaemon`,
);

addCheck(
  "ui-update-does-not-stop-daemon",
  uiBlock.includes("Stop-ScheduledTask") &&
    uiBlock.includes("Start-ScheduledTask") &&
    uiBlock.includes("Stop-Process") &&
    !uiBlock.includes("Stop-Service") &&
    !uiBlock.includes("Restart-Service"),
  `${scriptPath} UI updates should restart only VEMMachineUI/machine.exe`,
);

addCheck(
  "stop-for-replace-is-component-isolated",
  stopBlock.includes('$Component -eq "daemon"') &&
    stopBlock.includes("Stop-Service") &&
    stopBlock.includes("Get-ExactMachineProcess") &&
    !stopBlock.includes("Restart-Service") &&
    !stopBlock.includes("Start-ScheduledTask"),
  `${scriptPath} should isolate stop-for-replace to the selected component and stop only exact machine.exe targets for UI`,
);

addCheck(
  "health-checks-daemon-and-ui",
  script.includes("Test-DaemonHealth") &&
    script.includes("daemon-ready.json") &&
    script.includes("healthzUrl") &&
    script.includes("Test-UiHealth") &&
    script.includes("Get-Process"),
  `${scriptPath} should perform post-update health checks for daemon and UI`,
);

addCheck(
  "daemon-health-checks-healthz-and-readyz-from-ready-file",
  daemonHealthBlock.includes("Read-JsonFile -Path $ReadyFile") &&
    daemonHealthBlock.includes("healthzUrl") &&
    daemonHealthBlock.includes("readyzUrl") &&
    daemonHealthBlock.includes("healthzOk") &&
    daemonHealthBlock.includes("readyzOk") &&
    daemonHealthBlock.includes("blockingCodes") &&
    daemonHealthBlock.includes("mode") &&
    daemonHealthBlock.includes("status") &&
    !daemonHealthBlock.includes("canSell"),
  `${scriptPath} daemon health evidence should prove ready-file healthz and readyz HTTP success without requiring hardware canSell=true`,
);

addCheck(
  "ui-health-verifies-target-hash-and-launch-mode",
  uiHealthBlock.includes("ExpectedSha256") &&
    uiHealthBlock.includes(
      "Assert-Sha256 -Path $TargetPath -ExpectedSha256 $ExpectedSha256",
    ) &&
    uiHealthBlock.includes("Get-ExactMachineProcess") &&
    uiHealthBlock.includes("launchMode") &&
    !uiHealthBlock.includes("[string]::IsNullOrWhiteSpace($_.Path)"),
  `${scriptPath} UI health should verify target hash, launch mode, and an exact target-path process instead of accepting anonymous machine.exe`,
);

addCheck(
  "ui-restart-supports-task-and-direct-fallback",
  script.includes('ValidateSet("auto", "scheduledTask", "directProcess")') &&
    uiBlock.includes("Resolve-UiLaunchMode") &&
    uiBlock.includes("Start-ScheduledTask") &&
    uiBlock.includes("Start-Process") &&
    uiBlock.includes("launchMode"),
  `${scriptPath} UI restart and rollback should support VEMMachineUI scheduled task hosts and Shell Launcher/direct-process hosts`,
);

addCheck(
  "rolls-back-on-health-failure",
  script.includes("try {") &&
    script.includes("catch {") &&
    script.includes("Restore-ComponentBackup") &&
    rollbackBlock.includes("Restart-Component") &&
    rollbackBlock.includes("Copy-Item"),
  `${scriptPath} should restore the backup and restart the component if install or health checks fail`,
);

addCheck(
  "writes-evidence-json",
  script.includes("[string]$EvidencePath") &&
    script.includes("ConvertTo-Json -Depth") &&
    script.includes("Write-Evidence") &&
    script.includes("$manifestForEvidence.updateId") &&
    script.includes("updateId") &&
    script.includes("rollbackAttempted") &&
    script.includes("healthCheck"),
  `${scriptPath} should emit production-verifiable evidence JSON including manifest updateId`,
);

addCheck(
  "runbook-documents-local-managed-update",
  runbook.includes("托管机器更新") &&
    runbook.includes("清单") &&
    runbook.includes("updateId") &&
    runbook.includes("C:\\VEM\\bringup\\vending-daemon.exe") &&
    runbook.includes("C:\\VEM\\bringup\\machine.exe") &&
    runbook.includes("healthz") &&
    runbook.includes("readyz") &&
    runbook.includes("launchMode") &&
    runbook.includes("sha256") &&
    runbook.includes("证据") &&
    runbook.includes("紧急"),
  `${runbookPath} should document local managed update usage and keep SSH as emergency access`,
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
