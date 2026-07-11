import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const setupPath = "scripts/windows/setup-scheduled-tasks.ps1";
const installerPath = "scripts/windows/install-vision-release.ps1";
const verifyPath = "scripts/windows/verify-vem-runtime.ps1";
const runbookPath = "public/managed-machine-update.md";

const setup = readText(setupPath);
const installer = readText(installerPath);
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
  "vision-installer-requires-immutable-release-contract",
  installer.includes("DescriptorPath") &&
    installer.includes("AttestationPath") &&
    installer.includes("SbomPath") &&
    installer.includes("ConformanceEvidencePath") &&
    installer.includes("TrustPolicyPath") &&
    installer.includes("EvidenceVerifierPath") &&
    installer.includes("ApprovalPath") &&
    installer.includes("FactoryManifestPath") &&
    installer.includes("Invoke-ReleaseEvidenceVerifier") &&
    installer.includes("approved identity") &&
    installer.includes("C:\\VEM\\vision") &&
    installer.includes("C:\\ProgramData\\VEM\\vision"),
  `${installerPath} should select only a fully approved immutable Vision release`,
);

addCheck(
  "vision-installer-uses-interactive-task-health-rollback-and-redaction",
  installer.includes("StartVisionServer") &&
    installer.includes("Test-VisionProtocol") &&
    installer.includes("ClientWebSocket") &&
    installer.includes("Stop-RecordedVision") &&
    installer.includes("Sanitize") &&
    !installer.match(/PyInstaller|\bpython(?:\.exe)?\b/i) &&
    !verify.match(/python(?:\.exe)?|pythonw(?:\.exe)?/i) &&
    verify.includes("VisionActiveProcessFile") &&
    verify.includes("activeProcessDigest"),
  `${installerPath} should stay implementation-independent and use the existing interactive task`,
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
  "runbook-documents-approved-vision-release",
  runbook.includes("Vision Release Bundle") &&
    runbook.includes("C:\\VEM\\vision") &&
    runbook.includes("C:\\VEM\\bringup\\start_vision.bat") &&
    runbook.includes("install-vision-release.ps1") &&
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
