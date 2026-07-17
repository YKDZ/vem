import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const setupPath = "scripts/windows/setup-scheduled-tasks.ps1";
const installerPath = "scripts/windows/install-vision-main-artifact.ps1";
const visionModulePath = "scripts/windows/vision-main-artifacts.psm1";
const verifyPath = "scripts/windows/verify-vem-runtime.ps1";
const runbookPath = "public/managed-machine-update.md";

const setup = readText(setupPath);
const installer = readText(installerPath);
const visionModule = readText(visionModulePath);
const verify = readText(verifyPath);
const runbook = readText(runbookPath);

addCheck(
  "setup-defaults-to-managed-vision-paths",
  setup.includes('$VisionLauncher = "C:\\VEM\\bringup\\start_vision.bat"') &&
    setup.includes('$VisionWorkingDirectory = "C:\\VEM\\vision\\app"') &&
    setup.includes("VEM\\StartVisionServer"),
  `${setupPath} should register the vision task against the managed artifact path`,
);

addCheck(
  "vision-installer-consumes-main-artifact-directly",
  installer.includes("RuntimeArchive") &&
    installer.includes("SiteConfigurationPath") &&
    installer.includes("C:\\VEM\\vision\\app") &&
    installer.includes("C:\\ProgramData\\VEM\\vision\\site.json") &&
    !installer.match(/DescriptorPath|AttestationPath|SbomPath|ApprovalPath|FactoryManifestPath|rollback/i),
  `${installerPath} should replace the fixed app from one main artifact without release governance`,
);

addCheck(
  "vision-installer-uses-interactive-task-health-and-protocol-probe",
  installer.includes("Install-VisionMainArtifact") &&
    visionModule.includes("Start-VisionMainTask") &&
    visionModule.includes("Invoke-VisionMainProbe") &&
    visionModule.includes("ClientWebSocket") &&
    !visionModule.match(/PyInstaller|\bpython(?:\.exe)?\b/i) &&
    !verify.match(/python(?:\.exe)?|pythonw(?:\.exe)?/i) &&
    verify.includes("VisionInstallRecord") &&
    verify.includes("Invoke-VisionMainProbe"),
  `${installerPath} should use the existing interactive task and probe the direct install`,
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
  "runbook-documents-direct-vision-main-install",
  runbook.includes("get-vision-main-artifacts.ps1") &&
    runbook.includes("C:\\VEM\\vision") &&
    runbook.includes("C:\\VEM\\bringup\\start_vision.bat") &&
    runbook.includes("install-vision-main-artifact.ps1") &&
    runbook.includes("-RequireVisionOnline"),
  `${runbookPath} should document direct Vision main artifact deployment and verification`,
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
