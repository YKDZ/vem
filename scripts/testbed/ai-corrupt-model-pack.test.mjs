import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("creates a minimal corrupt manifest beside an arbitrary materialized source", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/testbed/ai-corrupt-model-pack.windows-harness.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.forgedOfficialRejected, true);
  assert.equal(output.foreignCleanupRejected, true);
  assert.equal(output.foreignPreserved, true);
  assert.equal(output.markerCleanupRejected, true);
  assert.equal(output.tamperedClonePreserved, true);
  assert.equal(output.sourceManifestUnchanged, true);
  assert.equal(output.sourceWeightUnchanged, true);
  assert.equal(output.cloneContainsOnlyCorruptManifest, true);
  assert.equal(output.changedByteCount, 1);
  assert.equal(output.changedByteOffset, 0);
});
