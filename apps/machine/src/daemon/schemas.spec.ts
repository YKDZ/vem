import { describe, expect, it } from "vitest";

import {
  configSummarySchema,
  daemonEventSchema,
  scannerStatusSchema,
  transactionSnapshotSchema,
} from "./schemas";

describe("daemon schemas", () => {
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
    if (parsed.type !== "scanner_code") {
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

    const event = daemonEventSchema.parse({
      type: "scanner_health_changed",
      eventId: "evt-health-1",
      updatedAt: "2026-01-01T00:00:00Z",
      snapshot: parsed,
    } as never);
    expect(event.type).toBe("scanner_health_changed");
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
        kioskMode: false,
        stockMovementRetentionDays: 90,
      },
      machineSecretConfigured: false,
      mqttSigningSecretConfigured: false,
      mqttPasswordConfigured: false,
    });

    expect(parsed.public.stockMovementRetentionDays).toBe(90);
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
      paymentNo: "PAY-001",
      paymentMethod: "payment_code",
      paymentProvider: "alipay",
      paymentUrl: null,
      paymentStatus: "pending",
      orderStatus: "waiting_payment",
      totalAmountCents: 100,
      vending: {
        commandNo: "CMD-001",
        status: "dispensing",
        lastError: null,
        pickupReminder: {
          level: "warning",
          message: "请尽快取走商品",
          warningNo: 1,
          reportedAt: "2026-06-13T09:00:00.000Z",
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
