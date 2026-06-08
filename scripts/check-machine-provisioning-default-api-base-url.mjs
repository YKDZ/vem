import { existsSync, readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const smokePath = "scripts/windows/vending-daemon-smoke.ps1";
const examplePath = "scripts/windows/machine-config.bringup.example.json";
const runbookPath =
  "docs/runbooks/machine-provisioning-default-api-base-url.md";

const smoke = readText(smokePath);
const example = readText(examplePath);
const runbook = readText(runbookPath);

addCheck(
  "smoke-script-accepts-default-api-base-url",
  smoke.includes("[string]$DefaultApiBaseUrl"),
  `${smokePath} should expose -DefaultApiBaseUrl`,
);
addCheck(
  "smoke-script-seeds-daemon-env",
  smoke.includes("VEM_DEFAULT_API_BASE_URL"),
  `${smokePath} should set VEM_DEFAULT_API_BASE_URL for service bring-up`,
);
addCheck(
  "smoke-script-verifies-configured-endpoint",
  smoke.includes("default-api-base-url-configured") &&
    smoke.includes("/v1/config"),
  `${smokePath} should verify daemon config exposes the default API Base URL`,
);
addCheck(
  "smoke-script-keeps-debug-disabled-by-default",
  !smoke.includes("VEM_ENABLE_ADVANCED_MAINTENANCE_CONFIG"),
  `${smokePath} should not enable advanced debug unless a caller adds it explicitly`,
);

const exampleJson = example ? JSON.parse(example) : {};
addCheck(
  "bringup-example-leaves-machine-unclaimed",
  exampleJson.machineCode === null,
  `${examplePath} should leave machineCode null so first boot asks only for a claim code`,
);
addCheck(
  "bringup-example-configures-default-api-base-url",
  typeof exampleJson.apiBaseUrl === "string" &&
    exampleJson.apiBaseUrl.startsWith("https://staging-api.example.com/api"),
  `${examplePath} should show a staging default API Base URL`,
);

addCheck(
  "runbook-documents-staging-and-production",
  runbook.includes("staging") && runbook.includes("production"),
  `${runbookPath} should describe both staging and production values`,
);
addCheck(
  "runbook-documents-claim-endpoint-smoke",
  runbook.includes("/machines/claim") &&
    runbook.includes("Machine Claim Code"),
  `${runbookPath} should explain how to verify the claim endpoint and first-boot page`,
);
addCheck(
  "runbook-documents-override-behavior",
  runbook.includes("machine-config.json") &&
    runbook.includes("overrides VEM_DEFAULT_API_BASE_URL"),
  `${runbookPath} should document file override behavior`,
);

const failures = checks.filter((check) => !check.passed);
for (const check of checks) {
  const mark = check.passed ? "ok" : "not ok";
  console.log(`${mark} - ${check.name}: ${check.detail}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
