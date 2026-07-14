import {
  daemonIpcTransactionSnapshotSchema,
  parseDaemonIpcTransactionSnapshotBoundary,
} from "@vem/shared";
import { describe, expect, it } from "vitest";

import {
  bringUpSnapshotSchema,
  configSummarySchema,
  daemonEventSchema,
  networkSettingsResponseSchema,
  naturalContextSnapshotSchema,
  scannerStatusSchema,
  transactionSnapshotSchema,
  type TransactionSnapshot,
} from "./schemas";

describe("daemon schemas", () => {
  const awaitingPaymentTransaction = {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-SCHEMA-001",
    productSummary: null,
    paymentId: "550e8400-e29b-41d4-a716-446655440011",
    paymentNo: "PAY-SCHEMA-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/qr",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 1200,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-11T06:20:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-11T06:16:32.320Z",
  };

  it("uses the shared Daemon IPC transaction snapshot boundary parser", () => {
    expect(transactionSnapshotSchema.parse).toBe(
      parseDaemonIpcTransactionSnapshotBoundary,
    );
  });

  it("keeps the Machine transaction snapshot type on the shared checkout action vocabulary", () => {
    const legalNextAction: TransactionSnapshot["nextAction"] = "wait_payment";
    expect(legalNextAction).toBe("wait_payment");

    // @ts-expect-error unknown daemon IPC checkout actions must not be assignable
    const invalidNextAction: TransactionSnapshot["nextAction"] = "please_guess";
    expect(invalidNextAction).toBe("please_guess");
  });

  it("validates awaiting-payment transaction snapshots with strict checkout vocabulary", () => {
    const parsed = transactionSnapshotSchema.parse(awaitingPaymentTransaction);

    expect(parsed.nextAction).toBe("wait_payment");
    expect(parsed.paymentMethod).toBe("qr_code");
    expect(parsed.paymentProvider).toBe("alipay");
    expect(parsed.paymentStatus).toBe("pending");
    expect(parsed.orderStatus).toBe("pending_payment");
  });

  it("validates legal shared checkout enum values", () => {
    const parsed = transactionSnapshotSchema.parse({
      ...awaitingPaymentTransaction,
      paymentMethod: "payment_code",
      paymentProvider: "wechat_pay",
      paymentStatus: "processing",
      orderStatus: "paid",
      vending: {
        commandId: "550e8400-e29b-41d4-a716-446655440012",
        commandNo: "CMD-SCHEMA-001",
        status: "acknowledged",
        lastError: null,
      },
      paymentCodeAttempt: {
        attemptNo: 1,
        status: "user_confirming",
        maskedAuthCode: "2876****4394",
        source: "tauri_scanner",
        idempotencyKey: "ORD-SCHEMA-001:attempt-1",
        submittedAt: "2026-06-11T06:16:30.000Z",
        lastCheckedAt: null,
        canRetry: false,
        message: null,
      },
    });

    expect(parsed.paymentMethod).toBe("payment_code");
    expect(parsed.paymentProvider).toBe("wechat_pay");
    expect(parsed.paymentStatus).toBe("processing");
    expect(parsed.orderStatus).toBe("paid");
    expect(parsed.vending?.status).toBe("acknowledged");
    expect(parsed.paymentCodeAttempt?.status).toBe("user_confirming");
    expect(parsed.paymentCodeAttempt?.source).toBe("tauri_scanner");
  });

  it("rejects transaction snapshots with an order credential and unknown next action", () => {
    expect(() =>
      transactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "please_guess",
      }),
    ).toThrow();
  });

  it("rejects transaction snapshots with an order credential and missing next action", () => {
    const { nextAction: _nextAction, ...missingNextAction } =
      awaitingPaymentTransaction;

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: null,
      }),
    ).not.toThrow();
    expect(() => transactionSnapshotSchema.parse(missingNextAction)).toThrow();
    expect(() =>
      transactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: null,
      }),
    ).toThrow();
  });

  it("rejects awaiting-payment transaction snapshots missing payment method or amount", () => {
    expect(() =>
      transactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        paymentMethod: null,
      }),
    ).toThrow();
    expect(() =>
      transactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        totalAmountCents: null,
      }),
    ).toThrow();
  });

  it("requires the no-current-transaction snapshot to include explicit null next action", () => {
    const { nextAction: _nextAction, ...noCurrentTransaction } = {
      ...awaitingPaymentTransaction,
      orderId: null,
      orderNo: null,
      paymentNo: null,
      paymentId: null,
      paymentMethod: null,
      paymentProvider: null,
      paymentUrl: null,
      paymentStatus: null,
      orderStatus: null,
      totalAmountCents: null,
      expiresAt: null,
    };
    expect(() =>
      transactionSnapshotSchema.parse(noCurrentTransaction),
    ).toThrow();

    const parsed = transactionSnapshotSchema.parse({
      ...noCurrentTransaction,
      nextAction: null,
    });

    expect(parsed.orderNo).toBeNull();
    expect(parsed.nextAction).toBeNull();
  });

  it("parses safe daemon-owned bring-up snapshot", () => {
    const parsed = bringUpSnapshotSchema.parse({
      state: "stock_attestation_required",
      readinessLevel: "not_ready",
      hardwareMode: "production",
      blockingReasons: [
        {
          code: "STOCK_ATTESTATION_REQUIRED",
          component: "stock",
          message: "physical stock attestation is required before sales",
        },
      ],
      diagnostics: [
        {
          code: "PUBLIC_CONFIG_PROFILE_APPLIED",
          component: "config",
          message: "local runtime has an applied provisioning profile",
        },
      ],
      allowedActions: {
        configureNetwork: false,
        claimMachine: false,
        retryClaim: false,
        syncProfile: false,
        resolveTopology: false,
        runRuntimeAcceptance: true,
        runHardwareAcceptance: false,
        attestStock: true,
        startSales: false,
      },
      currentTask: {
        contractVersion: 1,
        kind: "attest_stock",
        intent: "record_stock",
        rotateMaintenanceIdentity: false,
        projection: {
          type: "stock_attestation",
          entryMode: "final_actual_quantities",
        },
      },
      progress: [
        {
          kind: "provisioning",
          status: "completed",
          evidence: "durable",
        },
        {
          kind: "stock",
          status: "current",
          evidence: "durable",
        },
      ],
      updatedAt: "2026-07-04T00:00:00Z",
    });

    expect(parsed.state).toBe("stock_attestation_required");
    expect(parsed.currentTask).toEqual({
      contractVersion: 1,
      kind: "attest_stock",
      intent: "record_stock",
      rotateMaintenanceIdentity: false,
      projection: {
        type: "stock_attestation",
        entryMode: "final_actual_quantities",
      },
    });
    expect(parsed.progress?.[0]).toMatchObject({
      kind: "provisioning",
      status: "completed",
      evidence: "durable",
    });
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("fails closed when a daemon omits the versioned task projection", () => {
    expect(() =>
      bringUpSnapshotSchema.parse({
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
          runRuntimeAcceptance: false,
          runHardwareAcceptance: false,
          attestStock: false,
          startSales: true,
        },
        updatedAt: "2026-07-14T00:00:00Z",
      }),
    ).toThrow();
  });

  it("parses Protected Network Settings response without password fields", () => {
    const parsed = networkSettingsResponseSchema.parse({
      status: "unsupported",
      ssid: "Venue-Guest",
      hidden: false,
      diagnostics: [
        {
          component: "local_network",
          level: "warn",
          code: "INTERACTIVE_LOGIN_NETWORK_UNSUPPORTED",
          message:
            "Network appears to require captive portal or other interactive login",
        },
      ],
      operatorGuidance:
        "该网络需要网页登录或其他交互式认证，当前 Protected Network Settings 不支持。",
      updatedAt: "2026-07-04T00:00:00Z",
    });

    expect(parsed.status).toBe("unsupported");
    expect(JSON.stringify(parsed)).not.toContain("password");
  });

  it("parses scanner event and keeps masked code only", () => {
    const fixture = {
      type: "scanner_code",
      eventId: "evt-1",
      maskedCode: "6212****9012",
      source: "serial_text",
      scannedAtMs: 1700000000000,
      updatedAt: "2026-01-01T00:00:00Z",
    };

    const parsed = daemonEventSchema.parse(fixture as never);
    expect(parsed.type).toBe("scanner_code");
    if ("known" in parsed || parsed.type !== "scanner_code") {
      throw new Error("expected scanner_code event");
    }
    expect(parsed.maskedCode).toBe("6212****9012");
    expect((parsed as { maskedCode: string; authCode?: string }).authCode).toBe(
      undefined,
    );
  });

  it("parses scanner status and health change event", () => {
    const parsed = scannerStatusSchema.parse({
      online: false,
      adapter: "serial_text",
      port: "COM4",
      level: "offline",
      code: "SCANNER_OPEN_FAILED",
      message: "open scanner serial failed: Access denied",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed.code).toBe("SCANNER_OPEN_FAILED");
    expect(() =>
      scannerStatusSchema.parse({
        ...parsed,
        extraDaemonField: true,
      }),
    ).toThrow();

    const event = daemonEventSchema.parse({
      type: "scanner_health_changed",
      eventId: "evt-health-1",
      updatedAt: "2026-01-01T00:00:00Z",
      snapshot: parsed,
    } as never);
    expect(event.type).toBe("scanner_health_changed");
  });

  it("uses the shared forward-compatible daemon event notification contract", () => {
    const runtimeReconfigureEvent = daemonEventSchema.parse({
      type: "runtime_reconfigure_requested",
      eventId: "evt-runtime-1",
      updatedAt: "2026-01-01T00:00:00Z",
      reason: "config_updated",
      machineCode: "MACHINE-SCHEMA",
    });
    expect(runtimeReconfigureEvent.type).toBe("runtime_reconfigure_requested");

    const unknownEvent = daemonEventSchema.parse({
      type: "future_runtime_signal",
      eventId: "evt-future-1",
      updatedAt: "2026-01-01T00:00:00Z",
      diagnostic: { source: "future-daemon" },
    });
    expect(unknownEvent).toMatchObject({
      type: "future_runtime_signal",
      known: false,
    });
  });

  it("parses daemon-owned Natural Context Projection", () => {
    const parsed = naturalContextSnapshotSchema.parse({
      status: "unconfigured",
      machineCode: "MACHINE-NATURAL",
      checkedAt: "2026-06-30T14:00:00.000Z",
      degraded: true,
      customerFacingBlocked: false,
      externalEnvironment: {
        status: "unconfigured",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "MACHINE-NATURAL",
        checkedAt: "2026-06-30T14:00:00.000Z",
        weather: {
          status: "unconfigured",
          weatherConditionClasses: [],
          primaryWeatherConditionClass: null,
          diagnostic: {
            reason: "machine_geo_location_missing",
            message: "Machine Geo Location is not configured",
          },
        },
        sun: {
          status: "unconfigured",
          diagnostic: {
            reason: "machine_geo_location_missing",
            message: "Machine Geo Location is not configured",
          },
        },
        calendar: {
          status: "unconfigured",
          festivals: [],
          primaryFestival: null,
          solarTerm: null,
          diagnostic: {
            reason: "machine_geo_timezone_missing",
            message: "Machine Geo Time Zone is not configured",
          },
        },
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      },
      localSiteSignals: {
        status: "ok",
        temperatureCelsius: 24,
        humidityRh: 50,
        sampledAt: "2026-06-30T14:00:00.000Z",
      },
    });

    expect(parsed.status).toBe("unconfigured");
    expect(parsed.degraded).toBe(true);
    expect(parsed.customerFacingBlocked).toBe(false);
    expect(parsed.externalEnvironment.status).toBe("unconfigured");
    expect(parsed.localSiteSignals.temperatureCelsius).toBe(24);
  });

  it("parses daemon config summary with stock movement retention days", () => {
    const parsed = configSummarySchema.parse({
      public: {
        machineCode: "MACHINE-1",
        apiBaseUrl: "http://localhost:3000/api",
        mqttUrl: "mqtt://localhost:1883",
        mqttUsername: null,
        hardwareAdapter: "mock",
        serialPortPath: null,
        lowerControllerUsbIdentity: null,
        scannerAdapter: "disabled",
        scannerSerialPortPath: null,
        scannerBaudRate: 9600,
        scannerFrameSuffix: "crlf",
        visionEnabled: true,
        visionWsUrl: "ws://127.0.0.1:7892/ws",
        visionRequestTimeoutMs: 8000,
        machineAudioVolume: 0.35,
        kioskMode: false,
        stockMovementRetentionDays: 90,
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
    });

    expect(parsed.public.stockMovementRetentionDays).toBe(90);
    expect(parsed.public.machineAudioVolume).toBe(0.35);
    expect(parsed.public.audioCueSettings).toEqual({
      enabled: false,
      categories: {
        presence: false,
        transaction: false,
      },
    });
    expect(parsed.public).not.toHaveProperty("tryOnCameraDeviceId");
    expect(parsed.public).not.toHaveProperty("tryOnCameraLabel");
  });

  it("migrates legacy daemon presence audio config into audio cue settings", () => {
    const parsed = configSummarySchema.parse({
      public: {
        machineCode: "MACHINE-1",
        apiBaseUrl: "http://localhost:3000/api",
        mqttUrl: "mqtt://localhost:1883",
        mqttUsername: null,
        hardwareAdapter: "mock",
        serialPortPath: null,
        lowerControllerUsbIdentity: null,
        scannerAdapter: "disabled",
        scannerSerialPortPath: null,
        scannerBaudRate: 9600,
        scannerFrameSuffix: "crlf",
        visionEnabled: true,
        visionWsUrl: "ws://127.0.0.1:7892/ws",
        visionRequestTimeoutMs: 8000,
        presenceAudioEnabled: true,
        kioskMode: false,
        stockMovementRetentionDays: 90,
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
    });

    expect(parsed.public.audioCueSettings).toEqual({
      enabled: true,
      categories: {
        presence: true,
        transaction: false,
      },
    });
    expect("presenceAudioEnabled" in parsed.public).toBe(false);
  });

  it("parses transaction attempt summary and restricted scanner adapter config", () => {
    const tx = transactionSnapshotSchema.parse({
      orderId: "550e8400-e29b-41d4-a716-446655440010",
      orderNo: "ORD-001",
      productSummary: null,
      paymentId: "550e8400-e29b-41d4-a716-446655440013",
      paymentNo: "PAY-001",
      paymentMethod: "payment_code",
      paymentProvider: "alipay",
      paymentUrl: null,
      paymentStatus: "pending",
      orderStatus: "pending_payment",
      totalAmountCents: 100,
      vending: {
        commandId: "550e8400-e29b-41d4-a716-446655440014",
        commandNo: "CMD-001",
        status: "sent",
        lastError: null,
        pickupReminder: {
          stage: "pickup_timeout_warning",
          level: "warning",
          message: "请尽快取走商品",
          warningNo: 1,
          reportedAt: "2026-06-13T09:00:00.000Z",
          remainingSeconds: 12,
        },
      },
      nextAction: "wait_payment",
      maskedAuthCode: "2876****4394",
      paymentCodeAttempt: {
        attemptNo: 2,
        status: "failed",
        maskedAuthCode: "2876****4394",
        source: "serial_text",
        idempotencyKey: "ORD001:abc",
        submittedAt: null,
        lastCheckedAt: null,
        canRetry: true,
        message: "请刷新付款码后重试",
      },
      expiresAt: null,
      errorCode: null,
      errorMessage: null,
      operatorHint: "请刷新付款码后重试",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(tx.vending?.pickupReminder?.message).toBe("请尽快取走商品");
    expect(tx.vending?.pickupReminder?.stage).toBe("pickup_timeout_warning");
    expect(tx.vending?.pickupReminder?.remainingSeconds).toBe(12);
    expect(tx.paymentCodeAttempt?.source).toBe("serial_text");

    expect(() =>
      configSummarySchema.parse({
        public: {
          machineCode: null,
          apiBaseUrl: "http://localhost:3000/api",
          mqttUrl: "mqtt://localhost:1883",
          mqttUsername: null,
          hardwareAdapter: "mock",
          serialPortPath: null,
          scannerAdapter: "web_serial_dev",
          scannerSerialPortPath: null,
          scannerBaudRate: 9600,
          scannerFrameSuffix: "crlf",
          visionEnabled: true,
          visionWsUrl: "ws://127.0.0.1:7892/ws",
          visionRequestTimeoutMs: 8000,
          kioskMode: false,
        },
        machineSecretConfigured: false,
        mqttSigningSecretConfigured: false,
        mqttPasswordConfigured: false,
      }),
    ).toThrow();
  });
});
