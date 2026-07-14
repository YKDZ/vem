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
      machineAudioVolume: 0.7,
      audioCueSettings: {
        enabled: false,
        categories: {
          presence: false,
          transaction: false,
        },
      },
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
        restoredTransaction: null,
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
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("fails closed when daemon is available but its bring-up projection is unavailable", () => {
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
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("routes incomplete daemon bring-up to the bring-up console", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        bringUp: {
          state: "claim_required",
          blockingReasons: [
            {
              code: "CLAIM_REQUIRED",
              component: "provisioning",
              message:
                "machine must be claimed before runtime profile can be applied",
            },
          ],
          diagnostics: [],
          readinessLevel: "not_ready",
          hardwareMode: "production",
          allowedActions: {
            configureNetwork: false,
            claimMachine: true,
            retryClaim: false,
            syncProfile: false,
            resolveTopology: false,
            runRuntimeAcceptance: false,
            runHardwareAcceptance: false,
            attestStock: false,
            startSales: false,
          },
          currentTask: {
            contractVersion: 1,
            kind: "claim_machine",
            intent: "claim_machine",
            rotateMaintenanceIdentity: false,
            projection: {
              type: "claim_code",
              rotateMaintenanceIdentity: false,
            },
          },
          progress: [
            { kind: "provisioning", status: "current", evidence: "durable" },
          ],
          updatedAt: "2026-07-04T00:00:00Z",
        },
        ready: null,
        restoredTransaction: null,
      }),
    ).toBe("/bring-up");
  });

  it("keeps a daemon-projected current task on the bring-up route even when legacy state is runtime-ready", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        bringUp: {
          state: "runtime_ready",
          blockingReasons: [],
          diagnostics: [],
          readinessLevel: "runtime_ready",
          hardwareMode: "production",
          allowedActions: {
            configureNetwork: false,
            claimMachine: false,
            retryClaim: false,
            syncProfile: false,
            resolveTopology: false,
            runRuntimeAcceptance: true,
            runHardwareAcceptance: false,
            attestStock: false,
            startSales: false,
          },
          currentTask: {
            contractVersion: 1,
            kind: "run_hardware_acceptance",
            intent: "open_maintenance",
            rotateMaintenanceIdentity: false,
            projection: {
              type: "hardware_acceptance",
              component: "hardware",
            },
          },
          progress: [
            { kind: "hardware", status: "current", evidence: "volatile" },
          ],
          updatedAt: "2026-07-14T00:00:00Z",
        },
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-07-14T00:00:00Z",
        },
        restoredTransaction: null,
      }),
    ).toBe("/bring-up");
  });

  it("uses daemon bring-up snapshot instead of local config-error inference", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: { ...healthBase, configConfigured: false },
        config: null,
        bringUp: {
          state: "sell_ready",
          blockingReasons: [],
          diagnostics: [],
          readinessLevel: "sell_ready",
          hardwareMode: "production",
          allowedActions: {
            configureNetwork: false,
            claimMachine: false,
            retryClaim: false,
            syncProfile: false,
            resolveTopology: false,
            runRuntimeAcceptance: true,
            runHardwareAcceptance: false,
            attestStock: false,
            startSales: true,
          },
          currentTask: null,
          progress: [],
          updatedAt: "2026-07-04T00:00:00Z",
        },
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
        restoredTransaction: null,
      }),
    ).toBe("/catalog");
  });

  it("fails closed when an old daemon omits the required bring-up projection", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        bringUp: null,
        ready: {
          ready: true,
          canSell: true,
          mode: "daemon",
          blockingCodes: [],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "catalog",
          updatedAt: "2026-07-14T00:00:00Z",
        },
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("routes payment", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        bringUp: {
          state: "sell_ready",
          blockingReasons: [],
          diagnostics: [],
          readinessLevel: "sell_ready",
          hardwareMode: "production",
          allowedActions: {
            configureNetwork: false,
            claimMachine: false,
            retryClaim: false,
            syncProfile: false,
            resolveTopology: false,
            runRuntimeAcceptance: true,
            runHardwareAcceptance: false,
            attestStock: false,
            startSales: true,
          },
          currentTask: null,
          progress: [],
          updatedAt: "2026-07-04T00:00:00Z",
        },
        ready: null,
        restoredTransaction: {
          orderId: "o",
          orderNo: "ord",
          productSummary: null,
          paymentId: null,
          paymentNo: null,
          paymentMethod: "qr_code",
          paymentProvider: "alipay",
          paymentUrl: "https://pay.example/ord",
          paymentStatus: "pending",
          orderStatus: "pending_payment",
          totalAmountCents: 100,
          vending: null,
          nextAction: "wait_payment",
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

  it("recovers an explicit restored transaction before startup fallbacks", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        bringUp: {
          state: "claim_required",
          blockingReasons: [
            {
              code: "CLAIM_REQUIRED",
              component: "provisioning",
              message:
                "machine must be claimed before runtime profile can be applied",
            },
          ],
          diagnostics: [],
          readinessLevel: "not_ready",
          hardwareMode: "production",
          allowedActions: {
            configureNetwork: false,
            claimMachine: true,
            retryClaim: false,
            syncProfile: false,
            resolveTopology: false,
            runRuntimeAcceptance: false,
            runHardwareAcceptance: false,
            attestStock: false,
            startSales: false,
          },
          currentTask: null,
          progress: [],
          updatedAt: "2026-07-04T00:00:00Z",
        },
        ready: {
          ready: false,
          canSell: false,
          mode: "maintenance",
          blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
          blockingReasons: [],
          degradedReasons: [],
          suggestedRoute: "maintenance",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        restoredTransaction: {
          orderId: "o",
          orderNo: "ord",
          productSummary: null,
          paymentId: null,
          paymentNo: null,
          paymentMethod: "qr_code",
          paymentProvider: "alipay",
          paymentUrl: "https://pay.example/ord",
          paymentStatus: "pending",
          orderStatus: "pending_payment",
          totalAmountCents: 100,
          vending: null,
          nextAction: "wait_payment",
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

  it("keeps active transaction recovery ahead of non-ready bring-up state", () => {
    const cases = [
      ["wait_payment", "/payment"],
      ["dispensing", "/dispensing"],
      [
        "refund_pending",
        { name: "result", params: { kind: "refund_pending" } },
      ],
    ] as const;

    for (const [nextAction, expectedRoute] of cases) {
      expect(
        routeForStartup({
          daemonAvailable: true,
          health: healthBase,
          config: configBase,
          bringUp: {
            state: "topology_mismatch",
            blockingReasons: [
              {
                code: "HARDWARE_SLOT_TOPOLOGY_MISMATCH",
                component: "topology",
                message:
                  "factory hardware slot topology does not match platform expectation",
              },
            ],
            diagnostics: [],
            readinessLevel: "not_ready",
            hardwareMode: "production",
            allowedActions: {
              configureNetwork: false,
              claimMachine: false,
              retryClaim: false,
              syncProfile: false,
              resolveTopology: true,
              runRuntimeAcceptance: false,
              runHardwareAcceptance: false,
              attestStock: false,
              startSales: false,
            },
            currentTask: null,
            progress: [],
            updatedAt: "2026-07-04T00:00:00Z",
          },
          ready: null,
          restoredTransaction: {
            orderId: "o",
            orderNo: "ord",
            productSummary: null,
            paymentId: null,
            paymentNo: null,
            paymentMethod: "qr_code",
            paymentProvider: "alipay",
            paymentUrl: "https://pay.example/ord",
            paymentStatus:
              nextAction === "wait_payment" ? "pending" : "succeeded",
            orderStatus:
              nextAction === "wait_payment"
                ? "pending_payment"
                : nextAction === "dispensing"
                  ? "dispensing"
                  : "refund_pending",
            totalAmountCents: 100,
            vending: null,
            nextAction,
            maskedAuthCode: null,
            paymentCodeAttempt: null,
            expiresAt: null,
            errorCode: null,
            errorMessage: null,
            operatorHint: null,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        }),
      ).toEqual(expectedRoute);
    }
  });

  it("routes dispensing", () => {
    expect(
      routeForStartup({
        daemonAvailable: true,
        health: healthBase,
        config: configBase,
        ready: null,
        restoredTransaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentId: null,
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
        restoredTransaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentId: null,
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
        restoredTransaction: {
          orderId: null,
          orderNo: "ord",
          productSummary: null,
          paymentId: null,
          paymentNo: null,
          paymentMethod: null,
          paymentProvider: null,
          paymentUrl: null,
          paymentStatus: null,
          orderStatus: null,
          totalAmountCents: null,
          vending: {
            commandId: null,
            commandNo: "cmd",
            status: "result_unknown",
            lastError: "unknown dispense result",
          },
          nextAction: "manual_handling",
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

  it("does not use an offline fallback without daemon bring-up", () => {
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
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
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
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
  });

  it("does not use a catalog fallback when bring-up is absent", () => {
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
        restoredTransaction: null,
      }),
    ).toBe("/maintenance");
  });
});
