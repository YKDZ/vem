import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertNoDuplicatedWaiters,
  auditDuplicatedWaiters,
} from "./duplication-audit.ts";

describe("waiter duplication audit", () => {
  it("passes a module that imports the shared waiter", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-wait-clean-"));
    writeFileSync(
      join(root, "driver.ts"),
      'import { waitForCondition } from "./condition-waiter.ts";\n',
    );
    assert.deepEqual(auditDuplicatedWaiters(root), []);
  });

  it("rejects a locally reimplemented waiter", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-wait-dirty-"));
    writeFileSync(
      join(root, "driver.ts"),
      "async function waitForCondition(name, predicate, timeoutMs) {}\n",
    );
    const violations = auditDuplicatedWaiters(root);
    assert.ok(
      violations.some((entry) =>
        entry.includes("duplicated-wait-for-condition"),
      ),
    );
    assert.throws(() => assertNoDuplicatedWaiters(root), /duplicated waiter/);
  });
});
