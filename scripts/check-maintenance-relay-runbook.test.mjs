import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const runbookPath = "public/maintenance-relay-bring-up.md";

function readRunbook() {
  assert.equal(existsSync(runbookPath), true, `${runbookPath} should exist`);
  return readFileSync(runbookPath, "utf8");
}

function requiredTextPattern(text) {
  return new RegExp(
    text
      .split(" ")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );
}

describe("Maintenance Relay public runbook", () => {
  it("documents the test VPS WireGuard relay bring-up safety contract", () => {
    const runbook = readRunbook();

    for (const requiredText of [
      "Controlled Maintenance Ingress",
      "test VPS",
      "UDP 51820",
      "Linux WireGuard plus Linux firewall rules",
      "not a long-running Node service",
      "WireGuard data plane",
      "apps/service-api",
      "maintenance-relay:plan",
      "wg-vem-maint",
      "WG_RELAY_PRIVATE_KEY",
      "WG_RUNNER_PRIVATE_KEY",
      "WG_MACHINE_PRIVATE_KEY",
      "--plan-file",
      "--render relay",
      "--render peer",
      "operator-local plan file",
      "Generate each peer private key on the host that owns that peer",
      "private keys must not be committed",
      "Do not write private keys to the repository",
      "The VPS must not retain the runner or Windows VM private keys",
      "sudo apt-get install -y wireguard iptables",
      "net.ipv4.ip_forward=1",
      "relayConfig",
      "firewall.commands",
      "while IFS= read -r command",
      'sudo bash -c "$command"',
      "iptables",
      "rollback",
      "wg-quick down wg-vem-maint",
      "peer handshake",
      "denied flows",
      "non-secret evidence",
    ]) {
      assert.match(runbook, requiredTextPattern(requiredText));
    }
  });

  it("keeps public examples non-secret and non-deployable", () => {
    const runbook = readRunbook();

    assert.doesNotMatch(runbook, /PrivateKey\s*=\s*[A-Za-z0-9+/]{43}=/);
    assert.doesNotMatch(
      runbook,
      /WG_(?:RELAY|RUNNER|MACHINE)_PRIVATE_KEY=[A-Za-z0-9+/]{43}=/,
    );
    assert.doesNotMatch(
      runbook,
      /\[Interface\][\s\S]*PrivateKey\s*=[^\n<][\s\S]*\[Peer\][\s\S]*Endpoint\s*=/,
    );
    assert.match(runbook, /PrivateKey\s*=\s*<[^>\n]+>/);
  });

  it("guards operator-local public keys and per-host private key handling", () => {
    const runbook = readRunbook();

    assert.match(
      runbook,
      /live relay bring-up must use\s+`--plan-file`[\s\S]*operator-reviewed public keys/,
    );
    assert.match(
      runbook,
      /On the test VPS relay host, generate only the relay key/,
    );
    assert.match(
      runbook,
      /On the self-hosted GitHub runner, generate only the runner key/,
    );
    assert.match(
      runbook,
      /On the Windows Machine Runtime Testbed VM, generate only the machine key/,
    );
    assert.match(
      runbook,
      /encrypted channel[\s\S]*delete every[\s\S]*operator and VPS copy immediately/,
    );
    assert.doesNotMatch(
      runbook,
      /\/etc\/vem-maintenance-relay\/keys\/(?:github-runner|win10-vm)\.private\s*\|\s*wg pubkey/,
    );
  });
});
