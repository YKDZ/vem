import { describe, expect, it } from "vitest";

import {
  daemonIpcCheckoutFlowActionSchema,
  daemonIpcEventNotificationSchema,
  daemonIpcDispenseProgressObservationStageSchema,
  daemonIpcPickupReminderSchema,
  daemonIpcTransactionSnapshotSchema,
  machineOrderStatusNextActionSchema,
} from ".";

describe("Daemon IPC Contract Area", () => {
  const awaitingPaymentTransaction = {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-IPC-001",
    productSummary: null,
    paymentNo: "PAY-IPC-001",
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

  it("publishes the strict Checkout Flow Action vocabulary", () => {
    expect(daemonIpcCheckoutFlowActionSchema.options).toEqual([
      "wait_payment",
      "dispensing",
      "success",
      "payment_failed",
      "payment_expired",
      "dispense_failed",
      "refund_pending",
      "refunded",
      "manual_handling",
      "closed",
    ]);

    expect(() =>
      daemonIpcCheckoutFlowActionSchema.parse("submit_payment"),
    ).toThrow();
    expect(() =>
      daemonIpcCheckoutFlowActionSchema.parse("collect_goods"),
    ).toThrow();
    expect(() =>
      daemonIpcCheckoutFlowActionSchema.parse("unsupported_checkout_action"),
    ).toThrow();
  });

  it("requires legal Checkout Flow Action for transaction snapshots with an order credential", () => {
    expect(
      daemonIpcTransactionSnapshotSchema.parse(awaitingPaymentTransaction)
        .nextAction,
    ).toBe("wait_payment");

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "submit_payment",
      }),
    ).toThrow();
    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "collect_goods",
      }),
    ).toThrow();
    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "unsupported_checkout_action",
      }),
    ).toThrow();
    expect(() => {
      const { nextAction: _nextAction, ...missingNextAction } =
        awaitingPaymentTransaction;
      return daemonIpcTransactionSnapshotSchema.parse(missingNextAction);
    }).toThrow();
  });

  it("rejects unknown fields in transaction snapshots and nested daemon-owned objects", () => {
    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        extraDaemonField: true,
      }),
    ).toThrow();

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "dispensing",
        vending: {
          commandNo: "CMD-IPC-001",
          status: "pending",
          lastError: null,
          extraVendingField: true,
        },
      }),
    ).toThrow();

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "dispensing",
        vending: {
          commandNo: "CMD-IPC-001",
          status: "pending",
          lastError: null,
          pickupReminder: {
            stage: "pickup_waiting",
            level: "warning",
            message: "Please collect goods",
            warningNo: 1,
            reportedAt: "2026-06-11T06:18:00.000Z",
            extraPickupReminderField: true,
          },
        },
      }),
    ).toThrow();

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        paymentMethod: "payment_code",
        paymentCodeAttempt: {
          attemptNo: 1,
          status: "pending",
          maskedAuthCode: "2876****4394",
          source: "tauri_scanner",
          idempotencyKey: "ORD-IPC-001:attempt-1",
          submittedAt: "2026-06-11T06:16:30.000Z",
          lastCheckedAt: null,
          canRetry: false,
          message: null,
          extraPaymentCodeAttemptField: true,
        },
      }),
    ).toThrow();
  });

  it("keeps the order-facing next action export as a compatibility alias", () => {
    expect(machineOrderStatusNextActionSchema).toBe(
      daemonIpcCheckoutFlowActionSchema,
    );
    expect(machineOrderStatusNextActionSchema.parse("success")).toBe("success");
  });

  it("separates protocol-backed dispense progress observations from checkout pickup reminders", () => {
    expect(daemonIpcDispenseProgressObservationStageSchema.options).toEqual([
      "outlet_opened",
      "pickup_waiting",
      "pickup_timeout_warning",
      "pickup_completed",
      "reset_completed",
    ]);

    expect(
      daemonIpcDispenseProgressObservationStageSchema.parse("reset_completed"),
    ).toBe("reset_completed");
    expect(() =>
      daemonIpcPickupReminderSchema.parse({
        stage: "reset_completed",
        level: "info",
        message: "device reset completed",
        warningNo: null,
        reportedAt: "2026-06-11T06:18:00.000Z",
      }),
    ).toThrow();
  });

  it("covers current daemon event notification types and keeps unknown notifications forward-compatible", () => {
    const eventEnvelope = {
      eventId: "evt-ipc-001",
      updatedAt: "2026-06-11T06:16:32.320Z",
    };
    const healthSnapshot = {
      status: "healthy",
      process: {
        component: "daemon",
        level: "ok",
        code: "ready",
        message: "ready",
        updatedAt: eventEnvelope.updatedAt,
      },
      components: [],
      configConfigured: true,
      databaseOnline: true,
      backendOnline: true,
      mqttConnected: true,
      outboxSize: 0,
      outboxMax: 1000,
      hardwareOnline: true,
      scannerOnline: true,
      visionOnline: false,
      remoteOpsActive: false,
      currentTransaction: null,
      operatorReason: "ok",
      updatedAt: eventEnvelope.updatedAt,
    };
    const readySnapshot = {
      ready: true,
      canSell: true,
      mode: "sale",
      blockingCodes: [],
      blockingReasons: [],
      degradedReasons: [],
      suggestedRoute: "catalog",
      updatedAt: eventEnvelope.updatedAt,
    };
    const scannerSnapshot = {
      online: true,
      adapter: "serial_text",
      port: "COM3",
      level: "ok",
      code: "SCANNER_READY",
      message: "scanner ready",
      updatedAt: eventEnvelope.updatedAt,
    };

    const currentRustEvents = [
      { ...eventEnvelope, type: "health_changed", snapshot: healthSnapshot },
      { ...eventEnvelope, type: "ready_changed", snapshot: readySnapshot },
      {
        ...eventEnvelope,
        type: "scanner_health_changed",
        snapshot: scannerSnapshot,
      },
      {
        ...eventEnvelope,
        type: "scanner_code",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 123,
      },
      {
        ...eventEnvelope,
        type: "transaction_changed",
        orderNo: "ORD-IPC-001",
        status: "paid",
      },
      {
        ...eventEnvelope,
        type: "mqtt_changed",
        connected: true,
        lastError: null,
      },
      {
        ...eventEnvelope,
        type: "vision_changed",
        enabled: true,
        online: false,
        message: "vision offline",
        latestDiagnosticPayload: { reason: "process_down" },
      },
      {
        ...eventEnvelope,
        type: "runtime_reconfigure_requested",
        reason: "config_updated",
        machineCode: "MACHINE-IPC",
      },
      {
        ...eventEnvelope,
        type: "remote_op_result",
        opId: "op-001",
        status: "completed",
      },
    ];

    expect(
      currentRustEvents.map(
        (event) => daemonIpcEventNotificationSchema.parse(event).type,
      ),
    ).toEqual([
      "health_changed",
      "ready_changed",
      "scanner_health_changed",
      "scanner_code",
      "transaction_changed",
      "mqtt_changed",
      "vision_changed",
      "runtime_reconfigure_requested",
      "remote_op_result",
    ]);

    expect(() =>
      daemonIpcEventNotificationSchema.parse({
        ...eventEnvelope,
        type: "scanner_code",
        source: "serial_text",
        scannedAtMs: 123,
      }),
    ).toThrow();

    const withEnvelopeMetadata = daemonIpcEventNotificationSchema.parse({
      ...eventEnvelope,
      type: "scanner_code",
      maskedCode: "6212****9012",
      source: "serial_text",
      scannedAtMs: 123,
      metadata: {
        schemaVersion: 2,
        traceId: "trace-001",
        daemonBuild: "2026.07.06",
      },
      diagnostics: {
        source: "serial_text",
        latencyMs: 7,
      },
    });
    expect(withEnvelopeMetadata).toMatchObject({
      type: "scanner_code",
      metadata: {
        schemaVersion: 2,
        traceId: "trace-001",
        daemonBuild: "2026.07.06",
      },
      diagnostics: {
        source: "serial_text",
        latencyMs: 7,
      },
    });

    expect(() =>
      daemonIpcEventNotificationSchema.parse({
        ...eventEnvelope,
        type: "scanner_code",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 123,
        schemaVersion: 2,
      }),
    ).toThrow();

    expect(() =>
      daemonIpcEventNotificationSchema.parse({
        ...eventEnvelope,
        type: "scanner_code",
        maskedCode: "6212****9012",
        source: "serial_text",
        scannedAtMs: 123,
        rawCode: "621299999012",
      }),
    ).toThrow();

    const unknown = daemonIpcEventNotificationSchema.parse({
      ...eventEnvelope,
      type: "temperature_sensor_changed",
      severity: "info",
      diagnostic: { raw: true },
    });
    expect(unknown).toMatchObject({
      type: "temperature_sensor_changed",
      eventId: "evt-ipc-001",
      known: false,
    });
  });
});
