import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkWindowsBringUpBundle } from "./check-windows-bringup-bundle.mjs";

const workflow = readFileSync(
  ".github/workflows/windows-bringup-bundle.yml",
  "utf8",
);
const readme = readFileSync("public/windows-bringup-bundle.md", "utf8");
const smoke = readFileSync("scripts/windows/vending-daemon-smoke.ps1", "utf8");
const factoryPreparation = readFileSync(
  "scripts/windows/prepare-factory-runtime.ps1",
  "utf8",
);
const daemonIpc = readFileSync("apps/vending-daemon/src/ipc.rs", "utf8");

test("Windows Bring-up bundle delivers executable runtime and a secure maintenance-session path", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme,
    smoke,
    factoryPreparation,
    daemonIpc,
  });

  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("Windows Bring-up bundle checker rejects a README that leaks the PIN into a child process command", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme: readme.replace(
      "& C:\\VEM\\bringup\\scripts\\windows\\vending-daemon-smoke.ps1",
      "powershell -ExecutionPolicy Bypass -File C:\\VEM\\bringup\\scripts\\windows\\vending-daemon-smoke.ps1",
    ),
    smoke,
    factoryPreparation,
    daemonIpc,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes(
        "README-reads-and-calls-maintenance-PIN-in-current-process",
      ),
    ),
    result.failures.join("\n"),
  );
});

test("Windows Bring-up bundle checker rejects a smoke script that targets a fake bootstrap endpoint", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme,
    smoke: smoke.replace(
      "/v1/factory/bootstrap/maintenance-session",
      "/v1/factory/bootstrap/pretend-session",
    ),
    factoryPreparation,
    daemonIpc,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes(
        "smoke-protected-session-contract-is-real-and-fail-closed",
      ),
    ),
    result.failures.join("\n"),
  );
});
