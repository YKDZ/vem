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
const daemonIpc = readFileSync("apps/vending-daemon/src/ipc.rs", "utf8");

test("Windows Bring-up bundle delivers executable runtime and a secure maintenance-session path", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme,
    smoke,
    daemonIpc,
  });

  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("Windows Bring-up bundle checker rejects legacy machine config README wording", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme: `${readme}\nCopy ${"machine-config"}.json before first boot.\n`,
    smoke,
    daemonIpc,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes(
        "README-documents-runtime-bootstrap-bundle-input",
      ),
    ),
    result.failures.join("\n"),
  );
});

test("Windows Bring-up bundle checker rejects a smoke script that targets a fake claim endpoint", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme,
    smoke: smoke.replace(
      "/v1/bring-up/tasks/execute",
      "/v1/bring-up/tasks/pretend",
    ),
    daemonIpc,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes(
        "smoke-runtime-bootstrap-claim-contract-is-real-and-fail-closed",
      ),
    ),
    result.failures.join("\n"),
  );
});
