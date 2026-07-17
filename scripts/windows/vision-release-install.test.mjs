import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const candidatePath = "scripts/windows/test-vision-candidate.ps1";
const candidateHarnessPath =
  "scripts/windows/test-vision-candidate.windows-harness.ps1";

test("Vision candidate runtime path is independent of retired Factory delivery", () => {
  for (const path of [candidatePath, candidateHarnessPath]) {
    assert.equal(existsSync(path), true, `${path} should exist`);
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /factory|provision-vision-factory-release|prepare-factory-runtime/i,
      `${path} must not restore retired Factory delivery`,
    );
  }
});
