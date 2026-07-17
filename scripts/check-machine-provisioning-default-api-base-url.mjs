import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const smokePath = "scripts/windows/vending-daemon-smoke.ps1";
const examplePath = "scripts/windows/runtime-bootstrap.example.json";
const runbookPath = "public/machine-provisioning-default-api-base-url.md";

const smoke = readText(smokePath);
const example = readText(examplePath);
const runbook = readText(runbookPath);

addCheck(
  "smoke-script-accepts-default-api-base-url",
  smoke.includes("[string]$DefaultApiBaseUrl"),
  `${smokePath} should expose -DefaultApiBaseUrl`,
);
addCheck(
  "smoke-script-writes-runtime-bootstrap",
  smoke.includes("runtime-bootstrap.json") &&
    smoke.includes("provisioningApiBaseUrl"),
  `${smokePath} should write Runtime Bootstrap for service bring-up`,
);
addCheck(
  "smoke-script-verifies-effective-runtime-configuration",
  smoke.includes("runtime-bootstrap-owns-provisioning-url") &&
    smoke.includes("/v1/runtime-configuration") &&
    smoke.includes("sourceDocuments.bootstrap"),
  `${smokePath} should verify the grouped effective runtime configuration exposes Runtime Bootstrap ownership`,
);
addCheck(
  "smoke-script-executes-real-claim-through-runtime-bootstrap",
  smoke.includes("/v1/provisioning/claim") &&
    smoke.includes("[string]$ClaimCode") &&
    smoke.includes("real-claim-accepted"),
  `${smokePath} should POST a caller-provided real claim through the narrow provisioning intent`,
);
addCheck(
  "smoke-script-does-not-use-retired-configuration-or-maintenance-routes",
  !smoke.includes("/v1/config/summary") &&
    !smoke.includes("/v1/bring-up") &&
    !smoke.includes("/v1/maintenance/sessions") &&
    !smoke.includes("MaintenancePin"),
  `${smokePath} should use only the hard-migrated runtime configuration and claim paths`,
);
addCheck(
  "release-path-has-no-legacy-full-config-endpoint",
  !smoke.includes('"$baseUrl/v1/config"'),
  `${smokePath} must not retain the mutable legacy full-config path`,
);
addCheck(
  "smoke-script-verifies-first-boot-claim-code-page",
  smoke.includes("first-boot-machine-claim-code-page") &&
    smoke.includes("first-boot-backend-url-input-absent") &&
    smoke.includes("Machine Claim Code") &&
    smoke.includes("backend URL"),
  `${smokePath} should verify or record a first-boot Machine Claim Code page check without backend URL input`,
);
addCheck(
  "smoke-script-keeps-debug-disabled-by-default",
  !smoke.includes("VEM_ENABLE_ADVANCED_MAINTENANCE_CONFIG"),
  `${smokePath} should not enable advanced debug unless a caller adds it explicitly`,
);

const exampleJson = example ? JSON.parse(example) : {};
addCheck(
  "runtime-bootstrap-example-has-no-machine-identity",
  exampleJson.machineCode === undefined &&
    exampleJson.machineId === undefined &&
    exampleJson.machineSecret === undefined,
  `${examplePath} should omit machine identity and credentials`,
);
addCheck(
  "runtime-bootstrap-example-configures-provisioning-api-base-url",
  typeof exampleJson.provisioningApiBaseUrl === "string" &&
    exampleJson.provisioningApiBaseUrl.endsWith("/api"),
  `${examplePath} should show a provisioning API Base URL`,
);

addCheck(
  "runbook-documents-runtime-bootstrap",
  runbook.includes("Runtime Bootstrap") &&
    runbook.includes("Provisioning Profile Cache"),
  `${runbookPath} should describe Runtime Bootstrap and the accepted profile cache`,
);
addCheck(
  "runbook-documents-claim-endpoint-smoke",
  runbook.includes("claim") && runbook.includes("Runtime Bootstrap"),
  `${runbookPath} should explain how Runtime Bootstrap feeds clean claim`,
);
addCheck(
  "runbook-documents-override-behavior",
  runbook.includes("Runtime Bootstrap") &&
    !runbook.includes("VEM_DEFAULT_API_BASE_URL"),
  `${runbookPath} should document Runtime Bootstrap without env overrides`,
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
