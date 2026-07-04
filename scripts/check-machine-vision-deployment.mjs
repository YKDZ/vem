import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const setupPath = "scripts/windows/setup-scheduled-tasks.ps1";
const deployPath = "scripts/windows/deploy-windows-artifact.sh";
const verifyPath = "scripts/windows/verify-vem-runtime.ps1";
const runbookPath = "public/managed-machine-update.md";

const setup = readText(setupPath);
const deploy = readText(deployPath);
const verify = readText(verifyPath);
const runbook = readText(runbookPath);

addCheck(
  "setup-defaults-to-managed-vision-paths",
  setup.includes('$VisionLauncher = "C:\\VEM\\bringup\\start_vision.bat"') &&
    setup.includes('$VisionWorkingDirectory = "C:\\VEM\\vision"') &&
    setup.includes("VEM\\StartVisionServer"),
  `${setupPath} should register the vision task against the managed artifact path`,
);

addCheck(
  "deploy-script-supports-vision-kind",
  deploy.includes("--kind daemon|ui|vision") &&
    deploy.includes('"daemon" && "$kind" != "ui" && "$kind" != "vision"') &&
    deploy.includes("C:\\VEM\\vision") &&
    deploy.includes("C:\\VEM\\bringup\\start_vision.bat") &&
    deploy.includes(
      "vision artifact must contain start_vision.bat at its root",
    ),
  `${deployPath} should install a managed vision directory artifact and launcher`,
);

addCheck(
  "deploy-script-keeps-component-restarts-isolated",
  deploy.includes("Stop-Service VemVendingDaemon") &&
    deploy.includes("Stop-ScheduledTask -TaskName VEMMachineUI") &&
    deploy.includes("Stop-ScheduledTask -TaskName 'VEM\\StartVisionServer'") &&
    !deploy.includes(
      "Stop-Service VemVendingDaemon -Force\nStart-Sleep -Seconds 2\nCopy-Item $dst",
    ),
  `${deployPath} should restart only the selected daemon, UI, or vision component`,
);

addCheck(
  "verify-script-can-require-vision",
  verify.includes("[switch]$RequireVisionOnline") &&
    verify.includes("VEM\\StartVisionServer") &&
    verify.includes("C:\\VEM\\vision") &&
    verify.includes("vision task is not ready"),
  `${verifyPath} should expose an optional production vision deployment check`,
);

addCheck(
  "verify-script-can-require-production-startup-bringup",
  verify.includes("[switch]$RequireProductionBringup") &&
    verify.includes("StartupBringupEvidenceFile") &&
    verify.includes("startupBringup") &&
    verify.includes("productionBringup") &&
    verify.includes("daemonOwnedInitialization") &&
    verify.includes("autoLogon") &&
    verify.includes("VEMKiosk") &&
    verify.includes("Winlogon auto-logon target mismatch") &&
    verify.includes("production bring-up evidence not found"),
  `${verifyPath} should expose production bring-up startup evidence and optional failures for auto-logon/user mismatches`,
);

addCheck(
  "runbook-documents-vision-artifact",
  runbook.includes("视觉应用产物") &&
    runbook.includes("C:\\VEM\\vision") &&
    runbook.includes("C:\\VEM\\bringup\\start_vision.bat") &&
    runbook.includes("--kind vision") &&
    runbook.includes("-RequireVisionOnline"),
  `${runbookPath} should document vision deployment and verification`,
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
