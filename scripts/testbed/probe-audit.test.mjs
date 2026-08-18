import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertProbeBoundaries, auditProbeBoundaries } from "./probe-audit.mjs";

describe("probe boundary audit", () => {
  it("passes a clean framework directory", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-probe-clean-"));
    writeFileSync(
      join(root, "driver.mjs"),
      'export const roles = ["observer", "broker"];\n',
    );
    assert.deepEqual(auditProbeBoundaries(root), []);
  });

  it("rejects creation-date process guessing", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-probe-dirty-"));
    writeFileSync(
      join(root, "driver.mjs"),
      "Sort-Object CreationDate -Descending\n",
    );
    const violations = auditProbeBoundaries(root);
    assert.ok(
      violations.some((entry) => entry.includes("creation-date-guess")),
    );
    assert.throws(() => assertProbeBoundaries(root), /probe boundary/);
  });

  it("rejects reading the product log tail", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-probe-log-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "observe.ps1"), "Get-Content vision.log\n");
    const violations = auditProbeBoundaries(root);
    assert.ok(violations.some((entry) => entry.includes("vision-log-tail")));
  });
});
