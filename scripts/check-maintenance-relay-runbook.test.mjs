import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const runbookPath = "public/maintenance-relay-bring-up.md";

function readRunbook() {
  assert.equal(existsSync(runbookPath), true, `${runbookPath} should exist`);
  return readFileSync(runbookPath, "utf8");
}

describe("Maintenance Relay public runbook", () => {
  it("is a tombstone rather than an active deployment runbook", () => {
    const runbook = readRunbook();
    assert.match(runbook, /historical tombstone/i);
    assert.match(runbook, /direct certificate-only SSH deployment/i);
    assert.doesNotMatch(runbook, /MAINTENANCE_RELAY_/);
    assert.doesNotMatch(runbook, /wg syncconf/i);
    assert.doesNotMatch(runbook, /WireGuard/i);
  });
});
