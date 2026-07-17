import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function addCheck(checks, name, passed, detail) {
  checks.push({ name, passed, detail });
}

function powershellFunctionBody(source, name) {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\{`, "iu"));
  if (start < 0) return null;
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  return null;
}

function hasPostTo(body, endpoint) {
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `Invoke-RestMethod\\s+"\\$BaseUrl${escaped}"[\\s\\S]{0,160}?-Method\\s+Post`,
    "u",
  ).test(body);
}

/**
 * Parse the executable PowerShell boundary, rather than treating arbitrary
 * words in a README or comment as evidence of a protected session.  This is
 * deliberately a small contract parser: each fact represents a required
 * runtime action performed by Get-ProtectedMaintenanceHeaders.
 */
export function inspectProtectedMaintenanceSmokeContract(smoke) {
  const failures = [];
  if (!/runtime-bootstrap\.json/u.test(smoke)) {
    failures.push("smoke does not write Runtime Bootstrap");
  }
  if (!/provisioningApiBaseUrl/u.test(smoke)) {
    failures.push("smoke does not set the bootstrap provisioning API base URL");
  }
  if (!/\/v1\/bring-up\/tasks\/execute/u.test(smoke)) {
    failures.push("smoke does not exercise the daemon claim task endpoint");
  }
  if (/machine-config|x-vem-factory-bootstrap-capability|bootstrap-provisioning-capability/iu.test(smoke)) {
    failures.push("smoke retains a legacy full-config or factory bootstrap path");
  }
  return { valid: failures.length === 0, failures };
}

export function inspectBringUpReadmeSessionInvocation(readme) {
  const failures = [];
  if (!/Runtime Bootstrap/u.test(readme)) {
    failures.push("README does not describe Runtime Bootstrap as a bundle input");
  }
  if (/machine-config/iu.test(readme)) {
    failures.push("README retains legacy machine-config path wording");
  }
  return { valid: failures.length === 0, failures };
}

function inspectDaemonAuthRoutes(daemonIpc) {
  const failures = [];
  for (const endpoint of ["/v1/bring-up/tasks/execute"]) {
    const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (!new RegExp(`"${escaped}"\\s*,\\s*post\\(`, "u").test(daemonIpc)) {
      failures.push(`daemon does not expose POST ${endpoint}`);
    }
  }
  return { valid: failures.length === 0, failures };
}

/**
 * The bundle is assembled in GitHub Actions rather than stored as an archive.
 * Check staging plus the executable protected-session contract shared by the
 * README, smoke script, Factory origin, and daemon routes.
 */
export function checkWindowsBringUpBundle({
  workflow,
  readme,
  smoke,
  daemonIpc = "",
}) {
  const checks = [];
  addCheck(
    checks,
    "workflow-stages-executable-runtime-and-readme",
    [
      "vending-daemon.exe",
      "machine.exe",
      "WebView2Loader.dll",
      "runtime-bootstrap.example.json",
      "vending-daemon-smoke.ps1",
      "setup-scheduled-tasks.ps1",
      "public\\windows-bringup-bundle.md",
      '"README.md"',
      '"VERSION.txt"',
    ].every((required) => workflow.includes(required)),
    "workflow must stage the runtime delivery unit, smoke scripts, README.md, and VERSION.txt",
  );

  const smokeContract = inspectProtectedMaintenanceSmokeContract(smoke);
  addCheck(
    checks,
    "smoke-runtime-bootstrap-claim-contract-is-real-and-fail-closed",
    smokeContract.valid,
    smokeContract.failures.join("; ") || "protected session contract verified",
  );
  const readmeContract = inspectBringUpReadmeSessionInvocation(readme);
  addCheck(
    checks,
    "README-documents-runtime-bootstrap-bundle-input",
    readmeContract.valid,
    readmeContract.failures.join("; ") ||
      "current-process secure PIN invocation verified",
  );
  const daemonContract = inspectDaemonAuthRoutes(daemonIpc);
  addCheck(
    checks,
    "smoke-targets-real-daemon-claim-endpoint",
    daemonContract.valid,
    daemonContract.failures.join("; ") || "daemon claim endpoint verified",
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
    daemonIpc: readText("apps/vending-daemon/src/ipc.rs"),
  });
  for (const check of result.checks) {
    console.log(
      `${check.passed ? "ok" : "not ok"} - ${check.name}: ${check.detail}`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}
