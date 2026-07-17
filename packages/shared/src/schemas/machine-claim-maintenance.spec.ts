import { describe, expect, it } from "vitest";

import {
  machineClaimRequestSchema,
  machineProvisioningMaintenanceIdentitySchema,
  machineProvisioningProfileSchema,
} from "./machines";

const PUBLIC_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const RELAY_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";

const validMaintenanceIdentity = () => ({
  publicKey: PUBLIC_KEY,
  tunnelAddress: "10.91.16.10",
  address: "10.91.16.10/32",
  endpoint: "relay.example:51820",
  relay: {
    publicKey: RELAY_KEY,
    tunnelAddress: "10.91.0.1",
    address: "10.91.0.1/32",
  },
  roleRoutes: {
    relay: "10.91.0.1/32",
    runner: "10.91.1.0/24",
    maintainer: "10.91.3.0/24",
  },
});

describe("Machine claim and maintenance identity contracts", () => {
  it("keeps claim input narrow while provisioning uses the shared generated source", () => {
    expect(
      machineClaimRequestSchema.parse({
        claimCode: "abcd-2345",
      }),
    ).toEqual({
      claimCode: "ABCD-2345",
    });

    const profile = machineProvisioningProfileSchema.parse({
      machine: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        code: "VEM-TESTBED-01",
        name: "Testbed",
        status: "offline",
        locationLabel: null,
      },
      credentials: {
        machineSecret: "m".repeat(32),
        machineSecretVersion: 2,
        mqttSigningSecret: "s".repeat(32),
        mqttConnection: { url: "mqtt://127.0.0.1:1883", clientId: "m-1" },
      },
      apiBaseUrl: "https://service.example/api",
      runtimeEndpoints: {
        apiBasePath: "/api",
        machineAuthTokenPath: "/api/machine-auth/token",
        machineApiBasePath: "/api/machines/VEM-TESTBED-01",
        mqttTopicPrefix: "vem/machines/VEM-TESTBED-01",
      },
      hardwareProfile: {
        profile: "production",
        controller: { required: true, protocol: "vem-vending-controller" },
        paymentScanner: { required: true, supportsPaymentCode: true },
        vision: { required: false, supportsRecommendations: true },
      },
      hardwareModel: "vem-prod-24",
      hardwareSlotTopology: { identity: "vem-prod-24", version: "v1" },
      paymentCapability: {
        profile: "production",
        qrCodeEnabled: true,
        paymentCodeEnabled: true,
        serverTime: "2026-07-10T00:00:00.000Z",
      },
      metadata: {
        profileVersion: 1,
        profileRevision: 2,
        claimCodeId: "550e8400-e29b-41d4-a716-446655440002",
        claimedAt: "2026-07-10T00:00:00.000Z",
        serverTime: "2026-07-10T00:00:00.000Z",
      },
    });

    expect(profile.credentials.machineSecretVersion).toBe(2);
    expect(profile.hardwareProfile.vision.supportsRecommendations).toBe(true);
  });

  it("rejects every retired maintenance and profile-selection claim field", () => {
    expect(
      machineClaimRequestSchema.safeParse({
        claimCode: "abcd-2345",
        maintenancePublicKey: PUBLIC_KEY,
        provisioningProfile: "testbed",
        maintenanceRotation: "rotate",
      }).success,
    ).toBe(false);
  });

  it("allows Runtime Bootstrap to submit only a normalized claim code", () => {
    expect(
      machineClaimRequestSchema.parse({
        claimCode: "abcd-2345",
      }),
    ).toEqual({ claimCode: "ABCD-2345" });
  });

  it("binds machine and relay /32 addresses to their tunnel addresses", () => {
    expect(
      machineProvisioningMaintenanceIdentitySchema.safeParse({
        ...validMaintenanceIdentity(),
        address: "10.91.16.11/32",
      }).success,
    ).toBe(false);
    expect(
      machineProvisioningMaintenanceIdentitySchema.safeParse({
        ...validMaintenanceIdentity(),
        relay: {
          ...validMaintenanceIdentity().relay,
          address: "10.91.0.2/32",
        },
      }).success,
    ).toBe(false);
  });

  it("carries the authoritative pending reclaim expiry in the returned identity", () => {
    expect(
      machineProvisioningMaintenanceIdentitySchema.parse({
        publicKey: PUBLIC_KEY,
        tunnelAddress: "10.91.16.10",
        address: "10.91.16.10/32",
        endpoint: "relay.example:51820",
        relay: {
          publicKey: RELAY_KEY,
          tunnelAddress: "10.91.0.1",
          address: "10.91.0.1/32",
        },
        roleRoutes: {
          relay: "10.91.0.1/32",
          runner: "10.91.1.0/24",
          maintainer: "10.91.3.0/24",
        },
        reclaimExpiresAt: "2026-07-10T12:05:00.000Z",
      }).reclaimExpiresAt,
    ).toBe("2026-07-10T12:05:00.000Z");
  });

  it.each([
    ["default route", { runner: "0.0.0.0/0" }],
    ["broad route", { maintainer: "10.0.0.0/8" }],
    ["invalid CIDR", { runner: "10.91.999.0/24" }],
    ["host bits", { maintainer: "10.91.3.7/24" }],
    ["machine overlap", { runner: "10.91.16.0/24" }],
    ["role overlap", { maintainer: "10.91.1.0/24" }],
    ["wrong relay route", { relay: "10.91.0.2/32" }],
  ])("rejects %s in maintenance role routes", (_label, roleRouteOverride) => {
    const identity = validMaintenanceIdentity();
    expect(
      machineProvisioningMaintenanceIdentitySchema.safeParse({
        ...identity,
        roleRoutes: {
          ...identity.roleRoutes,
          ...roleRouteOverride,
        },
      }).success,
    ).toBe(false);
  });
});
