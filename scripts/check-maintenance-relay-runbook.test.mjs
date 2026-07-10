import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const runbookPath = "public/maintenance-relay-bring-up.md";

function readRunbook() {
  assert.equal(existsSync(runbookPath), true, `${runbookPath} should exist`);
  return readFileSync(runbookPath, "utf8");
}

describe("Maintenance Relay public runbook", () => {
  it("documents the pull-based relay migration contract", () => {
    const runbook = readRunbook();
    for (const text of [
      "static relay planner",
      "apps/maintenance-relay",
      "MAINTENANCE_RELAY_CREDENTIAL",
      "maintenance_relay",
      "wg syncconf",
      "inet vem_maintenance_relay",
      "kernel timeouts",
      "source, target, protocol, and port tuples",
    ]) {
      assert.match(
        runbook,
        new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
    assert.match(runbook, /never accepts\s+API-provided shell text/);
  });

  it("does not retain static renderer or deployable secret examples", () => {
    const runbook = readRunbook();
    assert.doesNotMatch(runbook, /maintenance-relay:plan/);
    assert.doesNotMatch(runbook, /iptables -A/);
    assert.doesNotMatch(runbook, /PrivateKey\s*=\s*[A-Za-z0-9+/]{43}=/);
  });

  it("keeps issue 02 container assets explicitly test-only", () => {
    const runbook = readRunbook();
    assert.equal(existsSync("apps/maintenance-relay/Dockerfile"), false);
    assert.equal(
      existsSync("apps/maintenance-relay/test/privileged/Dockerfile"),
      true,
    );
    assert.match(runbook, /test-only privileged\s+image/);
    assert.match(runbook, /not a production deployment\s+artifact/);
  });
});
