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

test("Windows Bring-up bundle delivers executable runtime and a secure maintenance-session path", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme,
    smoke,
    factoryPreparation,
  });

  assert.equal(result.ok, true, result.failures.join("\n"));
});

test("Windows Bring-up bundle checker rejects a smoke example without a secure session source", () => {
  const result = checkWindowsBringUpBundle({
    workflow,
    readme: readme.replace(
      "-MaintenancePin $env:VEM_MAINTENANCE_PIN",
      "-ScannerPort COM4",
    ),
    smoke,
    factoryPreparation,
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure) =>
      failure.includes(
        "README supplies MaintenancePin from a secure operator source",
      ),
    ),
    result.failures.join("\n"),
  );
});
