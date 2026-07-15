import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  collectFactoryMaintenanceRelayAttestation,
  validateFactoryMaintenanceRelayAttestation,
} from "./factory-maintenance-relay-attestation.mjs";

const relayKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

function proof() {
  const now = Date.now();
  return {
    schemaVersion: "factory-maintenance-relay-attestation/v1",
    kind: "factory-maintenance-relay-attestation",
    source: "runner-wireguard",
    startedAt: new Date(now - 10_000).toISOString(),
    completedAt: new Date(now).toISOString(),
    session: {
      id: "550e8400-e29b-41d4-a716-446655440001",
      kind: "ci",
      status: "active",
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 3 * 60 * 60_000).toISOString(),
      sourcePeer: {
        id: "550e8400-e29b-41d4-a716-446655440002",
        role: "runner",
        publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        tunnelAddress: "10.91.2.10",
      },
      targetMachine: {
        id: "550e8400-e29b-41d4-a716-446655440003",
        maintenancePeerId: "550e8400-e29b-41d4-a716-446655440004",
        tunnelAddress: "10.91.16.10",
      },
      relay: {
        id: "550e8400-e29b-41d4-a716-446655440005",
        role: "relay",
        publicKey: relayKey,
        tunnelAddress: "10.91.0.1",
      },
      relayConvergence: { state: "applied" },
    },
    runner: {
      interface: "wg-factory",
      relayPeer: {
        publicKey: relayKey,
        endpoint: "relay.example.test:51820",
        allowedIps: ["10.91.16.10/32"],
        latestHandshakeEpochSeconds: Math.floor((now - 5_000) / 1000),
      },
      route: {
        destination: "10.91.16.10/32",
        device: "wg-factory",
        source: "10.91.2.10",
      },
    },
  };
}

describe("Factory maintenance relay attestation", () => {
  it("accepts only fresh runner-owned WireGuard evidence bound to the CI session", () => {
    assert.equal(
      validateFactoryMaintenanceRelayAttestation(proof()).runner.route.device,
      "wg-factory",
    );
  });

  it("rejects an expired control-plane session even when its runner proof is internally consistent", () => {
    const value = proof();
    value.startedAt = "2020-01-01T08:00:00.000Z";
    value.completedAt = "2020-01-01T08:00:10.000Z";
    value.session.issuedAt = "2020-01-01T07:59:00.000Z";
    value.session.expiresAt = "2020-01-01T10:30:00.000Z";
    value.runner.relayPeer.latestHandshakeEpochSeconds = 1_577_865_605;

    assert.throws(
      () => validateFactoryMaintenanceRelayAttestation(value),
      /expired/i,
    );
  });

  it("collects the bootstrap relay route before the Factory target is installed", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-relay-attestation-"));
    const previousPath = process.env.PATH;
    const previousInterface = process.env.VEM_MAINTENANCE_RELAY_INTERFACE;
    const now = Date.now();
    const handshake = Math.floor(now / 1000);
    const session = proof().session;
    session.issuedAt = new Date(now - 60_000).toISOString();
    session.expiresAt = new Date(now + 60 * 60_000).toISOString();
    try {
      writeFileSync(
        join(root, "sudo"),
        `#!/bin/sh\ncase "$*" in\n  "wg show wg-factory dump") printf '%s\\n' '${relayKey}\t(none)\trelay.example.test:51820\t10.91.16.10/32\t${handshake}\t0\t0\t0' ;;\n  "wg show wg-factory latest-handshakes") printf '%s\\n' '${relayKey}\t${handshake}' ;;\n  "wg show wg-factory allowed-ips") printf '%s\\n' '${relayKey}\t10.91.16.10/32' ;;\n  *) exit 1 ;;\nesac\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(root, "ip"),
        "#!/bin/sh\nprintf '%s\\n' '10.91.16.10 dev wg-factory src 10.91.2.10 uid 1000'\n",
        { mode: 0o755 },
      );
      writeFileSync(
        join(root, "ping"),
        '#!/bin/sh\n[ "$*" = "-c 1 -W 5 10.91.0.1" ]\n',
        { mode: 0o755 },
      );
      process.env.PATH = `${root}:${previousPath}`;
      process.env.VEM_MAINTENANCE_RELAY_INTERFACE = "wg-factory";

      assert.equal(
        collectFactoryMaintenanceRelayAttestation(session).runner.route
          .destination,
        "10.91.16.10/32",
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousInterface === undefined) {
        delete process.env.VEM_MAINTENANCE_RELAY_INTERFACE;
      } else {
        process.env.VEM_MAINTENANCE_RELAY_INTERFACE = previousInterface;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [name, mutate] of [
    [
      "static UUID and key evidence",
      (value) => {
        value.session.id = "550e8400-e29b-41d4-a716-446655440010";
        value.runner.relayPeer.publicKey =
          "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
      },
    ],
    [
      "a handshake epoch of one",
      (value) => {
        value.runner.relayPeer.latestHandshakeEpochSeconds = 1;
      },
    ],
    [
      "a handshake from before the CI session",
      (value) => {
        value.runner.relayPeer.latestHandshakeEpochSeconds =
          Math.floor(Date.parse(value.session.issuedAt) / 1000) - 1;
      },
    ],
    [
      "adapter echoed proof",
      (value) => {
        value.source = "adapter";
      },
    ],
    [
      "adapter forged route",
      (value) => {
        value.runner.route.device = "adapter-fake-wg";
      },
    ],
    [
      "adapter forged relay peer",
      (value) => {
        value.runner.relayPeer.publicKey =
          "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
      },
    ],
  ]) {
    it(`rejects ${name}`, () => {
      const value = proof();
      mutate(value);
      assert.throws(() => validateFactoryMaintenanceRelayAttestation(value));
    });
  }
});
