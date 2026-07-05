import { describe, expect, it, vi } from "vitest";

import {
  parseCliOptions,
  prepareEphemeralPlatformStack,
  type EphemeralPlatformStackRepository,
} from "./prepare-ephemeral-platform-stack.cli";

function repositoryFixture(): EphemeralPlatformStackRepository {
  return {
    prepareRun: vi.fn().mockResolvedValue({
      machine: {
        id: "machine-1",
        code: "VEM-TESTBED-ACCEPT-RUN-179",
        created: true,
      },
      claim: {
        id: "claim-1",
        claimCode: "ABCD-2345",
        expiresAt: new Date("2026-07-04T00:10:00.000Z"),
        closedClaimCodeIds: [],
      },
      hardwareSlotTopology: {
        identity: "vem-prod-24",
        version: "2026-06-adr0026",
        slots: [
          {
            slotCode: "A1",
            layerNo: 1,
            cellNo: 1,
            capacity: 8,
          },
          {
            slotCode: "A2",
            layerNo: 1,
            cellNo: 2,
            capacity: 8,
          },
        ],
      },
      products: [
        {
          productId: "product-1",
          variantId: "variant-1",
          sku: "TB-RUN-179-A1",
          name: "Testbed Socks A1",
          priceCents: 3900,
        },
        {
          productId: "product-2",
          variantId: "variant-2",
          sku: "TB-RUN-179-A2",
          name: "Testbed Socks A2",
          priceCents: 4900,
        },
      ],
      planogram: {
        planogramVersion: "TESTBED-RUN-179",
        status: "published",
        slotCount: 2,
        inventory: [
          {
            slotCode: "A1",
            inventoryId: "inventory-1",
            onHandQty: 3,
            lowStockThreshold: 1,
          },
          {
            slotCode: "A2",
            inventoryId: "inventory-2",
            onHandQty: 3,
            lowStockThreshold: 1,
          },
        ],
      },
      payment: {
        ready: true,
        mockProviderStatus: "enabled",
        serviceRequiresPaymentMockEnabled: true,
        runtimePaymentMockEnabled: true,
        mockPaymentAcknowledged: true,
      },
    }),
  };
}

describe("prepareEphemeralPlatformStack", () => {
  it("prepares run-scoped testbed machine data and emits structured setup evidence", async () => {
    const repository = repositoryFixture();

    const result = await prepareEphemeralPlatformStack(repository, {
      runId: "run-179",
      machineCodePrefix: "VEM-TESTBED-ACCEPT",
      databaseUrl: "postgres://test",
      apiBaseUrl: "http://127.0.0.1:3000/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      reset: true,
      now: new Date("2026-07-04T00:00:00.000Z"),
    });

    expect(repository.prepareRun).toHaveBeenCalledWith({
      runId: "RUN-179",
      machineCode: "VEM-TESTBED-ACCEPT-RUN-179",
      reset: true,
      now: new Date("2026-07-04T00:00:00.000Z"),
      prepareMockPayment: false,
    });
    expect(result).toEqual({
      runId: "RUN-179",
      preparedAt: "2026-07-04T00:00:00.000Z",
      stack: {
        apiBaseUrl: "http://127.0.0.1:3000/api",
        mqttUrl: "mqtt://127.0.0.1:1883",
        databaseTarget: "explicit",
      },
      testbedMachine: {
        id: "machine-1",
        code: "VEM-TESTBED-ACCEPT-RUN-179",
        created: true,
        claim: {
          claimCode: "ABCD-2345",
          claimCodeId: "claim-1",
          expiresAt: "2026-07-04T00:10:00.000Z",
          path: "/api/machines/claim",
          closedClaimCodeIds: [],
        },
      },
      hardwareSlotTopology: {
        identity: "vem-prod-24",
        version: "2026-06-adr0026",
        slots: [
          { slotCode: "A1", layerNo: 1, cellNo: 1, capacity: 8 },
          { slotCode: "A2", layerNo: 1, cellNo: 2, capacity: 8 },
        ],
      },
      seededData: {
        products: [
          {
            productId: "product-1",
            variantId: "variant-1",
            sku: "TB-RUN-179-A1",
            name: "Testbed Socks A1",
            priceCents: 3900,
          },
          {
            productId: "product-2",
            variantId: "variant-2",
            sku: "TB-RUN-179-A2",
            name: "Testbed Socks A2",
            priceCents: 4900,
          },
        ],
        planogram: {
          planogramVersion: "TESTBED-RUN-179",
          status: "published",
          slotCount: 2,
        },
        stockSetup: [
          {
            slotCode: "A1",
            inventoryId: "inventory-1",
            onHandQty: 3,
            lowStockThreshold: 1,
          },
          {
            slotCode: "A2",
            inventoryId: "inventory-2",
            onHandQty: 3,
            lowStockThreshold: 1,
          },
        ],
        paymentReadiness: {
          ready: false,
          mockProviderStatus: "not_prepared",
          serviceRequiresPaymentMockEnabled: true,
          runtimePaymentMockEnabled: false,
          mockPaymentAcknowledged: false,
        },
      },
      verificationPaths: {
        provisioningClaim: "/api/machines/claim",
        machineAuthToken: "/api/machine-auth/token",
        publishedPlanogram:
          "/api/machines/VEM-TESTBED-ACCEPT-RUN-179/planogram-versions/published",
        planogramAck:
          "/api/machines/VEM-TESTBED-ACCEPT-RUN-179/planogram-versions/TESTBED-RUN-179/ack",
        stockSnapshot:
          "/api/machines/VEM-TESTBED-ACCEPT-RUN-179/stock-snapshot",
        machineOrders: "/api/machine-orders",
      },
    });
  });

  it("rejects machine code prefixes outside the testbed namespace", async () => {
    const repository = repositoryFixture();

    await expect(
      prepareEphemeralPlatformStack(repository, {
        runId: "run-179",
        machineCodePrefix: "VEM-WIN10-REAL",
        databaseUrl: "postgres://test",
        apiBaseUrl: "http://127.0.0.1:3000/api",
        mqttUrl: "mqtt://127.0.0.1:1883",
      }),
    ).rejects.toThrow(/Refusing to prepare non-testbed machine identity/);

    expect(repository.prepareRun).not.toHaveBeenCalled();
  });

  it("reports mock payment not ready without mutating the global provider when runtime mock mode is disabled", async () => {
    const repository = repositoryFixture();

    const result = await prepareEphemeralPlatformStack(repository, {
      runId: "run-179",
      machineCodePrefix: "VEM-TESTBED-ACCEPT",
      databaseUrl: "postgres://test",
      apiBaseUrl: "http://127.0.0.1:3000/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      allowMockPayment: true,
      runtimePaymentMockEnabled: false,
      now: new Date("2026-07-04T00:00:00.000Z"),
    });

    expect(repository.prepareRun).toHaveBeenCalledWith(
      expect.objectContaining({ prepareMockPayment: false }),
    );
    expect(result.seededData.paymentReadiness).toEqual({
      ready: false,
      mockProviderStatus: "not_prepared",
      serviceRequiresPaymentMockEnabled: true,
      runtimePaymentMockEnabled: false,
      mockPaymentAcknowledged: true,
    });
  });

  it("reports mock payment ready only when acknowledged and runtime mock mode is enabled", async () => {
    const repository = repositoryFixture();

    const result = await prepareEphemeralPlatformStack(repository, {
      runId: "run-179",
      machineCodePrefix: "VEM-TESTBED-ACCEPT",
      databaseUrl: "postgres://test",
      apiBaseUrl: "http://127.0.0.1:3000/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      allowMockPayment: true,
      runtimePaymentMockEnabled: true,
      now: new Date("2026-07-04T00:00:00.000Z"),
    });

    expect(repository.prepareRun).toHaveBeenCalledWith(
      expect.objectContaining({ prepareMockPayment: true }),
    );
    expect(result.seededData.paymentReadiness).toEqual({
      ready: true,
      mockProviderStatus: "enabled",
      serviceRequiresPaymentMockEnabled: true,
      runtimePaymentMockEnabled: true,
      mockPaymentAcknowledged: true,
    });
  });
});

describe("parseCliOptions", () => {
  const explicitSafeArgs = [
    "--run-id",
    "issue-179",
    "--machine-code-prefix=VEM-TESTBED-ACCEPT",
    "--database-url",
    "postgres://testbed:testbed@127.0.0.1:5432/vem_testbed_issue_179",
    "--api-base-url",
    "http://127.0.0.1:3000/api",
    "--mqtt-url",
    "mqtt://127.0.0.1:1883",
    "--allow-ephemeral-target",
    "--allow-mock-payment",
  ];

  it("rejects ambient env-only stack targets", () => {
    expect(() =>
      parseCliOptions([], {
        DATABASE_URL: "postgres://test",
        TESTBED_API_BASE_URL: "http://127.0.0.1:3000/api",
        MQTT_URL: "mqtt://127.0.0.1:1883",
        TESTBED_RUN_ID: "issue-179",
        TESTBED_MACHINE_CODE_PREFIX: "VEM-TESTBED-ACCEPT",
        PAYMENT_MOCK_ENABLED: "true",
      }),
    ).toThrow("--database-url is required");
  });

  it("requires non-default run id and explicit ephemeral target acknowledgement", () => {
    expect(() =>
      parseCliOptions(
        explicitSafeArgs.filter(
          (arg) => arg !== "--run-id" && arg !== "issue-179",
        ),
        { PAYMENT_MOCK_ENABLED: "true" },
      ),
    ).toThrow("--run-id is required");

    expect(() =>
      parseCliOptions(
        explicitSafeArgs.filter((arg) => arg !== "--allow-ephemeral-target"),
        { PAYMENT_MOCK_ENABLED: "true" },
      ),
    ).toThrow("--allow-ephemeral-target is required");
  });

  it("rejects known production and VPS-looking targets", () => {
    expect(() =>
      parseCliOptions(
        explicitSafeArgs.map((arg) =>
          arg === "mqtt://127.0.0.1:1883"
            ? "mqtt://118.25.104.160:1883"
            : arg,
        ),
        { PAYMENT_MOCK_ENABLED: "true" },
      ),
    ).toThrow(/Refusing known production or VPS target/);

    expect(() =>
      parseCliOptions(
        explicitSafeArgs.map((arg) =>
          arg ===
          "postgres://testbed:testbed@127.0.0.1:5432/vem_testbed_issue_179"
            ? "postgres://vem:secret@db.example.com:5432/vem"
            : arg,
        ),
        { PAYMENT_MOCK_ENABLED: "true" },
      ),
    ).toThrow(/Refusing known production or VPS target/);
  });

  it("requires explicit mock-payment acknowledgement and matching runtime readiness", () => {
    expect(() =>
      parseCliOptions(
        explicitSafeArgs.filter((arg) => arg !== "--allow-mock-payment"),
        { PAYMENT_MOCK_ENABLED: "true" },
      ),
    ).toThrow("--allow-mock-payment is required");

    expect(
      parseCliOptions(explicitSafeArgs, { PAYMENT_MOCK_ENABLED: "false" }),
    ).toMatchObject({
      allowMockPayment: true,
      runtimePaymentMockEnabled: false,
    });
  });

  it("parses run id, explicit stack targets, reset, and output", () => {
    expect(
      parseCliOptions(
        [
          "--run-id",
          "issue-179",
          "--machine-code-prefix=VEM-TESTBED-ACCEPT",
          "--database-url",
          "postgres://testbed:testbed@127.0.0.1:5432/vem_testbed_issue_179",
          "--api-base-url",
          "http://127.0.0.1:3000/api",
          "--mqtt-url",
          "mqtt://127.0.0.1:1883",
          "--allow-ephemeral-target",
          "--allow-mock-payment",
          "--reset",
          "--output",
          "/tmp/evidence.json",
        ],
        { PAYMENT_MOCK_ENABLED: "true" },
      ),
    ).toMatchObject({
      runId: "issue-179",
      machineCodePrefix: "VEM-TESTBED-ACCEPT",
      databaseUrl: "postgres://testbed:testbed@127.0.0.1:5432/vem_testbed_issue_179",
      apiBaseUrl: "http://127.0.0.1:3000/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      allowEphemeralTarget: true,
      allowMockPayment: true,
      runtimePaymentMockEnabled: true,
      reset: true,
      outputPath: "/tmp/evidence.json",
    });
  });
});
