import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const installerPath = "scripts/windows/install-vision-main-artifact.ps1";
const visionModulePath = "scripts/windows/vision-main-artifacts.psm1";
const verifyPath = "scripts/windows/verify-vem-runtime.ps1";

const installer = readText(installerPath);
const visionModule = readText(visionModulePath);
const verify = readText(verifyPath);

addCheck(
  "vision-installer-consumes-main-artifact-directly",
  installer.includes("RuntimeArchive") &&
    installer.includes("SiteConfigurationPath") &&
    installer.includes("C:\\VEM\\vision\\app") &&
    installer.includes("C:\\ProgramData\\VEM\\vision\\site.json"),
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

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
