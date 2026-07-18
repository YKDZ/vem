import { describe, expect, it } from "vitest";

import {
  effectiveMachineRuntimeConfigurationSchema,
  provisioningProfileCacheSchema,
  runtimeBootstrapSchema,
  setScannerProtocolParametersRequestSchema,
} from "./runtime-configuration";

describe("Runtime Bootstrap contract", () => {
  it("accepts only the deployment-owned claim entry and machine expectations", () => {
    expect(
      runtimeBootstrapSchema.parse({
        schemaVersion: 1,
        provisioningApiBaseUrl: "https://service.example/api",
        hardwareModel: "vem-prod-24",
        topology: { identity: "vem-prod-24", version: "v1" },
      }),
    ).toMatchObject({ schemaVersion: 1, hardwareModel: "vem-prod-24" });

    expect(
      runtimeBootstrapSchema.safeParse({
        schemaVersion: 1,
        provisioningApiBaseUrl: "https://service.example/api",
        hardwareModel: "vem-prod-24",
        topology: { identity: "vem-prod-24", version: "v1" },
        environment: "testbed",
      }).success,
    ).toBe(false);
  });
});

describe("Provisioning Profile Cache contract", () => {
  it("requires a generation so crash recovery can never join unrelated credentials", () => {
    expect(
      provisioningProfileCacheSchema.safeParse({
        schemaVersion: 1,
        acceptedAt: "2026-07-17T00:00:00.000Z",
        profile: {},
      }).success,
    ).toBe(false);
  });

  it("cannot retain claim credentials", () => {
    expect(
      provisioningProfileCacheSchema.safeParse({
        schemaVersion: 1,
        acceptedAt: "2026-07-17T00:00:00.000Z",
        profile: {
          machine: {
            id: "550e8400-e29b-41d4-a716-446655440001",
            code: "VEM-TESTBED-01",
            name: "Testbed",
            status: "offline",
            locationLabel: null,
          },
          credentials: { machineSecret: "must-not-persist" },
        },
      }).success,
    ).toBe(false);
  });
});

describe("Effective Machine Runtime Configuration contract", () => {
  it("projects adopted configuration by domain without device observations", () => {
    const schema = JSON.stringify(
      effectiveMachineRuntimeConfigurationSchema.toJSONSchema(),
    );

    for (const group of [
      "sourceRevisions",
      "machine",
      "platform",
      "hardware",
      "experience",
      "secretStatus",
    ]) {
      expect(schema).toContain(group);
    }
    expect(schema).not.toContain("currentPort");
    expect(schema).not.toContain("connectivity");
  });
});

describe("Scanner protocol intent contract", () => {
  it("preserves null as an explicit clear of the local scanner override", () => {
    expect(setScannerProtocolParametersRequestSchema.parse(null)).toBeNull();
  });
});
