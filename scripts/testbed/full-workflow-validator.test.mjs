import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { BUSINESS_CHECK_REGISTRY } from "./business-check-registry.mjs";
import { buildStabilityGateReport } from "./full-workflow-stability-gate.mjs";
import {
  buildFullWorkflowAggregate,
  validateBusinessCheckReport,
} from "./full-workflow-validator.mjs";
import { buildPaymentCodeSubmission } from "./payment-provider-guest-full.mjs";

function saleReport() {
  return {
    schemaVersion: "vem-fast-route-stress-sale/v2",
    ok: true,
    summary: {
      orderId: "ORDER-1",
      paymentId: "PAYMENT-1",
      vendingCommandId: "VEND-1",
      protocol: ["VEND", "F0", "F1", "F2"],
      daemonStockDeltaAfterF2: -1,
      platformStockDeltaAfterF2: -1,
      visionEventId: "VISION-1",
      repeatedPhysicalTouchTraceId: 1,
    },
  };
}

function descriptor(name) {
  return BUSINESS_CHECK_REGISTRY.find((entry) => entry.name === name);
}

function visionExperienceReport() {
  return {
    schemaVersion: "vem-vision-try-on-acceptance/v1",
    ok: true,
    health: { vision: { protocolSummary: { protocol: "vem.vision.v1" } } },
    visionInstall: {
      runtimeExpectation: {
        recommendationVariants: [
          { productId: "product-t", variantId: "variant-m", size: "M" },
          { productId: "product-t", variantId: "variant-l", size: "L" },
        ],
      },
    },
    degradations: {
      visionDown: {
        experienceCapabilityDegraded: true,
        saleStartStillAvailable: true,
      },
    },
    ui: {
      recommendationPresentation: {
        automatic: { variantId: "variant-m", recommendedSize: "M" },
        onlineUnmatched: { variantId: "variant-online", recommendedSize: null },
        manual: { variantId: "variant-l", recommendedSize: null },
        visionUnavailable: { variantId: "variant-l", recommendedSize: null },
      },
      tryOnSelectedProduct: { variantId: "variant-l" },
      tryOnSummary: { width: 640, height: 480, silhouetteHttpStatus: 200 },
      tryOnAttempts: [{ result: "passed" }],
    },
  };
}

function stockMaintenanceReport() {
  return {
    schemaVersion: "vem-stock-maintenance-guest-full/v1",
    ok: true,
    runId: "RUN-STOCK-1",
    handoffSerialSessionId: "stock-serial-session-2",
    fixture: {
      slotDisplayLabel: "B2",
      sku: "TSC-LOCAL-007",
      slotId: "slot-stock-1",
      inventoryId: "inventory-stock-1",
      initialQuantity: 1,
    },
    movementCursor: {
      inventoryId: "inventory-stock-1",
      capturedAt: "2026-07-22T00:00:00.000Z",
      baselineItemIds: ["movement-before-1"],
    },
    firstSale: stockSale("1"),
    unavailable: {
      daemon: {
        physicalStock: 0,
        saleableStock: 0,
        slotSalesState: "out_of_stock",
      },
      platform: { onHandQty: 0, reservedQty: 0 },
    },
    maintenance: {
      taskId: "refill-task-1",
      addition: 2,
      previewQuantity: 2,
      refillMovementCount: 1,
      projection: {
        taskStatus: "complete",
        slotSyncStatus: "accepted",
        movementId: "refill-task-1:slot-stock-1",
        movementType: "planned_refill",
        source: "local_maintenance",
        attributedTo: "local_operations",
        platformRawMovementId: "raw-refill-1",
      },
      platformMovement: {
        id: "refill-movement-1",
        inventoryId: "inventory-stock-1",
        reason: "hardware_sync",
        deltaQty: 2,
        taskId: "refill-task-1",
        note: "machine_stock_movement:raw-refill-1",
      },
    },
    restored: {
      daemon: {
        physicalStock: 2,
        saleableStock: 2,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 2, reservedQty: 0 },
    },
    secondSale: stockSale("2"),
    terminal: {
      daemon: {
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 1, reservedQty: 0 },
      movements: {
        saleDecrementOrderIds: ["order-stock-1", "order-stock-2"],
        salePlatformMovementIds: [
          "sale-platform-movement-1",
          "sale-platform-movement-2",
        ],
        salePlatformMovements: [
          { id: "sale-platform-movement-1", orderId: "order-stock-1" },
          { id: "sale-platform-movement-2", orderId: "order-stock-2" },
        ],
        refillDeltas: [2],
      },
    },
    screenshots: {
      unavailable: {
        ref: "unavailable.png",
        route: "#/maintenance?source=operator",
        slotDisplayLabel: "B2",
        slotId: "slot-stock-1",
      },
      refillConfirmed: {
        ref: "refill-confirmed.png",
        route: "#/maintenance?source=operator",
        slotDisplayLabel: "B2",
        slotId: "slot-stock-1",
      },
      restoredSaleability: {
        ref: "restored.png",
        route: "#/catalog",
        slotDisplayLabel: "B2",
        slotId: "slot-stock-1",
      },
    },
  };
}

function stockSale(index) {
  return {
    runId: "RUN-STOCK-1",
    orderId: `order-stock-${index}`,
    paymentId: `payment-stock-${index}`,
    paymentNo: `PAY-STOCK-${index}`,
    commandId: `command-stock-${index}`,
    commandNo: `COMMAND-STOCK-${index}`,
    fulfillmentMovementId: `fulfillment-movement-${index}`,
    controlPlaneSessionId: `control-session-${index}`,
    serialSessionId: `serial-session-${index}`,
    resultRoute: "#/result/success",
    gateCleanup: { paymentGateOpen: true, serialSessionInactive: true },
  };
}

function hardwareLifecycleReport() {
  return {
    schemaVersion: "vem-hardware-lifecycle-guest-full/v1",
    ok: true,
    discovery: {
      dynamicRoleDiscovery: true,
      fixedComSelection: false,
      roles: [{ role: "lower_controller" }, { role: "scanner" }],
      qemuUsbSerialMappings: [
        { role: "lower-controller" },
        { role: "scanner" },
      ],
    },
    readiness: {
      before: { canStartSale: true, revision: 7 },
      after: { canStartSale: true, revision: 11 },
    },
    lifecycle: [
      {
        role: "lower_controller",
        identityKey: "container:lower",
        disconnect: {
          boundary: {
            adapter: "file_backed_windows_pnp",
            operation: "disconnect",
            identityKey: "container:lower",
          },
          daemon: { ready: false, currentPort: null },
          saleStartCapability: { canStartSale: false },
        },
        reconnect: {
          boundary: {
            adapter: "file_backed_windows_pnp",
            operation: "reconnect",
            identityKey: "container:lower",
          },
          daemon: {
            ready: true,
            currentPort: "COM4",
            identityKey: "container:lower",
          },
          saleStartCapability: { canStartSale: true },
        },
      },
      {
        role: "scanner",
        identityKey: "container:scanner",
        disconnect: {
          boundary: {
            adapter: "file_backed_windows_pnp",
            operation: "disconnect",
            identityKey: "container:scanner",
          },
          daemon: { ready: false, currentPort: null },
          saleStartCapability: {
            canStartSale: true,
            paymentOptions: {
              options: [{ method: "payment_code", ready: false }],
            },
          },
        },
        reconnect: {
          boundary: {
            adapter: "file_backed_windows_pnp",
            operation: "reconnect",
            identityKey: "container:scanner",
          },
          daemon: {
            ready: true,
            currentPort: "COM3",
            identityKey: "container:scanner",
          },
          saleStartCapability: {
            canStartSale: true,
            paymentOptions: {
              options: [{ method: "payment_code", ready: true }],
            },
          },
        },
      },
    ],
  };
}

function environmentCommand(action, commandNo, resultJson = { success: true }) {
  return {
    action,
    admin: { commandNo, status: "sent" },
    result: { status: "succeeded", resultJson },
    mqtt: {
      commandObserved: true,
      resultObserved: true,
      commandNo,
      resultCommandNo: commandNo,
      command: { payload: { commandNo } },
      result: { payload: { commandNo } },
    },
    serial: {
      lowerBoundaryObserved: true,
      automaticB3FrameCount: action === "ventSpeed" ? 1 : 0,
      protocolFrame: {
        parsedOpcode: action === "ventSpeed" ? "B3" : "B2",
        rawFrameHex: action === "ventSpeed" ? "55b303" : "55b201",
        capturedAt: "2026-07-22T08:00:05.000Z",
      },
    },
  };
}

function environmentControlReport() {
  return {
    schemaVersion: "vem-environment-control-guest-full/v1",
    ok: true,
    commands: [
      environmentCommand("airConditionerOnTrue", "MCMD-1"),
      environmentCommand("airConditionerOnFalse", "MCMD-2"),
      environmentCommand("ventSpeed", "MCMD-3"),
      environmentCommand("targetTemperatureCelsius", "MCMD-4"),
    ],
    overlapRejection: {
      rejected: true,
      httpStatus: 409,
      error: "ENVIRONMENT_COMMAND_IN_PROGRESS",
    },
    daemon: {
      health: { hardwareOnline: true },
      readiness: { ready: true },
    },
    precedence: {
      automaticArrival: {
        edgeId: "presence-1:arrival",
        requestedSpeed: 2,
        outcome: "accepted",
        b3FrameCountDelta: 1,
        protocolFrames: ["B3"],
        frame: {
          parsedOpcode: "B3",
          rawFrameHex: "55b302",
          capturedAt: "2026-07-22T08:00:00.000Z",
        },
      },
      adminB3: {
        commandNo: "MCMD-3",
        resultStatus: "succeeded",
        mqttCommandNo: "MCMD-3",
        mqttResultNo: "MCMD-3",
        frame: {
          parsedOpcode: "B3",
          rawFrameHex: "55b303",
          capturedAt: "2026-07-22T08:00:05.000Z",
        },
      },
      sameEdgeAfterAdmin: {
        edgeId: "presence-1:arrival",
        outcome: "deduplicated",
        b3FrameCountDelta: 0,
        protocolFrames: [],
        guardWindow: {
          completed: true,
          durationMs: 5_000,
          protocolFrames: [],
          b3FrameCountDelta: 0,
        },
      },
      nextStableEdge: {
        edgeId: "presence-2:departure",
        requestedSpeed: 0,
        outcome: "accepted",
        b3FrameCountDelta: 1,
        protocolFrames: ["B3"],
        frame: {
          parsedOpcode: "B3",
          rawFrameHex: "55b300",
          capturedAt: "2026-07-22T08:00:10.000Z",
        },
      },
    },
    boundaries: {
      adminApi: true,
      mqtt: true,
      daemonIpc: true,
      lowerSerial: true,
    },
  };
}

function paymentRecoveryReport() {
  const expectedByKind = {
    create_failure: [
      "failed",
      "canceled",
      "payment_failed",
      "payment_failed",
      "支付订单创建失败，请稍后重试",
    ],
    query_failure: ["canceled", "canceled", "canceled", "closed", "订单已关闭"],
    canceled: ["canceled", "canceled", "canceled", "closed", "订单已关闭"],
    expired: [
      "expired",
      "payment_expired",
      "payment_expired",
      "payment_expired",
      "支付超时",
    ],
  };
  return {
    schemaVersion: "vem-payment-recovery-guest-full/v1",
    ok: true,
    handoffSerialSessionId: "payment-recovery-serial-session",
    inventory: { id: "inventory-payment-recovery" },
    payment: { id: "payment-recovery-1" },
    recoveryMqttEvidence: {
      mqtt: { topic: "vem/machines/M-1/commands/dispense", messages: [] },
    },
    attempts: Object.entries(expectedByKind).map(([kind, expected]) => {
      const [
        paymentStatus,
        orderStatus,
        paymentState,
        resultKind,
        customerCopy,
      ] = expected;
      return {
        kind,
        ...(kind === "create_failure"
          ? { idempotencyKey: "checkout:create-failure" }
          : {}),
        order: { id: `order-${kind}`, paymentId: `payment-${kind}` },
        payment: { id: `payment-${kind}`, paymentNo: `payment-no-${kind}` },
        expectedTerminal: {
          paymentStatus,
          orderStatus,
          paymentState,
          resultKind,
          customerCopy,
        },
        terminal: { paymentStatus, orderStatus, paymentState },
        reservation: {
          quantity: 1,
          baseline: { onHandQty: 3, reservedQty: 0, activeRows: 0 },
          active: {
            onHandQty: 3,
            reservedQty: 1,
            activeRows: 1,
            orderReservationRows: 1,
            row: { id: `reservation-${kind}`, status: "active" },
          },
          terminal: {
            onHandQty: 3,
            reservedQty: 0,
            activeRows: 0,
            orderReservationRows: 1,
            row: { id: `reservation-${kind}`, status: "released" },
          },
        },
        daemon:
          kind === "create_failure"
            ? {
                active: null,
                terminal: {
                  orderId: null,
                  paymentId: null,
                  paymentStatus: null,
                  nextAction: null,
                },
              }
            : {
                active: {
                  orderId: `order-${kind}`,
                  paymentId: `payment-${kind}`,
                },
                terminal: {
                  orderId: `order-${kind}`,
                  paymentId: `payment-${kind}`,
                  paymentStatus,
                },
              },
        customer:
          kind === "create_failure"
            ? {
                source: "installed_machine_runtime_cdp",
                checkoutAttemptIdempotencyKey: "checkout:create-failure",
                stage: "payment_creation",
                text: customerCopy,
              }
            : {
                source: "installed_machine_runtime_cdp",
                orderId: `order-${kind}`,
                paymentId: `payment-${kind}`,
                resultKind,
                text: `${customerCopy}，请重新选择商品。`,
              },
        technicalEvidence:
          kind === "create_failure"
            ? {
                providerCreate: {
                  source: "mock_provider_create_gate",
                  paymentNo: `payment-no-${kind}`,
                  error: "mock payment create gate timed out before release",
                },
                runtimeTrace: {
                  source: "installed_machine_runtime_trace_cdp",
                  checkoutAttemptIdempotencyKey: "checkout:create-failure",
                  entry: { id: 1 },
                },
                localOperations: {
                  source:
                    "installed_machine_local_operations_cdp_after_refresh",
                  checkoutAttemptIdempotencyKey: "checkout:create-failure",
                  orderId: `order-${kind}`,
                  paymentId: `payment-${kind}`,
                  entry: {
                    technicalMessage:
                      "mock payment create gate timed out before release",
                  },
                },
              }
            : {
                runtimeTrace: {
                  source: "installed_machine_runtime_trace_cdp",
                  orderId: `order-${kind}`,
                  paymentId: `payment-${kind}`,
                  resultKind,
                  entry: { id: 1 },
                },
              },
        ...(kind === "create_failure"
          ? {
              createGate: {
                source: "mock_provider_create_gate",
                paymentNo: `payment-no-${kind}`,
                released: false,
                openedAfterFailure: true,
                error: "mock payment create gate timed out before release",
              },
            }
          : {}),
        ...(kind === "query_failure"
          ? {
              recovery: {
                queryFault: {
                  source: "mock_provider_query_fault_boundary",
                  paymentNo: `payment-no-${kind}`,
                },
                reconciliationAttempt: {
                  paymentId: `payment-${kind}`,
                  status: "network_error",
                  errorCode: "query_failed",
                },
                closeAction: { action: "close_or_reverse_uncertain_payment" },
              },
            }
          : {}),
        ...(kind === "expired"
          ? {
              expiryInjection: {
                source: "testbed_payment_expiry_time_injection",
                beforePaymentStatus: "pending",
              },
            }
          : {}),
        assertions: { duplicatePaymentCount: 0 },
      };
    }),
    subsequentSale: {
      order: {
        id: "order-paid",
        paymentId: "payment-paid",
        inventoryId: "inventory-payment-recovery",
      },
      terminal: {
        paymentStatus: "succeeded",
        orderStatus: "fulfilled",
        fulfillmentState: "dispensed",
      },
      inventory: { beforeOnHandQty: 3, afterOnHandQty: 2, movementCount: 1 },
      serial: { protocol: ["VEND", "F0", "F1", "F2"], stopped: true },
    },
    assertions: { duplicatePaymentCount: 0 },
  };
}

function paymentProviderReport() {
  return {
    schemaVersion: "vem-payment-provider-guest-full/v1",
    ok: true,
    environment: { environment: "sandbox", readiness: "ready" },
    provider: {
      identity: {
        providerCode: "alipay",
        providerConfigId: "provider-config-1",
        appId: "9021000163629927",
        merchantNo: "2088721101045878",
        mode: "sandbox",
        gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
        keyType: "PKCS1",
      },
      hostPreparation: {
        source: "host_installation_fixture",
        preflight: "configured",
      },
    },
    authoritative: {
      ok: true,
      attempts: [
        {
          channel: "qr_code:alipay",
          order: {
            orderId: "order-qr-1",
            paymentId: "payment-qr-1",
            orderNo: "PAYMENT-PROVIDER-QR-1",
            providerCode: "alipay",
          },
          machine: {
            boundary: "installed_machine_ui_cdp",
            paymentMethod: "qr_code",
            providerCode: "alipay",
            surface: {
              orderId: "order-qr-1",
              paymentId: "payment-qr-1",
              orderNo: "PAYMENT-PROVIDER-QR-1",
            },
          },
          credential: { paymentUrlSha256: "sha256:credential" },
          query: {
            reconciliationAttemptId: "reconciliation-1",
            providerCode: "alipay",
            status: "provider_trade_not_exist",
            providerPaymentStatus: "pending",
          },
          closure: {
            action: "close_or_reverse_uncertain_payment",
            status: "canceled",
            handled: true,
            providerConfigId: "provider-config-1",
          },
          terminal: {
            paymentStatus: "canceled",
            orderStatus: "canceled",
            paymentState: "canceled",
            reservedInventory: false,
          },
        },
        {
          channel: "payment_code:alipay",
          order: {
            orderId: "order-code-1",
            paymentId: "payment-code-1",
            orderNo: "PAYMENT-PROVIDER-CODE-1",
            providerCode: "alipay",
          },
          machine: {
            boundary: "installed_machine_ui_cdp",
            paymentMethod: "payment_code",
            providerCode: "alipay",
            surface: {
              orderId: "order-code-1",
              paymentId: "payment-code-1",
              orderNo: "PAYMENT-PROVIDER-CODE-1",
            },
            scannerPrompt: "请出示付款码",
          },
          submission: buildPaymentCodeSubmission({
            id: "attempt-1",
            status: "failed",
            providerCode: "alipay",
            failureCode: "ACQ.INVALID_AUTH_CODE",
            providerStatus: "FAILED",
          }),
          cleanup: {
            action: "customer_cancel_order",
            providerConfigId: "provider-config-1",
            serialSession: { action: "abort", aborted: true },
          },
          terminal: {
            paymentStatus: "failed",
            orderStatus: "payment_failed",
            paymentState: "payment_failed",
            reservedInventory: false,
          },
        },
      ],
    },
    diagnostics: [],
  };
}

function localOperationsReport() {
  return {
    schemaVersion: "vem-local-operations-guest-full/v1",
    ok: true,
    boundaries: { daemon: true, hardwareSelfCheck: true, serial: true },
    planogram: {
      canonical: true,
      planogramVersion: "PLAN-OPS",
      slotDisplayLabel: "R7C1",
      slotId: "slot-ops",
    },
    manualDispense: {
      slotId: "slot-ops",
      slotDisplayLabel: "R7C1",
      outcome: "completed",
    },
  };
}

function presenceAndAudioReport() {
  return {
    schemaVersion: "vem-presence-and-audio-guest-full/v1",
    ok: true,
    boundaries: {
      visionMock: true,
      machineCdp: true,
      windowsAudioCapture: true,
    },
    artifacts: {
      audioCueCaptures: [
        {
          start:
            "/reports/presence-and-audio-artifacts/audio-capture-01-start.json",
          stop: "/reports/presence-and-audio-artifacts/audio-capture-01-stop.json",
        },
      ],
      runtimeTrace: "/reports/presence-and-audio-artifacts/runtime-trace.json",
    },
    presenceAndAudio: {
      schemaVersion: "presence-and-audio-production-acceptance/v1",
      result: "passed",
      boundaries: {
        vision: "controlled_mock_protocol",
        cdp: "installed_canonical_machine_cdp",
        audio: "windows_default_output_capture",
      },
      diagnostics: [],
      audio: {
        source: "windows_default_output",
        capture: { nonSilentFrameCount: 4_800, peakAbsoluteSample: 2_048 },
        cueWindows: [
          {
            transitionId: "vision:presence-1:welcome",
            kind: "detected",
            capture: {
              nonSilentFrameCount: 1_200,
              peakAbsoluteSample: 2_048,
              startedAt: "2026-07-22T08:00:00.000Z",
              completedAt: "2026-07-22T08:00:01.000Z",
            },
          },
          {
            transitionId: "vision:presence-3:welcome",
            kind: "detected",
            capture: {
              nonSilentFrameCount: 1_200,
              peakAbsoluteSample: 2_048,
              startedAt: "2026-07-22T08:00:06.000Z",
              completedAt: "2026-07-22T08:00:07.000Z",
            },
          },
          {
            transitionId: "category:category-entry-socks-1",
            kind: "detected",
            capture: {
              nonSilentFrameCount: 1_200,
              peakAbsoluteSample: 2_048,
              startedAt: "2026-07-22T08:00:10.000Z",
              completedAt: "2026-07-22T08:00:11.000Z",
            },
          },
        ],
      },
      runtimeTrace: [
        {
          type: "journey_transition",
          id: 1,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_queued",
          id: 2,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: "audio-request-1",
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_started",
          id: 3,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: "audio-request-1",
          terminalOutcomeId: null,
          outcome: null,
          message: "native",
        },
        {
          type: "audio_terminal",
          id: 4,
          at: "2026-07-22T08:00:00.000Z",
          recordedAt: "2026-07-22T08:00:00.000Z",
          transitionId: "vision:presence-1:welcome",
          requestId: "audio-request-1",
          terminalOutcomeId: "audio-terminal-1",
          outcome: "completed",
          message: null,
        },
        {
          type: "journey_transition",
          id: 5,
          at: "2026-07-22T08:00:03.000Z",
          recordedAt: "2026-07-22T08:00:03.000Z",
          transitionId: "vision:presence-2:departed",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "journey_transition",
          id: 6,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_queued",
          id: 7,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: "audio-request-6",
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_started",
          id: 8,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: "audio-request-6",
          terminalOutcomeId: null,
          outcome: null,
          message: "native",
        },
        {
          type: "audio_terminal",
          id: 9,
          at: "2026-07-22T08:00:06.000Z",
          recordedAt: "2026-07-22T08:00:06.000Z",
          transitionId: "vision:presence-3:welcome",
          requestId: "audio-request-6",
          terminalOutcomeId: "audio-terminal-6",
          outcome: "completed",
          message: null,
        },
        {
          type: "journey_transition",
          id: 10,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_queued",
          id: 11,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: "audio-request-10",
          terminalOutcomeId: null,
          outcome: null,
          message: null,
        },
        {
          type: "audio_started",
          id: 12,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: "audio-request-10",
          terminalOutcomeId: null,
          outcome: null,
          message: "native",
        },
        {
          type: "audio_terminal",
          id: 13,
          at: "2026-07-22T08:00:10.000Z",
          recordedAt: "2026-07-22T08:00:10.000Z",
          transitionId: "category:category-entry-socks-1",
          requestId: "audio-request-10",
          terminalOutcomeId: "audio-terminal-10",
          outcome: "completed",
          message: null,
        },
        {
          type: "audio_rejected",
          id: 14,
          at: "2026-07-22T08:00:11.000Z",
          recordedAt: "2026-07-22T08:00:11.000Z",
          transitionId: "vision:presence-4:welcome",
          requestId: "audio-request-14",
          terminalOutcomeId: null,
          outcome: null,
          message: "audio cue preference disabled",
        },
      ],
      checkpoints: [
        { label: "stable-arrival-settled", traceId: 4 },
        { label: "initial-duplicate-approach-settled", traceId: 4 },
        { label: "transient-empty-recovered", traceId: 4 },
        { label: "sustained-empty-departed", traceId: 5 },
        { label: "rearmed-arrival-settled", traceId: 9 },
        { label: "category-socks-entry", traceId: 9 },
        { label: "category-socks-detail", traceId: 13 },
        { label: "category-socks-checkout", traceId: 13 },
        { label: "disabled-presence-welcome-rejected", traceId: 14 },
      ],
      scenario: {
        welcome: {
          initialTransitionId: "vision:presence-1:welcome",
          departureTransitionId: "vision:presence-2:departed",
          rearmedTransitionId: "vision:presence-3:welcome",
        },
        supportedCategoryKeys: ["socks"],
        preferenceSuppression: {
          transitionId: "vision:presence-4:welcome",
          rejectedTraceId: 14,
        },
        categories: [
          {
            key: "socks",
            transitionId: "category:category-entry-socks-1",
            sourceUrl: "/audio/voice/product/socks.mp3",
            entryCheckpointLabel: "category-socks-entry",
            detailCheckpointLabel: "category-socks-detail",
            checkoutCheckpointLabel: "category-socks-checkout",
          },
        ],
      },
      automaticVent: {
        protocolFrames: [
          {
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
            capturedAt: "2026-07-22T08:00:00.000Z",
          },
          {
            parsedOpcode: "B3",
            rawFrameHex: "55b300",
            capturedAt: "2026-07-22T08:00:10.000Z",
          },
        ],
        speeds: [2, 0],
        guardElapsedMs: 10_000,
        edgeCorrelation: [
          {
            edgeId: "presence-1:arrival",
            transitionId: "vision:presence-1:welcome",
            speed: 2,
            frame: {
              parsedOpcode: "B3",
              rawFrameHex: "55b302",
              capturedAt: "2026-07-22T08:00:00.000Z",
            },
          },
          {
            edgeId: "presence-2:departure",
            transitionId: "vision:presence-2:departed",
            speed: 0,
            frame: {
              parsedOpcode: "B3",
              rawFrameHex: "55b300",
              capturedAt: "2026-07-22T08:00:10.000Z",
            },
          },
        ],
        adminPrecedence: {
          commandNo: "environment-command-1",
          requestedSpeed: 3,
          resultStatus: "succeeded",
          frame: {
            parsedOpcode: "B3",
            rawFrameHex: "55b303",
            capturedAt: "2026-07-22T08:00:05.000Z",
          },
          duplicateSameEdge: {
            edgeId: "presence-1:arrival",
            outcome: "deduplicated",
          },
        },
      },
    },
  };
}

function identity(reconstruction) {
  const caches = [
    "D:\\runtime-cache\\v1\\pnpm-store",
    "D:\\runtime-cache\\v1\\pnpm-virtual-store",
    "D:\\runtime-cache\\v1\\cargo-home",
    "D:\\runtime-cache\\v1\\target",
    "D:\\runtime-cache\\v1\\sccache",
    "D:\\runtime-cache\\v1\\turbo",
    "D:\\runtime-cache\\v1\\vision-main",
    "D:\\runtime-cache\\v1\\powershell",
  ];
  return {
    githubSha: "c".repeat(40),
    baseline: {
      releaseId: "win10-runtime-20260718",
      digest: `sha256:${"a".repeat(64)}`,
    },
    runtimeBase: `runtime-base://sha256/${"b".repeat(64)}`,
    reconstructionId: `reconstruction://sha256/${reconstruction.repeat(64).slice(0, 64)}`,
    retainedCaches: caches,
    observedRetainedCaches: caches,
    removedUndeclaredCaches: [],
    runtimeArtifacts: {
      commit: "c".repeat(40),
      reusedFromPass1: reconstruction === "b",
      artifacts: {
        daemon: { sha256: "d".repeat(64) },
        machine: { sha256: "e".repeat(64) },
        webViewLoader: { sha256: "f".repeat(64) },
      },
    },
  };
}

function passingExecution(descriptors) {
  return descriptors.map((descriptor) => ({
    key: descriptor.name,
    validator: {
      key: descriptor.name,
      label: descriptor.name,
      status: "passed",
      reportPath: `/reports/${descriptor.name}.json`,
    },
  }));
}

describe("full workflow aggregate validator", () => {
  it("rejects vision experience reports without each recommendation presentation state", () => {
    const complete = validateBusinessCheckReport(
      descriptor("visionExperience"),
      visionExperienceReport(),
      "vision-experience.json",
    );
    assert.equal(complete.status, "passed");

    const incomplete = visionExperienceReport();
    delete incomplete.ui.recommendationPresentation.onlineUnmatched;
    const rejected = validateBusinessCheckReport(
      descriptor("visionExperience"),
      incomplete,
      "vision-experience.json",
    );
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason, /vision degradation evidence is incomplete/);

    const forgedIdentity = visionExperienceReport();
    forgedIdentity.visionInstall.runtimeExpectation.recommendationVariants[0].variantId =
      "variant-forged";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        forgedIdentity,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const reusedRecommendationVariant = visionExperienceReport();
    reusedRecommendationVariant.ui.recommendationPresentation.onlineUnmatched.variantId =
      "variant-m";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        reusedRecommendationVariant,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const wrongTryOnIdentity = visionExperienceReport();
    wrongTryOnIdentity.ui.tryOnSelectedProduct.variantId = "variant-m";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        wrongTryOnIdentity,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const wrongUnavailableIdentity = visionExperienceReport();
    wrongUnavailableIdentity.ui.recommendationPresentation.visionUnavailable.variantId =
      "variant-m";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        wrongUnavailableIdentity,
        "vision-experience.json",
      ).status,
      "failed",
    );
  });

  it("lets the owning sale validator decide its business claim", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("sale"),
        saleReport(),
        "/reports/sale.json",
      ).status,
      "passed",
    );
  });

  it("accepts hardware lifecycle evidence only with QEMU role lifecycle and readiness revisions", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("hardwareLifecycle"),
        hardwareLifecycleReport(),
        "/reports/hardware-lifecycle.json",
      ).status,
      "passed",
    );
    const missingDisconnect = hardwareLifecycleReport();
    missingDisconnect.lifecycle[0].disconnect.daemon.ready = true;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("hardwareLifecycle"),
        missingDisconnect,
        "/reports/hardware-lifecycle.json",
      ).status,
      "failed",
    );
  });

  it("accepts environment control only with Admin, MQTT, daemon IPC, and lower serial evidence", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        environmentControlReport(),
        "/reports/environment-control.json",
      ).status,
      "passed",
    );
    const missingSerial = environmentControlReport();
    missingSerial.commands[2].serial.lowerBoundaryObserved = false;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        missingSerial,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const automaticB2 = environmentControlReport();
    automaticB2.commands[0].serial.automaticB3FrameCount = 1;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        automaticB2,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const automaticB1 = environmentControlReport();
    automaticB1.commands[3].serial.automaticB3FrameCount = 1;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        automaticB1,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const missingNextStableEdge = environmentControlReport();
    delete missingNextStableEdge.precedence.nextStableEdge;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        missingNextStableEdge,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const shortGuardWindow = environmentControlReport();
    shortGuardWindow.precedence.sameEdgeAfterAdmin.guardWindow.durationMs = 4_999;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        shortGuardWindow,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const delayedAutomaticRebound = environmentControlReport();
    delayedAutomaticRebound.precedence.sameEdgeAfterAdmin.guardWindow.protocolFrames.push(
      "B3",
    );
    delayedAutomaticRebound.precedence.sameEdgeAfterAdmin.guardWindow.b3FrameCountDelta = 1;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        delayedAutomaticRebound,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const nextStableEdgeWithExtraB3 = environmentControlReport();
    nextStableEdgeWithExtraB3.precedence.nextStableEdge.b3FrameCountDelta = 2;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        nextStableEdgeWithExtraB3,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const automaticPathSentB1 = environmentControlReport();
    automaticPathSentB1.precedence.automaticArrival.protocolFrames.push("B1");
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        automaticPathSentB1,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const automaticPathSentB2 = environmentControlReport();
    automaticPathSentB2.precedence.nextStableEdge.protocolFrames.push("B2");
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        automaticPathSentB2,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
  });

  it("accepts payment recovery only with terminal cleanup, customer projection, and later sale evidence", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentRecovery"),
        paymentRecoveryReport(),
        "/reports/payment-recovery.json",
      ).status,
      "passed",
    );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentRecovery"),
        {
          ...paymentRecoveryReport(),
          recoveryMqttEvidence: {
            mqtt: {
              topic: "vem/machines/M-1/commands/dispense",
              messages: [{ payload: { commandNo: "CMD-1" } }],
            },
          },
        },
        "/reports/payment-recovery.json",
      ).status,
      "failed",
    );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentRecovery"),
        {
          ...paymentRecoveryReport(),
          attempts: paymentRecoveryReport().attempts.slice(0, 3),
        },
        "/reports/payment-recovery.json",
      ).status,
      "failed",
    );
  });

  it("accepts local operations only with canonical planogram and manual slot evidence", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("localOperations"),
        localOperationsReport(),
        "/reports/local-operations.json",
      ).status,
      "passed",
    );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("localOperations"),
        {
          ...localOperationsReport(),
          manualDispense: {
            slotId: "slot-other",
            slotDisplayLabel: "R7C1",
            outcome: "completed",
          },
        },
        "/reports/local-operations.json",
      ).status,
      "failed",
    );
  });

  it("accepts presence and audio only with independent welcome/category native evidence", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("presenceAndAudio"),
        presenceAndAudioReport(),
        "/reports/presence-and-audio.json",
      ).status,
      "passed",
    );
    const duplicateWelcome = presenceAndAudioReport();
    duplicateWelcome.presenceAndAudio.runtimeTrace.splice(4, 0, {
      type: "audio_started",
      id: 50,
      at: "2026-07-22T08:00:02.000Z",
      recordedAt: "2026-07-22T08:00:02.000Z",
      transitionId: "vision:presence-2:welcome",
      requestId: "audio-request-50",
      terminalOutcomeId: null,
      outcome: null,
      message: "native",
    });
    assert.equal(
      validateBusinessCheckReport(
        descriptor("presenceAndAudio"),
        duplicateWelcome,
        "/reports/presence-and-audio.json",
      ).status,
      "failed",
    );
  });

  it("derives focused aggregation and canonical ordering from selected descriptors", () => {
    const descriptors = BUSINESS_CHECK_REGISTRY.filter((descriptor) =>
      ["sale", "ipcRecovery"].includes(descriptor.name),
    );
    const aggregate = buildFullWorkflowAggregate({
      mode: "fast",
      selectedDescriptors: descriptors,
      executedTracks: passingExecution(descriptors),
      evidenceManifestPath: "/reports/evidence.json",
    });
    assert.equal(aggregate.ok, true);
    assert.deepEqual(aggregate.execution.selectedBusinessSets, [
      "sale",
      "ipcRecovery",
    ]);
    assert.deepEqual(Object.keys(aggregate.businessSets), [
      "sale",
      "ipcRecovery",
    ]);
  });

  it("accepts only an unpaid, cleaned Alipay provider boundary", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentProvider"),
        paymentProviderReport(),
        "/reports/payment-provider.json",
      ).status,
      "passed",
    );
    const paid = paymentProviderReport();
    paid.authoritative.attempts[0].terminal.paymentStatus = "succeeded";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentProvider"),
        paid,
        "/reports/payment-provider.json",
      ).status,
      "failed",
    );
    const missingTerminal = paymentProviderReport();
    missingTerminal.authoritative.attempts[1].terminal = {
      reservedInventory: false,
    };
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentProvider"),
        missingTerminal,
        "/reports/payment-provider.json",
      ).status,
      "failed",
    );
    const reserved = paymentProviderReport();
    reserved.authoritative.attempts[0].terminal.reservedInventory = true;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentProvider"),
        reserved,
        "/reports/payment-provider.json",
      ).status,
      "failed",
    );
    const incompleteCleanup = paymentProviderReport();
    incompleteCleanup.authoritative.attempts[1].cleanup.serialSession.aborted = false;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentProvider"),
        incompleteCleanup,
        "/reports/payment-provider.json",
      ).status,
      "failed",
    );
  });

  it("accepts only the installed 1-to-0-to-2-to-1 stock maintenance loop", () => {
    const report = stockMaintenanceReport();
    assert.deepEqual(
      Object.values(report.screenshots).map((screenshot) => screenshot.slotId),
      ["slot-stock-1", "slot-stock-1", "slot-stock-1"],
    );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("stockMaintenance"),
        report,
        "/reports/stock-maintenance.json",
      ).status,
      "passed",
    );
    const duplicateRefill = stockMaintenanceReport();
    duplicateRefill.maintenance.refillMovementCount = 2;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("stockMaintenance"),
        duplicateRefill,
        "/reports/stock-maintenance.json",
      ).status,
      "failed",
    );
  });

  it("fails a full aggregate when a required registered set has incomplete evidence", () => {
    const blocked = BUSINESS_CHECK_REGISTRY.find(
      (descriptor) => descriptor.name === "paymentRecovery",
    );
    const aggregate = buildFullWorkflowAggregate({
      mode: "full",
      selectedDescriptors: [blocked],
      executedTracks: [
        {
          key: blocked.name,
          validator: validateBusinessCheckReport(blocked, null, null),
        },
      ],
    });
    assert.equal(aggregate.ok, false);
    assert.match(aggregate.failures[0].reason, /evidence is incomplete/);
  });

  it("uses the execution lifecycle final failure even when its validator passed", () => {
    const sale = descriptor("sale");
    const aggregate = buildFullWorkflowAggregate({
      mode: "fast",
      selectedDescriptors: [sale],
      executedTracks: [
        {
          key: sale.name,
          status: "failed",
          businessStatus: "failed",
          error: "terminal route is not settled: #/boot",
          validator: {
            key: sale.name,
            label: sale.name,
            status: "passed",
            reportPath: "/reports/sale.json",
          },
        },
      ],
    });

    assert.equal(aggregate.ok, false);
    assert.equal(aggregate.businessSets.sale.status, "failed");
    assert.equal(aggregate.businessOutcome.ok, false);
    assert.match(aggregate.failures[0].reason, /terminal route is not settled/);
  });
});

describe("full workflow stability gate", () => {
  it("compares the registered full business-set order across two reconstructed passes", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-stability-"));
    try {
      const descriptors = BUSINESS_CHECK_REGISTRY.filter(
        (descriptor) => descriptor.fullRequired,
      );
      const report = (reconstruction) => ({
        schemaVersion: "vem-local-testbed-full-workflow/v4",
        mode: "full",
        ok: true,
        businessSets: Object.fromEntries(
          descriptors.map((descriptor) => [
            descriptor.name,
            { status: "passed" },
          ]),
        ),
        execution: {
          selectedBusinessSets: descriptors.map(
            (descriptor) => descriptor.name,
          ),
        },
        identity: identity(reconstruction),
      });
      const passA = join(root, "pass-a.json");
      const passB = join(root, "pass-b.json");
      writeFileSync(passA, `${JSON.stringify(report("a"))}\n`);
      writeFileSync(passB, `${JSON.stringify(report("b"))}\n`);
      assert.equal(
        buildStabilityGateReport({
          commit: "c".repeat(40),
          passAPath: passA,
          passBPath: passB,
        }).ok,
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts observed retained caches regardless of filesystem enumeration order", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-stability-"));
    try {
      const report = (reconstruction) => {
        const workflowIdentity = identity(reconstruction);
        workflowIdentity.observedRetainedCaches = [
          ...workflowIdentity.observedRetainedCaches,
        ].sort();
        return {
          schemaVersion: "vem-local-testbed-full-workflow/v4",
          mode: "full",
          ok: true,
          businessSets: Object.fromEntries(
            BUSINESS_CHECK_REGISTRY.filter(
              (descriptor) => descriptor.fullRequired,
            ).map((descriptor) => [descriptor.name, { status: "passed" }]),
          ),
          execution: {
            selectedBusinessSets: BUSINESS_CHECK_REGISTRY.filter(
              (descriptor) => descriptor.fullRequired,
            ).map((descriptor) => descriptor.name),
          },
          identity: workflowIdentity,
        };
      };
      const passA = join(root, "pass-a.json");
      const passB = join(root, "pass-b.json");
      writeFileSync(passA, `${JSON.stringify(report("a"))}\n`);
      writeFileSync(passB, `${JSON.stringify(report("b"))}\n`);
      assert.equal(
        buildStabilityGateReport({
          commit: "c".repeat(40),
          passAPath: passA,
          passBPath: passB,
        }).ok,
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
