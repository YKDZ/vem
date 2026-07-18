import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  daemonIpcAudioOutputConfirmRequestSchema,
  daemonIpcAudioOutputTestRequestSchema,
  daemonIpcAudioOutputTestResponseSchema,
  daemonIpcCheckoutFlowActionSchema,
  daemonIpcEventNotificationSchema,
  daemonIpcDeviceBindingSnapshotSchema,
  daemonIpcDeviceBindingActivationSchema,
  daemonIpcDeviceBindingTestResultSchema,
  daemonIpcDispenseProgressObservationStageSchema,
  daemonIpcScannerStatusSchema,
  daemonIpcPickupReminderSchema,
  daemonIpcReadySnapshotSchema,
  daemonIpcTransactionSnapshotSchema,
  exportDaemonIpcScannerStatusJsonSchema,
  exportDaemonIpcJsonSchemaDefinitions,
  exportDaemonIpcTransactionCheckoutJsonSchema,
  machineOrderStatusNextActionSchema,
  normalizeLegacyDaemonIpcCheckoutFlowActionForRecovery,
  parseDaemonIpcTransactionSnapshotBoundary,
  validateDaemonIpcTransactionSnapshotBoundary,
} from ".";
import {
  invalidDaemonIpcScannerStatuses,
  validDaemonIpcScannerStatuses,
} from "./fixtures/daemon-ipc-scanner";
import {
  invalidCurrentDaemonIpcTransactionSnapshots,
  legacyDaemonIpcTransactionRecoveryCases,
  validCurrentDaemonIpcTransactionSnapshots,
} from "./fixtures/daemon-ipc-transaction";

describe("Daemon IPC Contract Area", () => {
  const awaitingPaymentTransaction =
    validCurrentDaemonIpcTransactionSnapshots.awaitingPayment;

  it("keeps operational readiness separate from sale capability and navigation", () => {
    expect(
      daemonIpcReadySnapshotSchema.parse({
        ready: true,
        blockingCodes: [],
        blockingReasons: [],
        degradedReasons: [],
        updatedAt: "2026-07-17T00:00:00.000Z",
      }),
    ).toMatchObject({ ready: true });
    expect(() =>
      daemonIpcReadySnapshotSchema.parse({
        ready: true,
        blockingCodes: [],
        blockingReasons: [],
        degradedReasons: [],
        updatedAt: "2026-07-17T00:00:00.000Z",
        canSell: true,
      }),
    ).toThrow();
  });

  it("keeps stable serial identity separate from the observed COM address", () => {
    const snapshot = daemonIpcDeviceBindingSnapshotSchema.parse({
      roles: [
        {
          role: "lower_controller",
          binding: null,
          currentPort: null,
          ready: false,
          code: "DEVICE_BINDING_SELECTION_REQUIRED",
          message: "operator selection required",
          ambiguous: true,
          ambiguityKind: "candidate_selection",
          ambiguityPorts: ["COM5", "COM9"],
          legacyPortHint: "COM5",
          candidates: [
            {
              identity: {
                identityKey: "container:11111111-2222-3333-4444-555555555555",
                instanceId: "USB\\CONTROLLER-1",
                containerId: "11111111-2222-3333-4444-555555555555",
                hardwareIds: ["USB\\VID_1A86&PID_55D3"],
                serialNumber: null,
              },
              currentPort: "COM9",
              friendlyName: "lower controller",
              readiness: "candidate",
              readinessCode: "ROLE_TEST_REQUIRED",
              readinessMessage: "test required",
            },
            {
              identity: {
                identityKey: "container:22222222-3333-4444-5555-666666666666",
                instanceId: "USB\\SCANNER-1",
                containerId: "22222222-3333-4444-5555-666666666666",
                hardwareIds: ["USB\\VID_1234&PID_5678"],
                serialNumber: "SCANNER-1",
              },
              currentPort: "COM3",
              friendlyName: "scanner",
              readiness: "candidate",
              readinessCode: "ROLE_TEST_REQUIRED",
              readinessMessage: "test required",
            },
          ],
          discoveryDiagnostics: [],
        },
        {
          role: "scanner",
          binding: null,
          currentPort: null,
          ready: false,
          code: "DEVICE_BINDING_REQUIRED",
          message: "binding required",
          ambiguous: false,
          ambiguityKind: null,
          ambiguityPorts: [],
          legacyPortHint: "COM3",
          candidates: [],
          discoveryDiagnostics: [],
        },
      ],
    });

    expect(snapshot.roles[0]?.candidates[0]).toMatchObject({
      currentPort: "COM9",
      identity: {
        identityKey: "container:11111111-2222-3333-4444-555555555555",
      },
    });
    expect(() =>
      daemonIpcDeviceBindingSnapshotSchema.parse({
        ...snapshot,
        roles: [
          {
            ...snapshot.roles[0],
            candidates: [
              {
                ...snapshot.roles[0]?.candidates[0],
                identity: { identityKey: "COM9" },
              },
            ],
          },
          snapshot.roles[1],
        ],
      }),
    ).toThrow();
  });

  it("keeps candidate selection distinct from duplicate observations", () => {
    const candidate = {
      identity: {
        identityKey: "container:11111111-2222-3333-4444-555555555555",
        instanceId: "USB\\CONTROLLER-1",
        containerId: "11111111-2222-3333-4444-555555555555",
        hardwareIds: ["USB\\VID_1A86&PID_55D3"],
        serialNumber: null,
      },
      currentPort: "COM5",
      friendlyName: "lower controller",
      readiness: "candidate" as const,
      readinessCode: "ROLE_TEST_REQUIRED",
      readinessMessage: "test required",
    };
    const base = {
      role: "lower_controller" as const,
      binding: null,
      currentPort: null,
      ready: false,
      message: "operator action required",
      legacyPortHint: "COM5",
      discoveryDiagnostics: [],
    };

    expect(() =>
      daemonIpcDeviceBindingSnapshotSchema.parse({
        roles: [
          {
            ...base,
            code: "DEVICE_BINDING_AMBIGUOUS",
            ambiguous: true,
            ambiguityKind: "candidate_selection",
            ambiguityPorts: ["COM5", "COM9"],
            candidates: [
              candidate,
              {
                ...candidate,
                identity: {
                  ...candidate.identity,
                  identityKey: "container:22222222-3333-4444-5555-666666666666",
                },
                currentPort: "COM9",
              },
            ],
          },
          {
            ...base,
            role: "scanner",
            code: "DEVICE_BINDING_REQUIRED",
            ambiguous: false,
            ambiguityKind: null,
            ambiguityPorts: [],
            candidates: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("requires one-time protected test evidence before a binding confirmation", () => {
    const tested = daemonIpcDeviceBindingTestResultSchema.parse({
      role: "scanner",
      identityKey: "container:22222222-3333-4444-5555-666666666666",
      currentPort: "COM3",
      success: true,
      code: "SCANNER_PORT_OPEN_READY",
      message: "ready",
      testedAt: "2026-07-15T00:00:00Z",
      testEvidenceToken: "11111111-2222-4333-8444-555555555555",
      testEvidenceExpiresAt: "2026-07-15T00:01:00Z",
      observationRevision: `sha256:${"a".repeat(64)}`,
      configRevision: `sha256:${"b".repeat(64)}`,
    });

    expect(tested.testEvidenceToken).not.toBe(tested.identityKey);
    expect(() =>
      daemonIpcDeviceBindingTestResultSchema.parse({
        ...tested,
        testEvidenceToken: undefined,
      }),
    ).toThrow();
  });

  it("round-trips daemon binding activation output through the strict shared contract", () => {
    expect(
      daemonIpcDeviceBindingActivationSchema.parse({
        binding: {
          identity: {
            identityKey: "container:11111111-2222-3333-4444-555555555555",
            instanceId: "USB\\SCANNER-1",
            containerId: "11111111-2222-3333-4444-555555555555",
            hardwareIds: ["USB\\VID_1234&PID_5678"],
            serialNumber: "SCANNER-1",
          },
          confirmedAt: "2026-07-17T00:00:00Z",
          confirmedBy: "local_operator",
          testEvidenceCode: "SCANNER_PORT_OPEN_READY",
        },
        currentPort: "COM7",
        ready: true,
        code: "DEVICE_BINDING_ACTIVATED",
        message: "scanner binding activated",
        unrelatedRuntimeRestarted: false,
      }),
    ).toMatchObject({
      currentPort: "COM7",
      unrelatedRuntimeRestarted: false,
    });
  });

  it("does not accept client-authored native playback evidence for audio tests", () => {
    const proposedSettings = {
      audioCueSettings: {
        enabled: true,
        categories: { presence: true, transaction: true },
      },
      machineAudioVolume: 0.7,
    };
    expect(
      daemonIpcAudioOutputTestRequestSchema.parse(proposedSettings),
    ).toEqual(proposedSettings);
    expect(() =>
      daemonIpcAudioOutputTestRequestSchema.parse({
        ...proposedSettings,
        nativePlaybackEvidence: {
          driver: "native",
          outputModel: "windows_default",
          sourceNonSilent: true,
        },
      }),
    ).toThrow();
    expect(() =>
      daemonIpcAudioOutputConfirmRequestSchema.parse({
        ...proposedSettings,
        testEvidenceToken: "11111111-2222-4333-8444-555555555555",
        heard: false,
      }),
    ).toThrow();
    expect(() =>
      daemonIpcAudioOutputConfirmRequestSchema.parse({
        ...proposedSettings,
        testEvidenceToken: "11111111-2222-4333-8444-555555555555",
        heard: true,
        confirmedAt: "2026-07-15T00:00:00Z",
      }),
    ).toThrow();
    expect(
      daemonIpcAudioOutputTestResponseSchema.parse({
        outputModel: "windows_default",
        testEvidenceToken: "11111111-2222-4333-8444-555555555555",
        testEvidenceExpiresAt: "2026-07-18T08:10:00.000Z",
        observationRevision: `sha256:${"a".repeat(64)}`,
        observationGeneration: 4,
        configRevision: `sha256:${"b".repeat(64)}`,
        configGeneration: 7,
        proposedSettingsDigest: `sha256:${"c".repeat(64)}`,
      }),
    ).toMatchObject({ outputModel: "windows_default" });
  });

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

  it("exports transaction checkout structural schemas with Zod native JSON Schema", () => {
    const schema = exportDaemonIpcTransactionCheckoutJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("CurrentTransactionSnapshot");
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("$defs.CheckoutFlowAction");
    expect(schema).toHaveProperty("$defs.PaymentCodeAttemptSummary");
    expect(schema).toHaveProperty("$defs.PickupReminder");
    expect(schema).not.toHaveProperty("definitions");
    expect(JSON.stringify(schema.$defs)).not.toContain(
      '"$schema":"https://json-schema.org/draft/2020-12/schema"',
    );
    expect(() =>
      z.toJSONSchema(daemonIpcTransactionSnapshotSchema),
    ).not.toThrow();
    expect(JSON.stringify(schema)).not.toContain("submit_payment");
    expect(JSON.stringify(schema)).not.toContain("collect_goods");
  });

  it("publishes scanner runtime status as a strict generated-input snapshot schema", () => {
    for (const snapshot of Object.values(validDaemonIpcScannerStatuses)) {
      expect(daemonIpcScannerStatusSchema.parse(snapshot)).toEqual(snapshot);
    }

    for (const snapshot of Object.values(invalidDaemonIpcScannerStatuses)) {
      expect(() => daemonIpcScannerStatusSchema.parse(snapshot)).toThrow();
    }

    const schema = exportDaemonIpcScannerStatusJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("ScannerRuntimeStatus");
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("additionalProperties", false);
    expect(() => z.toJSONSchema(daemonIpcScannerStatusSchema)).not.toThrow();
  });

  it("fails clearly when Daemon IPC JSON Schema export sees unsupported Zod features", () => {
    expect(() =>
      exportDaemonIpcJsonSchemaDefinitions({
        UnsupportedTransform: z.string().transform((value) => value.trim()),
      }),
    ).toThrow(/Daemon IPC JSON Schema export failed for UnsupportedTransform/);
  });

  it("keeps transaction cross-field semantics in an explicit boundary helper", () => {
    for (const snapshot of Object.values(
      validCurrentDaemonIpcTransactionSnapshots,
    )) {
      expect(validateDaemonIpcTransactionSnapshotBoundary(snapshot)).toBe(
        snapshot,
      );
      expect(parseDaemonIpcTransactionSnapshotBoundary(snapshot)).toEqual(
        snapshot,
      );
    }

    expect(
      validateDaemonIpcTransactionSnapshotBoundary(
        validCurrentDaemonIpcTransactionSnapshots.emptyOrderNoParity,
      ),
    ).toBe(validCurrentDaemonIpcTransactionSnapshots.emptyOrderNoParity);

    expect(
      daemonIpcTransactionSnapshotSchema.parse(
        invalidCurrentDaemonIpcTransactionSnapshots.missingNextActionWithOrderNo,
      ),
    ).toEqual(
      invalidCurrentDaemonIpcTransactionSnapshots.missingNextActionWithOrderNo,
    );

    for (const snapshot of [
      invalidCurrentDaemonIpcTransactionSnapshots.missingNextActionWithOrderNo,
      invalidCurrentDaemonIpcTransactionSnapshots.awaitingPaymentWithoutPaymentMethod,
      invalidCurrentDaemonIpcTransactionSnapshots.awaitingPaymentWithoutTotalAmount,
      invalidCurrentDaemonIpcTransactionSnapshots.negativeTotalAmount,
      invalidCurrentDaemonIpcTransactionSnapshots.negativePickupReminderRemainingSeconds,
    ]) {
      expect(() =>
        parseDaemonIpcTransactionSnapshotBoundary(snapshot),
      ).toThrow();
    }

    expect(
      validCurrentDaemonIpcTransactionSnapshots.paymentCodeScan
        .paymentCodeAttempt?.source,
    ).toBe("tauri_scanner");
    expect(
      validCurrentDaemonIpcTransactionSnapshots.dispensingWithPickupReminder
        .vending?.pickupReminder?.stage,
    ).toBe("pickup_timeout_warning");
    expect(
      validCurrentDaemonIpcTransactionSnapshots.terminalSuccess.nextAction,
    ).toBe("success");
    expect(
      validCurrentDaemonIpcTransactionSnapshots.terminalDispenseFailed
        .nextAction,
    ).toBe("dispense_failed");
  });

  it("isolates legacy checkout action normalization to recovery helpers", () => {
    for (const {
      legacyAction,
      currentAction,
    } of legacyDaemonIpcTransactionRecoveryCases) {
      expect(() =>
        daemonIpcCheckoutFlowActionSchema.parse(legacyAction),
      ).toThrow();
      expect(() =>
        daemonIpcTransactionSnapshotSchema.parse({
          ...awaitingPaymentTransaction,
          nextAction: legacyAction,
        }),
      ).toThrow();
      expect(
        normalizeLegacyDaemonIpcCheckoutFlowActionForRecovery(legacyAction),
      ).toBe(currentAction);
    }
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
          commandId: "550e8400-e29b-41d4-a716-446655440201",
          commandNo: "CMD-IPC-001",
          status: "pending",
          lastError: null,
          pickupReminder: null,
          extraVendingField: true,
        },
      }),
    ).toThrow();

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "dispensing",
        vending: {
          commandId: "550e8400-e29b-41d4-a716-446655440201",
          commandNo: "CMD-IPC-001",
          status: "pending",
          lastError: null,
          pickupReminder: {
            stage: "pickup_waiting",
            level: "warning",
            message: "Please collect goods",
            warningNo: 1,
            reportedAt: "2026-06-11T06:18:00.000Z",
            remainingSeconds: null,
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

  it("names the remaining daemon snapshot convergence and contract generation entry point", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./schemas/daemon-ipc.ts", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("Daemon IPC Contract Generation");
    expect(source).toContain("Remaining daemon snapshot convergence");
    expect(source).toContain("health, ready, config, bring-up");
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
        remainingSeconds: null,
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
