import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function addCheck(checks, name, passed, detail) {
  checks.push({ name, passed, detail });
}

const FACTORY_BOOTSTRAP_CAPABILITY_PATH =
  "C:\\ProgramData\\VEM\\vending-daemon\\factory\\bootstrap-provisioning-capability";
const FACTORY_BOOTSTRAP_CAPABILITY_SUFFIX =
  "factory\\bootstrap-provisioning-capability";

/**
 * The bundle is assembled in GitHub Actions rather than stored as an archive.
 * This checker reads all three inputs to prove that its staged executables,
 * README, and smoke path keep one coherent protected-session contract.
 */
export function checkWindowsBringUpBundle({
  workflow,
  readme,
  smoke,
  factoryPreparation,
}) {
  const checks = [];

  addCheck(
    checks,
    "workflow-stages-executable-runtime-and-readme",
    [
      "vending-daemon.exe",
      "machine.exe",
      "WebView2Loader.dll",
      "machine-config.bringup.example.json",
      "vending-daemon-smoke.ps1",
      "setup-scheduled-tasks.ps1",
      "public\\windows-bringup-bundle.md",
      "- public/windows-bringup-bundle.md",
      '"README.md"',
      '"VERSION.txt"',
    ].every((required) => workflow.includes(required)),
    "workflow must stage the runtime delivery unit, smoke scripts, README.md, and VERSION.txt",
  );
  addCheck(
    checks,
    "README-supplies-MaintenancePin-from-a-secure-operator-source",
    readme.includes("-MaintenancePin $env:VEM_MAINTENANCE_PIN") &&
      readme.includes("approved operator secret channel") &&
      readme.includes("contains no\nPIN value"),
    "README supplies MaintenancePin from a secure operator source instead of an unusable credential-free smoke example",
  );
  addCheck(
    checks,
    "README-documents-factory-one-shot-capability-boundary",
    readme.includes(FACTORY_BOOTSTRAP_CAPABILITY_PATH) &&
      readme.includes("not\npart of this bundle") &&
      readme.includes("same Factory/Testbed bootstrap"),
    "README must describe the Factory/Testbed one-shot capability as protected, single-use, and outside the bundle",
  );
  addCheck(
    checks,
    "smoke-uses-the-factory-bootstrap-session-path-without-logging-secrets",
    smoke.includes("[string]$MaintenancePin") &&
      smoke.includes(FACTORY_BOOTSTRAP_CAPABILITY_SUFFIX) &&
      smoke.includes("x-vem-factory-bootstrap-capability") &&
      smoke.includes('$headers.Remove("x-vem-factory-bootstrap-capability")') &&
      !/Write-(?:Host|Output|Verbose)[^\r\n]*(?:\$MaintenancePin|\$capability)/u.test(
        smoke,
      ),
    "smoke must use its protected Factory bootstrap or MaintenancePin boundary without printing either value",
  );
  addCheck(
    checks,
    "factory-and-smoke-share-the-one-shot-capability-origin",
    factoryPreparation.includes(FACTORY_BOOTSTRAP_CAPABILITY_PATH) &&
      factoryPreparation.includes(
        "bootstrap-provisioning-capability-verifier.json",
      ) &&
      smoke.includes(FACTORY_BOOTSTRAP_CAPABILITY_SUFFIX),
    "Factory/Testbed preparation and bundle smoke must use the same verified one-shot capability path",
  );

  const failures = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.detail}`);
  return { ok: failures.length === 0, checks, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkWindowsBringUpBundle({
    workflow: readText(".github/workflows/windows-bringup-bundle.yml"),
    readme: readText("public/windows-bringup-bundle.md"),
    smoke: readText("scripts/windows/vending-daemon-smoke.ps1"),
    factoryPreparation: readText("scripts/windows/prepare-factory-runtime.ps1"),
  });
  for (const check of result.checks) {
    console.log(
      `${check.passed ? "ok" : "not ok"} - ${check.name}: ${check.detail}`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}
