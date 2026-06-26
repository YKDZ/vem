import { describe, expect, it } from "vitest";

import { routeForStartup } from "./startup";

describe("routeForStartup", () => {
  const healthBase = {
    status: "healthy" as const,
    process: {
      component: "daemon",
      level: "info",
      code: "ok",
      message: "ok",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    components: [],
    configConfigured: true,
    databaseOnline: true,
    backendOnline: true,
    mqttConnected: true,
    outboxSize: 0,
    outboxMax: 100,
    hardwareOnline: true,
    scannerOnline: true,
    visionOnline: true,
    remoteOpsActive: false,
    currentTransaction: null,
    operatorReason: "",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const configBase = {
    public: {
      machineCode: "M001",
      apiBaseUrl: "http://localhost:3000/api",
      mqttUrl: "mqtt://localhost:1883",
      mqttUsername: null,
      hardwareAdapter: "mock" as const,
      serialPortPath: null,
      lowerControllerUsbIdentity: null,
      scannerAdapter: "disabled" as const,
      scannerSerialPortPath: null,
      scannerBaudRate: 9600,
      scannerFrameSuffix: "crlf" as const,
      visionEnabled: true,
      visionWsUrl: "ws://127.0.0.1:7892/ws",
      visionRequestTimeoutMs: 8000,
      kioskMode: false,
      stockMovementRetentionDays: 30,
    },
    machineSecretConfigured: true,
    mqttSigningSecretConfigured: true,
    mqttPasswordConfigured: false,
    provisioned: true,
    provisioningIssues: [],
  };
  it("routes offline when daemon unavailable", () => {
    expect(
      routeForStartup({
        daemonAvailable: false,
        health: null,
        ready: null,
        transaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("routes maintenance when config missing", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: { ...healthBase, configConfigured: false },
        config: configBase,
        ready: null,
        transaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("routes provisioning when daemon is available but config summary is unavailable", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: null,
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: null,
      }),
    ).toBe("/provisioning");
  });

  it("routes payment", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        ready: null,
        transaction: {
          orderId: "o",
          orderNo: "ord",
          productSummary: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: null,
          nextAction: "submit_payment",
          maskedAuthCode: null,
          paymentCodeAttempt: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).toBe("/payment");
  });

  it("routes dispensing", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        ready: null,
        transaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: null,
          nextAction: "dispensing",
          maskedAuthCode: null,
          paymentCodeAttempt: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).toBe("/dispensing");
  });

  it("routes result", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: null,
          nextAction: "success",
          maskedAuthCode: null,
          paymentCodeAttempt: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).toMatchObject({ name: "result", params: { kind: "success" } });
  });

  it("routes unknown dispense result to manual handling", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: {
            commandNo: "cmd",
            status: "result_unknown",
            lastError: "unknown dispense result",
          },
          nextAction: "result_unknown",
          maskedAuthCode: null,
          paymentCodeAttempt: null,
          expiresAt: null,
          errorCode: null,
          errorMessage: null,
          operatorHint: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      }),
    ).toMatchObject({ name: "result", params: { kind: "manual_handling" } });
  });

  it("routes offline based on ready snapshot", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: { ...healthBase },
        config: configBase,
        ready: {
          ready: true,
          canSell: false,
          mode: "daemon",
          blockingCodes: ["mqtt"],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "offline",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: null,
      }),
    ).toBe("/offline");
  });

  it("routes maintenance when ready snapshot suggests maintenance", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: { ...healthBase },
        config: configBase,
        ready: {
          ready: false,
          canSell: false,
          mode: "maintenance",
          blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
          blockingReasons: [
            {
              code: "WHOLE_MACHINE_HARDWARE_FAULT",
              component: "hardware",
              message: "hardware fault",
            },
          ],
          degradedReasons: [],
          suggestedRoute: "maintenance",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("routes catalog by default when sell available", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        transaction: null,
      }),
    ).toBe("/catalog");
  });
});
