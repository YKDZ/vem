import { describe, expect, it, vi } from "vitest";

import {
  parseMaintenanceRelayCliOptions,
  runMaintenanceRelayCli,
} from "./maintenance-relay.cli";

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

  it("parses unsafe plan overrides so repository checks can fail closed", () => {
    expect(() =>
      parseMaintenanceRelayCliOptions(["--session-port", "3389"], {}),
    ).toThrow("Unsupported maintenance session port: 3389");
  });
});
