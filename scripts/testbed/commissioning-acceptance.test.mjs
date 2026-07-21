import assert from "node:assert/strict";
import test from "node:test";

import { validateCommissioningAdmission } from "./commissioning-acceptance.mjs";

test("commissioning admission belongs to a reconstructed full pass", () => {
  assert.deepEqual(
    validateCommissioningAdmission(
      { mode: "full", machineCode: "VEM-TESTBED-01" },
      { claim: { status: "provisioned", machineCode: "VEM-TESTBED-01" } },
    ),
    { status: "provisioned", machineCode: "VEM-TESTBED-01" },
  );
  assert.throws(
    () => validateCommissioningAdmission({ mode: "fast" }, {}),
    /reconstructed full-pass/,
  );
});
