import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const activeRuntimeFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/vm-runtime-acceptance.yml",
  "package.json",
  "tools/check-ci.mjs",
  "public/managed-machine-update.md",
  "public/machine-provisioning-default-api-base-url.md",
  "public/unified-field-delivery.md",
  "public/windows-bringup-bundle.md",
  "public/windows-factory-runtime-and-maintenance.md",
];

const activeRuntimeForbiddenPatterns = [
  /\bFactory Image Acceptance\b/,
  /\bFactory ISO\b/,
  /\bFactory Manifest\b/,
  /\bFactory Personalization Media\b/,
  /\bmanaged-update\b/i,
  /\bapply-managed-update\b/,
  /\bbuild-factory-iso\b/,
  /\bfactory-image-acceptance\b/,
  /\bprepare-factory-runtime\b/,
  /\bverify-factory-runtime\b/,
  /\bprovision-vision-factory-release\b/,
  /\bWireGuard\b/,
  /\bTailscale\b/,
  /\bVPS\b/,
  /\bCOM[35]\b/,
  /118\.25\.104\.160/,
  /100\.66\.207\.119/,
  /100\.68\.189\.11/,
];

describe("active Windows runtime Factory retirement guard", () => {
  for (const path of activeRuntimeFiles) {
    it(`${path} does not describe or invoke stopped Factory paths`, () => {
      const text = readFileSync(path, "utf8");
      for (const pattern of activeRuntimeForbiddenPatterns) {
        assert.doesNotMatch(text, pattern, `${path} matched ${pattern}`);
      }
    });
  }

  it("runtime acceptance CLI does not import historical Factory source at module load", () => {
    const text = readFileSync("scripts/testbed/win10-vem-e2e.mjs", "utf8");
    assert.doesNotMatch(
      text,
      /^import .*"\.\.\/factory\//m,
      "runtime acceptance CLI must not load scripts/factory for active runtime modes",
    );
  });
});
