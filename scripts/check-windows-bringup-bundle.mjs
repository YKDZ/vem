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
  const body = powershellFunctionBody(smoke, "Get-ProtectedMaintenanceHeaders");
  if (!body)
    return { valid: false, failures: ["missing protected-session function"] };

  const failures = [];
  if (
    !/if\s*\(\s*-not\s+\[string\]::IsNullOrWhiteSpace\(\$Pin\)\s*\)/u.test(body)
  ) {
    failures.push("PIN branch is absent");
  }
  if (!hasPostTo(body, "/v1/maintenance/sessions")) {
    failures.push(
      "PIN branch does not call the daemon maintenance-session endpoint",
    );
  }
  if (
    !/pin\s*=\s*\$Pin/u.test(body) ||
    !/operatorId\s*=\s*"windows-smoke"/u.test(body)
  ) {
    failures.push("PIN branch does not construct the daemon session request");
  }
  if (
    !/Join-Path\s+\$RuntimeDataDir\s+"factory\\bootstrap-provisioning-capability"/u.test(
      body,
    )
  ) {
    failures.push(
      "Factory capability is not resolved relative to RuntimeDataDir",
    );
  }
  if (
    /C:\\\\ProgramData\\\\VEM\\\\vending-daemon\\\\factory\\\\bootstrap-provisioning-capability/iu.test(
      body,
    )
  ) {
    failures.push(
      "Factory capability is hard-coded instead of runtime-relative",
    );
  }
  if (
    !/Test-Path\s+-LiteralPath\s+\$capabilityPath\s+-PathType\s+Leaf/u.test(
      body,
    )
  ) {
    failures.push("missing capability must fail closed");
  }
  if (!/ReadAllText\(\$capabilityPath/u.test(body)) {
    failures.push("capability is not securely read from its runtime path");
  }
  if (!hasPostTo(body, "/v1/factory/bootstrap/maintenance-session")) {
    failures.push(
      "capability branch does not call the daemon bootstrap endpoint",
    );
  }
  if (!/x-vem-factory-bootstrap-capability/u.test(body)) {
    failures.push("capability branch does not supply the required header");
  }
  if (
    !/finally\s*\{[\s\S]{0,200}?\$headers\.Remove\("x-vem-factory-bootstrap-capability"\)/u.test(
      body,
    )
  ) {
    failures.push("capability header is not cleared after the daemon call");
  }
  if (
    !/\[string\]::IsNullOrWhiteSpace\(\[string\]\$session\.sessionId\)/u.test(
      body,
    )
  ) {
    failures.push("missing daemon-issued session id does not fail closed");
  }
  if (
    /Write-(?:Host|Output|Verbose)[^\r\n]*(?:\$MaintenancePin|\$Pin|\$capability)/u.test(
      body,
    )
  ) {
    failures.push("protected credential may be logged");
  }
  return { valid: failures.length === 0, failures };
}

export function inspectBringUpReadmeSessionInvocation(readme) {
  const failures = [];
  if (/powershell[^\r\n]*-MaintenancePin/iu.test(readme)) {
    failures.push(
      "README passes a PIN through a child PowerShell command line",
    );
  }
  if (/\$env:VEM_MAINTENANCE_PIN/u.test(readme)) {
    failures.push(
      "README sources the PIN from an inherited environment variable",
    );
  }
  if (!/Read-Host\s+.*-AsSecureString/u.test(readme)) {
    failures.push(
      "README does not read the PIN as a SecureString in the current process",
    );
  }
  if (!/SecureStringToBSTR/u.test(readme) || !/ZeroFreeBSTR/u.test(readme)) {
    failures.push(
      "README does not bound and clear the transient PIN conversion",
    );
  }
  if (
    !/&\s+C:\\VEM\\bringup\\scripts\\windows\\vending-daemon-smoke\.ps1[\s\S]{0,900}?-MaintenancePin\s+\$maintenancePin/u.test(
      readme,
    )
  ) {
    failures.push(
      "README does not invoke the smoke script in the current PowerShell process",
    );
  }
  return { valid: failures.length === 0, failures };
}

function inspectDaemonAuthRoutes(daemonIpc) {
  const failures = [];
  for (const endpoint of [
    "/v1/maintenance/sessions",
    "/v1/factory/bootstrap/maintenance-session",
  ]) {
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
  factoryPreparation,
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
      "machine-config.bringup.example.json",
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
    "smoke-protected-session-contract-is-real-and-fail-closed",
    smokeContract.valid,
    smokeContract.failures.join("; ") || "protected session contract verified",
  );
  const readmeContract = inspectBringUpReadmeSessionInvocation(readme);
  addCheck(
    checks,
    "README-reads-and-calls-maintenance-PIN-in-current-process",
    readmeContract.valid,
    readmeContract.failures.join("; ") ||
      "current-process secure PIN invocation verified",
  );
  const daemonContract = inspectDaemonAuthRoutes(daemonIpc);
  addCheck(
    checks,
    "smoke-targets-real-daemon-auth-endpoints",
    daemonContract.valid,
    daemonContract.failures.join("; ") || "daemon auth endpoints verified",
  );
  addCheck(
    checks,
    "factory-and-smoke-share-the-one-shot-capability-origin",
    factoryPreparation.includes(
      "bootstrap-provisioning-capability-verifier.json",
    ) &&
      factoryPreparation.includes("bootstrap-provisioning-capability") &&
      /Join-Path\s+\$RuntimeDataDir\s+"factory\\bootstrap-provisioning-capability"/u.test(
        smoke,
      ),
    "Factory/Testbed preparation and bundle smoke must use the same verified one-shot capability origin",
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
    daemonIpc: readText("apps/vending-daemon/src/ipc.rs"),
  });
  for (const check of result.checks) {
    console.log(
      `${check.passed ? "ok" : "not ok"} - ${check.name}: ${check.detail}`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}
