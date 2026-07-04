import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MACHINE_CLAIM_CODE_TTL_SECONDS,
  DEFAULT_VEM_VPS_API_BASE_URL,
  DEFAULT_VEM_VPS_MQTT_URL,
  MAX_MACHINE_CLAIM_CODE_TTL_SECONDS,
  MIN_MACHINE_CLAIM_CODE_TTL_SECONDS,
  parseCliOptions,
  prepareVpsTestbedMachineIdentity,
  type TestbedMachinePreparationRepository,
} from "./prepare-vps-testbed-machine.cli";

function repositoryFixture(): TestbedMachinePreparationRepository {
  return {
    prepareMachineForFirstClaim: vi.fn().mockResolvedValue({
      machine: {
        id: "machine-1",
        code: "VEM-TESTBED-WINVM-01",
      },
      createdMachine: true,
      restoredMachine: false,
      closedClaimCodeIds: [],
      claimCode: {
        id: "claim-1",
        claimCode: "ABCD-2345",
        expiresAt: new Date("2026-07-04T00:10:00.000Z"),
      },
    }),
  };
}

describe("prepareVpsTestbedMachineIdentity", () => {
  it("creates a dedicated testbed machine identity and emits daemon claim inputs", async () => {
    const repository = repositoryFixture();

    const result = await prepareVpsTestbedMachineIdentity(repository, {
      machineCode: "VEM-TESTBED-WINVM-01",
      now: new Date("2026-07-04T00:00:00.000Z"),
    });

    expect(repository.prepareMachineForFirstClaim).toHaveBeenCalledWith({
      machineCode: "VEM-TESTBED-WINVM-01",
      name: "Machine Runtime Testbed WINVM 01",
      now: new Date("2026-07-04T00:00:00.000Z"),
    });
    expect(result).toEqual({
      machineCode: "VEM-TESTBED-WINVM-01",
      platformTarget: "vem-vps",
      apiBaseUrl: DEFAULT_VEM_VPS_API_BASE_URL,
      mqtt: {
        url: DEFAULT_VEM_VPS_MQTT_URL,
        clientId: "vem-machine-VEM-TESTBED-WINVM-01",
        topicPrefix: "vem/machines/VEM-TESTBED-WINVM-01",
      },
      claim: {
        claimCode: "ABCD-2345",
        claimCodeId: "claim-1",
        expiresAt: "2026-07-04T00:10:00.000Z",
        path: "daemon-ipc:/v1/provisioning/claim",
      },
      reset: {
        createdMachine: true,
        restoredMachine: false,
        closedClaimCodeIds: [],
        clearedExistingMachineCredentials: true,
      },
    });
  });

  it("resets an existing testbed identity and closes existing open claim codes before generating a replacement", async () => {
    const repository = repositoryFixture();
    vi.mocked(repository.prepareMachineForFirstClaim).mockResolvedValue({
      machine: {
        id: "machine-existing",
        code: "VEM-TESTBED-WINVM-01",
      },
      createdMachine: false,
      restoredMachine: false,
      closedClaimCodeIds: ["claim-active", "claim-stale"],
      claimCode: {
        id: "claim-1",
        claimCode: "ABCD-2345",
        expiresAt: new Date("2026-07-04T00:10:00.000Z"),
      },
    });

    const result = await prepareVpsTestbedMachineIdentity(repository, {
      machineCode: "VEM-TESTBED-WINVM-01",
      now: new Date("2026-07-04T00:00:00.000Z"),
    });

    expect(repository.prepareMachineForFirstClaim).toHaveBeenCalledWith({
      machineCode: "VEM-TESTBED-WINVM-01",
      name: "Machine Runtime Testbed WINVM 01",
      now: new Date("2026-07-04T00:00:00.000Z"),
    });
    expect(result.reset).toEqual({
      createdMachine: false,
      restoredMachine: false,
      closedClaimCodeIds: ["claim-active", "claim-stale"],
      clearedExistingMachineCredentials: true,
    });
  });

  it("reports when the repository restored a soft-deleted testbed identity", async () => {
    const repository = repositoryFixture();
    vi.mocked(repository.prepareMachineForFirstClaim).mockResolvedValue({
      machine: {
        id: "machine-soft-deleted",
        code: "VEM-TESTBED-WINVM-01",
      },
      createdMachine: false,
      restoredMachine: true,
      closedClaimCodeIds: [],
      claimCode: {
        id: "claim-1",
        claimCode: "ABCD-2345",
        expiresAt: new Date("2026-07-04T00:10:00.000Z"),
      },
    });

    const result = await prepareVpsTestbedMachineIdentity(repository, {
      machineCode: "VEM-TESTBED-WINVM-01",
      now: new Date("2026-07-04T00:00:00.000Z"),
    });

    expect(result.reset).toMatchObject({
      createdMachine: false,
      restoredMachine: true,
    });
  });

  it("emits MQTT username and password needed by daemon provisioning", async () => {
    const repository = repositoryFixture();

    const result = await prepareVpsTestbedMachineIdentity(repository, {
      machineCode: "VEM-TESTBED-WINVM-01",
      mqttUsername: "vem_mqtt",
      mqttPassword: "secret-password",
    });

    expect(result.mqtt).toMatchObject({
      username: "vem_mqtt",
      password: "secret-password",
    });
  });

  it("rejects MQTT username without password before touching repository state", async () => {
    const repository = repositoryFixture();

    await expect(
      prepareVpsTestbedMachineIdentity(repository, {
        machineCode: "VEM-TESTBED-WINVM-01",
        mqttUsername: "vem_mqtt",
      }),
    ).rejects.toThrow("MQTT_PASSWORD is required when MQTT_USERNAME is set");

    expect(repository.prepareMachineForFirstClaim).not.toHaveBeenCalled();
  });

  it("rejects real machine identities before touching repository state", async () => {
    const repository = repositoryFixture();

    await expect(
      prepareVpsTestbedMachineIdentity(repository, {
        machineCode: "VEM-WIN10-REAL-01",
      }),
    ).rejects.toThrow(/Refusing to prepare non-testbed machine identity/);

    expect(repository.prepareMachineForFirstClaim).not.toHaveBeenCalled();
  });
});

describe("parseCliOptions", () => {
  it("parses MQTT password from flags and environment", () => {
    expect(
      parseCliOptions(
        ["--mqtt-username", "flag-user", "--mqtt-password=flag-pass"],
        {
          DATABASE_URL: "postgres://test",
          MQTT_USERNAME: "env-user",
          MQTT_PASSWORD: "env-pass",
        },
      ),
    ).toMatchObject({
      mqttUsername: "flag-user",
      mqttPassword: "flag-pass",
    });
    expect(
      parseCliOptions([], {
        DATABASE_URL: "postgres://test",
        MQTT_USERNAME: "env-user",
        MQTT_PASSWORD: "env-pass",
      }),
    ).toMatchObject({
      mqttUsername: "env-user",
      mqttPassword: "env-pass",
    });
  });

  it("rejects MQTT username without password", () => {
    expect(() =>
      parseCliOptions([], {
        DATABASE_URL: "postgres://test",
        MQTT_USERNAME: "env-user",
      }),
    ).toThrow("MQTT_PASSWORD is required when MQTT_USERNAME is set");
  });

  it("parses claim-code TTL with the service min and max bounds", () => {
    expect(
      parseCliOptions(["--claim-code-ttl-seconds", "60"], {
        DATABASE_URL: "postgres://test",
      }).claimCodeTtlSeconds,
    ).toBe(MIN_MACHINE_CLAIM_CODE_TTL_SECONDS);
    expect(
      parseCliOptions(["--claim-code-ttl-seconds=3600"], {
        DATABASE_URL: "postgres://test",
      }).claimCodeTtlSeconds,
    ).toBe(MAX_MACHINE_CLAIM_CODE_TTL_SECONDS);
    expect(
      parseCliOptions([], {
        DATABASE_URL: "postgres://test",
      }).claimCodeTtlSeconds,
    ).toBe(DEFAULT_MACHINE_CLAIM_CODE_TTL_SECONDS);
  });

  it("rejects non-integer and out-of-range claim-code TTL values", () => {
    expect(() =>
      parseCliOptions(["--claim-code-ttl-seconds", "59"], {
        DATABASE_URL: "postgres://test",
      }),
    ).toThrow("MACHINE_CLAIM_CODE_TTL_SECONDS must be between 60 and 3600");
    expect(() =>
      parseCliOptions(["--claim-code-ttl-seconds", "3601"], {
        DATABASE_URL: "postgres://test",
      }),
    ).toThrow("MACHINE_CLAIM_CODE_TTL_SECONDS must be between 60 and 3600");
    expect(() =>
      parseCliOptions(["--claim-code-ttl-seconds", "60.5"], {
        DATABASE_URL: "postgres://test",
      }),
    ).toThrow("MACHINE_CLAIM_CODE_TTL_SECONDS must be an integer");
  });
});
