import assert from "node:assert/strict";
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
    const findings = findLegacyEffectiveConfigReferences({
      root: "scripts/fixtures/architecture-guard",
      paths: ["negative-effective-config"],
    });

    assert.equal(findings.length, 1);
    assert.throws(
      () =>
        assertNoLegacyEffectiveConfigReferences({
          root: "scripts/fixtures/architecture-guard",
          paths: ["negative-effective-config"],
        }),
      /legacy effective-config references found/,
    );
  });

  it("keeps daemon, machine, scripts, and workflows free of removed configuration paths", () => {
    assertNoLegacyEffectiveConfigReferences({ root: ".", paths: guardPaths });
  });
});
