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
  "smoke-script-verifies-runtime-configuration-summary",
  smoke.includes("default-api-base-url-configured") &&
    smoke.includes("/v1/config/summary") &&
    smoke.includes("sourceDocuments.bootstrap"),
  `${smokePath} should verify the grouped runtime configuration summary exposes the bootstrap API Base URL`,
);
addCheck(
  "smoke-script-executes-typed-claim-through-runtime-bootstrap",
  smoke.includes("/v1/bring-up") &&
    smoke.includes("/tasks/execute") &&
    smoke.includes("claimCode") &&
    smoke.includes("WXYZ-2345"),
  `${smokePath} should POST a deliberately invalid test claim through the typed Bring-Up cursor`,
);
addCheck(
  "smoke-script-distinguishes-typed-invalid-claim-from-backend-unavailable",
  smoke.includes("claim-endpoint-reachable-invalid-claim") &&
    smoke.includes("claim-endpoint-backend-unavailable-fails-smoke") &&
    smoke.includes("machine_claim_invalid_or_expired") &&
    smoke.includes("machine_claim_backend_unavailable"),
  `${smokePath} should pass only after a service API invalid-claim response, not backend unavailable`,
);
addCheck(
  "release-path-has-no-legacy-config-or-claim-endpoints",
  !smoke.includes('"$baseUrl/v1/config"') &&
    !smoke.includes("/v1/provisioning/claim"),
  `${smokePath} must not retain mutable legacy config or direct claim release paths`,
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
