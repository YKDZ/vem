import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertNoLegacyEffectiveConfigReferences,
  findLegacyEffectiveConfigReferences,
} from "./check-effective-config-hard-migration.mjs";

const guardPaths = [
  "apps/vending-daemon",
  "apps/machine",
  "scripts",
  ".github/workflows",
];

describe("effective configuration hard-migration guard", () => {
  it("rejects the explicit negative legacy fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-effective-config-guard-"));
    writeFileSync(
      join(root, "legacy-path.txt"),
      `${["machine", "config.json"].join("-")}\n`,
    );
    const findings = findLegacyEffectiveConfigReferences({
      root,
      paths: ["."],
    });

    try {
      assert.equal(findings.length, 1);
      assert.throws(
        () =>
          assertNoLegacyEffectiveConfigReferences({
            root,
            paths: ["."],
          }),
        /legacy effective-config references found/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps daemon, machine, scripts, and workflows free of removed configuration paths", () => {
    assertNoLegacyEffectiveConfigReferences({ root: ".", paths: guardPaths });
  });
});
