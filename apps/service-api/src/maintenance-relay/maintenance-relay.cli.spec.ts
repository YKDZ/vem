import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildDefaultMaintenanceRelayPlan } from "./maintenance-relay";
import {
  parseMaintenanceRelayCliOptions,
  runMaintenanceRelayCli,
} from "./maintenance-relay.cli";

function wireGuardPublicKey(seed: number): string {
  return Buffer.from(Array.from({ length: 32 }, () => seed)).toString("base64");
}

describe("Maintenance Relay CLI", () => {
  it("renders separated dry-plan outputs without private keys", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await runMaintenanceRelayCli(["--dry-plan"], {
      env: {},
      stdout,
      stderr,
    });

    expect(stderr.write).not.toHaveBeenCalled();
    const output = JSON.parse(stdout.write.mock.calls[0][0]);
    expect(output).toMatchObject({
      relay: {
        interfaceName: "wg-vem-maint",
        address: "10.91.0.1/24",
        listenPort: 51820,
      },
      firewall: {
        allowedFlows: [
          {
            sourcePeerName: "github-runner",
            targetPeerName: "win10-vm",
            protocol: "tcp",
            port: 22,
          },
        ],
      },
    });
    expect(output.relayConfig).toBeUndefined();
    expect(output.peerConfigs).toBeUndefined();
  });

  it("renders sensitive configs separately when keys are supplied externally", async () => {
    const stdout = { write: vi.fn() };

    await runMaintenanceRelayCli(["--format", "json"], {
      env: {
        WG_RELAY_PRIVATE_KEY: "relay-private-key-from-env",
        WG_RUNNER_PRIVATE_KEY: "runner-private-key-from-env",
        WG_MACHINE_PRIVATE_KEY: "machine-private-key-from-env",
      },
      stdout,
      stderr: { write: vi.fn() },
    });

    const output = JSON.parse(stdout.write.mock.calls[0][0]);
    expect(output.relayConfig).toContain(
      "PrivateKey = relay-private-key-from-env",
    );
    expect(output.peerConfigs["github-runner"]).toContain(
      "PrivateKey = runner-private-key-from-env",
    );
    expect(output.peerConfigs["win10-vm"]).toContain(
      "PrivateKey = machine-private-key-from-env",
    );
    expect(output.firewall.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--dport 22"),
        expect.stringContaining("-j DROP"),
      ]),
    );
  });

  it("renders only the relay config without runner or machine private keys", async () => {
    const stdout = { write: vi.fn() };

    await runMaintenanceRelayCli(["--render", "relay"], {
      env: {
        WG_RELAY_PRIVATE_KEY: "relay-private-key-from-env",
      },
      stdout,
      stderr: { write: vi.fn() },
    });

    const output = JSON.parse(stdout.write.mock.calls[0][0]);
    expect(output.relayConfig).toContain(
      "PrivateKey = relay-private-key-from-env",
    );
    expect(output.peerConfigs).toBeUndefined();
  });

  it("renders only one peer config from that peer host private key", async () => {
    const stdout = { write: vi.fn() };

    await runMaintenanceRelayCli(
      ["--render", "peer", "--peer", "github-runner"],
      {
        env: {
          WG_PEER_PRIVATE_KEY: "runner-private-key-from-peer-host",
        },
        stdout,
        stderr: { write: vi.fn() },
      },
    );

    const output = JSON.parse(stdout.write.mock.calls[0][0]);
    expect(output.relayConfig).toBeUndefined();
    expect(output.peerConfigs["github-runner"]).toContain(
      "PrivateKey = runner-private-key-from-peer-host",
    );
    expect(output.peerConfigs["win10-vm"]).toBeUndefined();
  });

  it("uses real public keys from an operator-local plan file when rendering configs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vem-maintenance-relay-"));
    try {
      const planPath = join(tempDir, "relay-plan.json");
      const publicKeys = {
        relay: wireGuardPublicKey(11),
        runner: wireGuardPublicKey(12),
        machine: wireGuardPublicKey(13),
      };
      const plan = buildDefaultMaintenanceRelayPlan();
      plan.peers = plan.peers.map((peer) => ({
        ...peer,
        publicKey:
          peer.name === "relay"
            ? publicKeys.relay
            : peer.name === "github-runner"
              ? publicKeys.runner
              : publicKeys.machine,
      }));
      writeFileSync(planPath, JSON.stringify(plan, null, 2));

      const stdout = { write: vi.fn() };
      await runMaintenanceRelayCli(["--plan-file", planPath], {
        env: {
          WG_RELAY_PRIVATE_KEY: "relay-private-key-from-env",
          WG_RUNNER_PRIVATE_KEY: "runner-private-key-from-env",
          WG_MACHINE_PRIVATE_KEY: "machine-private-key-from-env",
        },
        stdout,
        stderr: { write: vi.fn() },
      });

      const output = JSON.parse(stdout.write.mock.calls[0][0]);
      expect(output.peers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "relay",
            publicKey: publicKeys.relay,
          }),
          expect.objectContaining({
            name: "github-runner",
            publicKey: publicKeys.runner,
          }),
          expect.objectContaining({
            name: "win10-vm",
            publicKey: publicKeys.machine,
          }),
        ]),
      );
      expect(output.relayConfig).toContain(`PublicKey = ${publicKeys.runner}`);
      expect(output.relayConfig).toContain(`PublicKey = ${publicKeys.machine}`);
      expect(output.peerConfigs["github-runner"]).toContain(
        `PublicKey = ${publicKeys.relay}`,
      );
      expect(output.peerConfigs["win10-vm"]).toContain(
        `PublicKey = ${publicKeys.relay}`,
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("parses unsafe plan overrides so repository checks can fail closed", () => {
    expect(() =>
      parseMaintenanceRelayCliOptions(["--session-port", "3389"], {}),
    ).toThrow("Unsupported maintenance session port: 3389");
  });
});
