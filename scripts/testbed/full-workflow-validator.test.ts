import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { BUSINESS_CHECK_REGISTRY } from "./business-check-registry.ts";
import { buildStabilityGateReport } from "./full-workflow-stability-gate.ts";
import {
  buildFullWorkflowAggregate,
  validateBusinessCheckReport,
} from "./full-workflow-validator.ts";
import { buildPaymentCodeSubmission } from "./payment-provider-guest-full.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

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

function descriptor(name: string): JsonRecord {
  const entry = BUSINESS_CHECK_REGISTRY.find(
    (candidate) => candidate.name === name,
  );
  if (!entry) {
    throw new Error(`missing business check descriptor: ${name}`);
  }
  return entry as unknown as JsonRecord;
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
      catalogKey: "product:stock-product-1",
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
      visibleDetailStock: {
        route: "#/products/product:stock-product-1",
        catalogKey: "product:stock-product-1",
        variantId: "variant-stock-1",
        saleableStock: 2,
        text: "库存：2",
      },
    },
    secondSale: stockSale("2"),
    terminal: {
      daemon: {
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 1, reservedQty: 0 },
      visibleDetailStock: {
        route: "#/products/product:stock-product-1",
        catalogKey: "product:stock-product-1",
        variantId: "variant-stock-1",
        saleableStock: 1,
        text: "库存：1",
      },
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

function stockSale(index: unknown) {
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
    handoff: {
      previousControlPlaneSessionId: `stock-handoff-${index}`,
      replacementControlPlaneSessionId: `stock-pre-admission-${index}`,
    },
    gateCleanup: {
      paymentGateOpen: true,
      paymentGateVerified: true,
      serialSessionInactive: true,
      serialSessionId: `control-session-${index}`,
      freshControlPlaneSessionId: `control-session-${index}`,
      lowerControllerReady: true,
      saleStartReady: true,
    },
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

function environmentCommand(
  action: string,
  commandNo: string,
  resultJson: JsonRecord = {
    outcome: "accepted",
    acceptedRevision: 10,
    convergence: "pending",
  },
) {
  const expectedOpcode =
    action === "ventSpeed"
      ? "B3"
      : action === "targetTemperatureCelsius"
        ? "B1"
        : "B2";
  return {
    action,
    admin: { commandNo, status: "sent" },
    result: { status: "succeeded", resultJson },
    snapshot: {
      revision: resultJson.acceptedRevision,
      convergence: "applied",
    },
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
      protocolFrameObserved: true,
      expectedOpcode,
      b3FrameCount: action === "ventSpeed" ? 1 : 0,
      protocolFrame: {
        parsedOpcode: expectedOpcode,
        rawFrameHex:
          expectedOpcode === "B3"
            ? "55b302"
            : expectedOpcode === "B1"
              ? "55b117"
              : "55b201",
        capturedAt: "2026-07-22T08:00:05.000Z",
      },
    },
  };
}

function environmentControlReport() {
  return {
    schemaVersion: "vem-environment-control-guest-full/v2",
    ok: true,
    handoffSerialSessionId: "serial-replacement",
    serialSessionReplacement: {
      previousControlPlaneSessionId: "serial-previous",
      replacementControlPlaneSessionId: "serial-replacement",
    },
    commands: [
      environmentCommand("airConditionerOnTrue", "MCMD-1"),
      environmentCommand("airConditionerOnFalse", "MCMD-2"),
      environmentCommand("ventSpeed", "MCMD-3"),
      environmentCommand("targetTemperatureCelsius", "MCMD-4"),
    ],
    daemon: {
      health: { hardwareOnline: true },
      readiness: { ready: true },
      environmentControl: {
        health: {
          component: "environment_control",
          level: "ok",
          code: "ENVIRONMENT_CONTROL_APPLIED",
        },
      },
    },
    axisIndependence: {
      snapshots: Array.from({ length: 3 }, () => ({
        convergence: "applied",
        settings: { baseVentSpeed: 3 },
        desired: { ventSpeed: 0 },
      })),
    },
    persistentZero: {
      restore: {
        snapshot: {
          convergence: "applied",
          settings: { baseVentSpeed: 0 },
          desired: { ventSpeed: 0 },
        },
      },
    },
    temporaryStopRestore: {
      stop: {
        snapshot: {
          convergence: "applied",
          settings: { baseVentSpeed: 2 },
          desired: { ventSpeed: 0 },
        },
      },
      restore: {
        snapshot: {
          convergence: "applied",
          settings: { baseVentSpeed: 2 },
          desired: { ventSpeed: 2 },
        },
      },
    },
    idempotency: {
      first: { admission: { outcome: "accepted", acceptedRevision: 20 } },
      retry: {
        admission: { outcome: "deduplicated", acceptedRevision: 20 },
        serial: { protocolFrames: [] },
      },
    },
    explicitRetry: {
      admission: { outcome: "accepted", acceptedRevision: 20 },
      serial: {
        protocolFrame: { parsedOpcode: "B3", rawFrameHex: "55b302" },
      },
    },
    daemonRestart: {
      before: { revision: 20 },
      after: {
        revision: 20,
        convergence: "applied",
        settings: { baseVentSpeed: 2 },
        desired: { ventSpeed: 2 },
        confirmed: { ventSpeed: 2 },
      },
      frame: { parsedOpcode: "B3", rawFrameHex: "55b302" },
    },
    lowerControllerReconnect: {
      disconnectedSessionId: "serial-replacement",
      reconnectedSessionId: "serial-reconnected",
      admission: { outcome: "accepted", acceptedRevision: 21 },
      offlineSnapshot: {
        revision: 21,
        convergence: "offline",
        settings: { baseVentSpeed: 4 },
        desired: { ventSpeed: 4 },
      },
      snapshot: {
        revision: 21,
        convergence: "applied",
        confirmed: { ventSpeed: 4 },
      },
      frame: { parsedOpcode: "B3", rawFrameHex: "55b304" },
    },
    cleanup: {
      snapshot: {
        convergence: "applied",
        settings: {
          airConditionerEnabled: false,
          targetTemperatureCelsius: 26,
          baseVentSpeed: 3,
        },
        desired: { ventSpeed: 0 },
      },
    },
    boundaries: {
      adminApi: true,
      mqtt: true,
      daemonIpc: true,
      lowerSerial: true,
      daemonRestart: true,
      lowerControllerReconnect: true,
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
                  entry: {
                    id: 1,
                    technicalMessage:
                      "BACKEND_API_ERROR: 502 支付通道暂不可用，请稍后重试",
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
        orderNo: "order-no-paid",
        paymentId: "payment-paid",
        commandId: "command-paid",
        inventoryId: "inventory-payment-recovery",
      },
      terminal: {
        paymentStatus: "succeeded",
        orderStatus: "fulfilled",
        fulfillmentState: "dispensed",
      },
      inventory: { beforeOnHandQty: 3, afterOnHandQty: 2, movementCount: 1 },
      serial: { protocol: ["VEND", "F0", "F1", "F2"], stopped: true },
      customer: {
        route: "#/result/success",
        orderId: "order-paid",
        paymentId: "payment-paid",
        orderNo: "order-no-paid",
        commandId: "command-paid",
        resultKind: "success",
      },
    },
    saleabilityRecovery: {
      source: "daemon_sale_view_and_installed_machine_runtime_cdp",
      route: "#/catalog",
      categories: [
        { key: "socks", daemonSaleableItemCount: 4, saleableProductCount: 4 },
        {
          key: "underwear",
          daemonSaleableItemCount: 4,
          saleableProductCount: 4,
        },
        { key: "tshirts", daemonSaleableItemCount: 4, saleableProductCount: 4 },
      ],
    },
    assertions: { duplicatePaymentCount: 0 },
  };
}

function paymentProviderReport() {
  return {
    schemaVersion: "vem-payment-provider-guest-full/v1",
    ok: true,
    outcome: "passed",
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
            action: "close_or_reverse_uncertain_payment",
            closure: { handled: true },
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
    localEnvironmentControl: {
      request: {
        actionId: "local-operations:run-1:base-vent-3",
        source: "local_operator",
        action: { type: "set_base_vent_speed", ventSpeed: 3 },
      },
      admission: { outcome: "accepted", acceptedRevision: 4 },
      snapshot: {
        convergence: "applied",
        settings: { baseVentSpeed: 3 },
        desired: { ventSpeed: 3 },
      },
      protocolFrame: { parsedOpcode: "B3", rawFrameHex: "55b303" },
    },
    maintenanceEntry: {
      entries: ["#/catalog"].map((route) => ({
        route,
        selector:
          "[data-test='maintenance-entry-brand'], [data-test='maintenance-entry-header']",
        finalRoute: "#/maintenance?source=operator",
        ok: true,
      })),
      taskReturns: ["status"].map((task) => ({
        task,
        selector: `[data-test='maintenance-task-${task}']`,
        returnSelector: "[data-test='maintenance-return-catalog']",
        finalRoute: "#/catalog",
        ok: true,
      })),
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
          initialFenceTraceId: 0,
          duplicateFenceTraceId: 4,
          initialTransitionId: "vision:presence-1:welcome",
          departureTransitionId: "vision:presence-2:departed",
          transientFenceTraceId: 4,
          rearmedFenceTraceId: 5,
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
      presenceVent: {
        protocolFrames: [
          {
            parsedOpcode: "B3",
            rawFrameHex: "55b303",
            capturedAt: "2026-07-22T08:00:00.000Z",
          },
          {
            parsedOpcode: "B3",
            rawFrameHex: "55b300",
            capturedAt: "2026-07-22T08:00:10.000Z",
          },
          {
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
            capturedAt: "2026-07-22T08:00:11.000Z",
          },
        ],
        speeds: [3, 0, 2],
        guardElapsedMs: 10_000,
        edgeCorrelation: [
          {
            edgeId: "presence-1:arrival",
            transitionId: "vision:presence-1:welcome",
            speed: 3,
            frame: {
              parsedOpcode: "B3",
              rawFrameHex: "55b303",
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
          {
            edgeId: "presence-3:arrival",
            transitionId: "vision:presence-3:welcome",
            speed: 2,
            frame: {
              parsedOpcode: "B3",
              rawFrameHex: "55b302",
              capturedAt: "2026-07-22T08:00:11.000Z",
            },
          },
        ],
        operatorSetting: {
          commandNo: "environment-command-1",
          requestedSpeed: 2,
          resultStatus: "succeeded",
          frame: {
            parsedOpcode: "B3",
            rawFrameHex: "55b302",
            capturedAt: "2026-07-22T08:00:05.000Z",
          },
          duplicateSameEdge: {
            actionId: "presence-1:arrival",
            outcome: "deduplicated",
          },
        },
      },
    },
  };
}

function identity(reconstruction: string) {
  const caches = [
    "D:\\runtime-cache\\v1\\pnpm-store",
    "D:\\runtime-cache\\v1\\pnpm-virtual-store",
    "D:\\runtime-cache\\v1\\cargo-home",
    "D:\\runtime-cache\\v1\\target",
    "D:\\runtime-cache\\v1\\sccache",
    "D:\\runtime-cache\\v1\\turbo",
    "D:\\runtime-cache\\v1\\vision-main",
    "D:\\runtime-cache\\v1\\acceptance-inputs",
    "D:\\runtime-cache\\v1\\powershell",
  ];
  return {
    githubSha: "c".repeat(40),
    backend: {
      serviceApi: {
        build: { byteSize: 10, fileCount: 1, sha256: "1".repeat(64) },
        runtime: {
          database: "ok",
          entrypoint: "main.js",
          health: "ready",
          mqtt: "connected",
        },
      },
      adminUi: {
        build: { byteSize: 11, fileCount: 1, sha256: "2".repeat(64) },
        delivery: {
          entrypoint: "index.html",
          observedHttp: {
            byteSize: 11,
            method: "GET",
            responseSha256: "2".repeat(64),
            status: 200,
          },
        },
      },
    },
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
      sourceDigest: "3".repeat(64),
      reusedFromPass1: reconstruction === "b",
      artifacts: {
        daemon: { sha256: "d".repeat(64) },
        machine: { sha256: "e".repeat(64) },
        webViewLoader: { sha256: "f".repeat(64) },
      },
    },
    visionCore: {
      sha256: "4".repeat(64),
      runtimeArchive: {
        byteSize: 12,
        sha256: "5".repeat(64),
        sourceCommit: "d".repeat(40),
      },
      recordedFixtureArchive: {
        byteSize: 13,
        sha256: "6".repeat(64),
        sourceCommit: "d".repeat(40),
      },
    },
  };
}

function passingExecution(descriptors: JsonRecord[]) {
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

function visionExperienceCapturedReport({
  visionOrigin = "http://127.0.0.1:27892",
}: {
  visionOrigin?: string;
} = {}) {
  const attemptId = "550e8400-e29b-41d4-a716-446655440124";
  const requestId = "vision-websocket-1";
  const captured = {
    reference: `${visionOrigin}/v2/try-on/captured/frame.png?token=captured-token`,
    digest: `sha256:${"a".repeat(64)}`,
    contentType: "image/png",
    byteSize: 2048,
    width: 640,
    height: 480,
    frameId: "frame-000042",
  };
  const resource = {
    attemptId,
    capturedDigest: captured.digest,
    capturedFrameId: captured.frameId,
    visionOrigin,
    reference: captured.reference,
    finalUrl: captured.reference,
    ok: true,
    httpStatus: 200,
    contentType: captured.contentType,
    byteSize: captured.byteSize,
    digest: captured.digest,
    width: captured.width,
    height: captured.height,
  };
  const result = {
    reference: `${visionOrigin}/v2/try-on/results/${attemptId}?token=result-token`,
    digest: `sha256:${"b".repeat(64)}`,
    contentType: "image/png",
    byteSize: 8192,
    width: 640,
    height: 480,
  };
  const protocolTimeline = [
    {
      type: "vision.try_on.attempt.accepted",
      requestId,
      origin: visionOrigin,
      payload: { attemptId },
    },
    {
      type: "vision.try_on.attempt.acquiring",
      requestId,
      origin: visionOrigin,
      payload: {
        attemptId,
        preview: {
          reference: `${visionOrigin}/v2/try-on/acquisition/preview.mjpeg?token=preview-token`,
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "counting_down",
        manualCaptureAllowed: true,
        holdRemainingMs: 3_000,
      },
    },
    {
      type: "vision.try_on.attempt.captured",
      requestId,
      origin: visionOrigin,
      payload: { attemptId, captured },
    },
    {
      type: "vision.try_on.attempt.generating",
      requestId,
      origin: visionOrigin,
      payload: { attemptId, stage: "generating" },
    },
    {
      type: "vision.try_on.attempt.completed",
      requestId,
      origin: visionOrigin,
      payload: { attemptId, result },
    },
  ];
  const binding = {
    attemptId,
    visionOrigin,
    requestId,
    captured,
    resource,
    terminal: protocolTimeline.at(-1),
  };
  return {
    schemaVersion: "vem-runtime-testbed-report/v2",
    runId: "RUN-1",
    mode: "fast",
    pass: 1,
    businessSets: [
      {
        name: "visionExperience",
        status: "passed",
        primaryFailure: null,
        assertionCount: 13,
        assertions: [
          {
            schemaVersion: "vem-runtime-testbed-business-assertion/v1",
            id: "captured-source-bound",
            source: "vision-v2-protocol",
            expected: binding,
            observed: binding,
            status: "passed",
            reason: null,
          },
          ...[
            "countdown-rendered-sequence",
            "countdown-visible-duration",
            "countdown-protocol-dom-consistent",
            "captured-absent-outside-held",
            "capture-after-countdown",
            "preview-live-through-countdown",
            "captured-frame-held-during-generation",
          ].map((id) => ({
            schemaVersion: "vem-runtime-testbed-business-assertion/v1",
            id,
            source: "vision-experience-observation-timeline",
            expected: true,
            observed: true,
            status: "passed",
            reason: null,
          })),
          ...[
            "result-sleeves-retained",
            "result-uniform-placement",
            "result-automatic-scale",
            "garment-scale-renders-pixels",
          ].map((id) => ({
            schemaVersion: "vem-runtime-testbed-business-assertion/v1",
            id,
            source: "vision-result-png-pixels",
            expected: true,
            observed: true,
            status: "passed",
            reason: null,
          })),
          {
            schemaVersion: "vem-runtime-testbed-business-assertion/v1",
            id: "garment-scale-v2-adjustment-sequence",
            source: "vision-v2-protocol",
            expected: true,
            observed: true,
            status: "passed",
            reason: null,
          },
        ],
        supportingEvidence: [
          {
            kind: "vision-v2-captured-source",
            ...binding,
            protocolTimeline,
          },
        ],
      },
    ],
  };
}

function implicitRecommendationReport() {
  const assertionSources = [
    ["near.neutral-visible-within-500ms", "machine.runtime_trace+semantic_dom"],
    ["near.stable-ten-seconds", "semantic_dom+machine.runtime_trace"],
    ["near.catalog-detail-chinese-size", "semantic_dom"],
    ["near.departure-once", "machine.runtime_trace+semantic_dom"],
    ["far.neutral-visible-within-500ms", "machine.runtime_trace+semantic_dom"],
    ["far.stable-ten-seconds", "semantic_dom+machine.runtime_trace"],
    ["far.catalog-detail-chinese-size", "semantic_dom"],
    ["far.departure-once", "machine.runtime_trace+semantic_dom"],
    ["sessions.distinct", "machine.runtime_trace+fixture_restore"],
  ] as const;
  return {
    schemaVersion: "vem-runtime-testbed-report/v2",
    runId: "RUN-RECOMMENDATION-1",
    mode: "full",
    pass: 1,
    businessSets: [
      {
        name: "implicitRecommendation",
        status: "passed",
        primaryFailure: null,
        assertionCount: assertionSources.length,
        assertions: assertionSources.map(([id, source]) => ({
          schemaVersion: "vem-runtime-testbed-business-assertion/v1",
          id,
          source,
          expected: { passed: true },
          observed: { passed: true },
          status: "passed",
          reason: null,
        })),
        supportingEvidence: [],
      },
    ],
  };
}

describe("full workflow aggregate validator", () => {
  it("rejects vision experience reports outside the V2 business-set contract", () => {
    const rejected = validateBusinessCheckReport(
      descriptor("visionExperience"),
      { schemaVersion: "retired-report/v1", ok: true },
      "vision-experience.json",
    );
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason ?? "", /requires a V2 business-set report/);
  });

  it("accepts a V2 vision experience report only with captured source evidence", () => {
    const report = visionExperienceCapturedReport();
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        report,
        "vision-experience.json",
      ).status,
      "passed",
    );

    const missingCaptured = structuredClone(report);
    missingCaptured.businessSets[0].supportingEvidence = [];
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        missingCaptured,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const missingGeometryFixture = structuredClone(report);
    const missingGeometryBusinessSet = recordValue(
      arrayValue(missingGeometryFixture.businessSets)[0],
    );
    missingGeometryBusinessSet.status = "failed";
    missingGeometryBusinessSet.primaryFailure = {
      schemaVersion: "vem-runtime-testbed-business-assertion/v1",
      id: "result-automatic-scale",
      source: "vision-result-png-pixels",
      expected: true,
      observed: false,
      status: "failed",
      reason: "expected true observed false",
    };
    arrayValue(missingGeometryBusinessSet.supportingEvidence).push({
      kind: "vision-recorded-geometry-fixture",
      status: "blocked",
      reason: "候选未提供动态 far/mid/near 录播夹具",
      segments: ["far"],
    });
    const fixtureBlocked = validateBusinessCheckReport(
      descriptor("visionExperience"),
      missingGeometryFixture,
      "vision-experience.json",
    );
    assert.equal(fixtureBlocked.status, "failed");
    assert.match(fixtureBlocked.reason ?? "", /几何录播夹具不可用/);

    const urlOnlyScale = structuredClone(report);
    urlOnlyScale.businessSets[0].assertions =
      urlOnlyScale.businessSets[0].assertions.filter(
        (assertion) => assertion.id !== "garment-scale-renders-pixels",
      );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        urlOnlyScale,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const missingTimelineAssertion = structuredClone(report);
    missingTimelineAssertion.businessSets[0].assertions =
      missingTimelineAssertion.businessSets[0].assertions.filter(
        (assertion) => assertion.id !== "preview-live-through-countdown",
      );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        missingTimelineAssertion,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const missingCountdownDuration = structuredClone(report);
    missingCountdownDuration.businessSets[0].assertions =
      missingCountdownDuration.businessSets[0].assertions.filter(
        (assertion) => assertion.id !== "countdown-visible-duration",
      );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        missingCountdownDuration,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const invalidCapturedReference = structuredClone(report);
    invalidCapturedReference.businessSets[0].supportingEvidence[0].captured.reference =
      "http://127.0.0.1:99999/v2/try-on/captured/frame.png?token=captured-token";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        invalidCapturedReference,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const failedAssertion = structuredClone(report);
    const failedBusinessSet = recordValue(
      arrayValue(failedAssertion.businessSets)[0],
    );
    failedBusinessSet.status = "failed";
    failedBusinessSet.primaryFailure = {
      id: "result-surface",
      reason: "expected completed",
    };
    const failed = validateBusinessCheckReport(
      descriptor("visionExperience"),
      failedAssertion,
      "vision-experience.json",
    );
    assert.equal(failed.status, "failed");
    assert.match(failed.reason ?? "", /expected completed/);
  });

  it("rejects a forged captured binding instead of trusting schema-valid support facts", () => {
    const report = visionExperienceCapturedReport();
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        report,
        "vision-experience.json",
      ).status,
      "passed",
    );

    const wrongAttempt = structuredClone(report);
    wrongAttempt.businessSets[0].supportingEvidence[0].attemptId =
      "550e8400-e29b-41d4-a716-446655440125";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        wrongAttempt,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const inventedFrame = structuredClone(report);
    inventedFrame.businessSets[0].supportingEvidence[0].captured.frameId =
      "invented-frame";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        inventedFrame,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const foreignVisionOrigin = visionExperienceCapturedReport({
      visionOrigin: "http://127.0.0.1:27893",
    });
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        foreignVisionOrigin,
        "vision-experience.json",
        { visionBaseUrl: "http://127.0.0.1:27893" },
      ).status,
      "passed",
    );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        foreignVisionOrigin,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const missingBindingAssertion = structuredClone(report);
    delete recordValue(arrayValue(missingBindingAssertion.businessSets)[0])
      .assertions;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        missingBindingAssertion,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const forgedBindingAssertion = structuredClone(report);
    recordValue(arrayValue(forgedBindingAssertion.businessSets)[0]).assertions =
      [
        {
          schemaVersion: "vem-runtime-testbed-business-assertion/v1",
          id: "captured-source-bound",
          source: "vision-v2-protocol",
          expected: { verified: true },
          observed: { verified: true },
          status: "passed",
          reason: null,
        },
      ];
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        forgedBindingAssertion,
        "vision-experience.json",
      ).status,
      "failed",
    );
  });

  it("accepts implicit recommendation only from all exact public business assertions", () => {
    const report = implicitRecommendationReport();
    assert.equal(
      validateBusinessCheckReport(
        descriptor("implicitRecommendation"),
        report,
        "implicit-recommendation.json",
      ).status,
      "passed",
    );

    const missing = structuredClone(report);
    missing.businessSets[0].assertions.pop();
    missing.businessSets[0].assertionCount -= 1;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("implicitRecommendation"),
        missing,
        "implicit-recommendation.json",
      ).status,
      "failed",
    );

    const wrongSource = structuredClone(report);
    (wrongSource.businessSets[0].assertions[0] as { source: string }).source =
      "screenshot";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("implicitRecommendation"),
        wrongSource,
        "implicit-recommendation.json",
      ).status,
      "failed",
    );

    const duplicate = structuredClone(report);
    duplicate.businessSets[0].assertions.push(
      structuredClone(duplicate.businessSets[0].assertions[0]),
    );
    duplicate.businessSets[0].assertionCount += 1;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("implicitRecommendation"),
        duplicate,
        "implicit-recommendation.json",
      ).status,
      "failed",
    );

    const forgedEquality = structuredClone(report);
    forgedEquality.businessSets[0].assertions[1].observed = { passed: false };
    assert.equal(
      validateBusinessCheckReport(
        descriptor("implicitRecommendation"),
        forgedEquality,
        "implicit-recommendation.json",
      ).status,
      "failed",
    );

    const failed = structuredClone(report);
    const failedSet = failed.businessSets[0] as unknown as {
      status: string;
      primaryFailure: unknown;
    };
    failedSet.status = "failed";
    failedSet.primaryFailure = {
      id: "near.stable-ten-seconds",
      reason: "banner flickered",
    };
    const verdict = validateBusinessCheckReport(
      descriptor("implicitRecommendation"),
      failed,
      "implicit-recommendation.json",
    );
    assert.equal(verdict.status, "failed");
    assert.match(verdict.reason ?? "", /banner flickered/);
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
    const missingRestore = environmentControlReport();
    delete recordValue(missingRestore.temporaryStopRestore).restore;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        missingRestore,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const dedupeChangedRevision = environmentControlReport();
    dedupeChangedRevision.idempotency.retry.admission.acceptedRevision = 22;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        dedupeChangedRevision,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const dedupeEmittedFrame = environmentControlReport();
    recordValue(dedupeEmittedFrame.idempotency.retry.serial).protocolFrames = [
      "B3",
    ];
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        dedupeEmittedFrame,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const retryIncrementedRevision = environmentControlReport();
    retryIncrementedRevision.explicitRetry.admission.acceptedRevision = 21;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        retryIncrementedRevision,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const restartChangedRevision = environmentControlReport();
    restartChangedRevision.daemonRestart.after.revision = 21;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        restartChangedRevision,
        "/reports/environment-control.json",
      ).status,
      "failed",
    );
    const offlineWasNotObserved = environmentControlReport();
    offlineWasNotObserved.lowerControllerReconnect.offlineSnapshot.convergence =
      "pending";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("environmentControl"),
        offlineWasNotObserved,
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
    const allProductsUnavailable = paymentRecoveryReport();
    allProductsUnavailable.saleabilityRecovery = {
      source: "daemon_sale_view_and_installed_machine_runtime_cdp",
      route: "#/catalog",
      categories: [
        { key: "socks", daemonSaleableItemCount: 4, saleableProductCount: 0 },
        {
          key: "underwear",
          daemonSaleableItemCount: 4,
          saleableProductCount: 0,
        },
        { key: "tshirts", daemonSaleableItemCount: 4, saleableProductCount: 0 },
      ],
    };
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentRecovery"),
        allProductsUnavailable,
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
    assert.equal(
      validateBusinessCheckReport(
        descriptor("localOperations"),
        {
          ...localOperationsReport(),
          maintenanceEntry: {
            entries: [
              {
                route: "#/catalog",
                finalRoute: "#/catalog",
                ok: true,
              },
            ],
            taskReturns: [
              { task: "status", finalRoute: "#/catalog", ok: true },
            ],
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

  it("accepts startup only from installed-owner readiness evidence", () => {
    const report = {
      schemaVersion: "vem-installed-runtime-startup-acceptance/v1",
      ok: true,
      mode: "fast",
      summary: {
        daemonService: "VemVendingDaemon",
        machineUiTask: "VEMMachineUI",
        visionTask: "VEMVisionRuntime",
        kioskSessionId: 3,
        catalogRoute: "#/catalog",
        modeEvidence: {
          source: "installed_owner_stop_start",
          ownerRestartMarker: "owner-restart:001",
        },
      },
    };
    assert.equal(
      validateBusinessCheckReport(
        descriptor("startup"),
        report,
        "/reports/startup-owner-readiness.json",
      ).status,
      "passed",
    );
    assert.equal(
      validateBusinessCheckReport(
        descriptor("startup"),
        { ...report, summary: { ...report.summary, visionTask: null } },
        "/reports/startup-owner-readiness.json",
      ).status,
      "failed",
    );
    const falseFull = structuredClone(report);
    falseFull.mode = "full";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("startup"),
        falseFull,
        "/reports/startup-owner-readiness.json",
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
    assert.deepEqual(recordValue(aggregate.execution).selectedBusinessSets, [
      "sale",
      "ipcRecovery",
    ]);
    assert.deepEqual(Object.keys(recordValue(aggregate.businessSets)), [
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
    const manualHandling = paymentProviderReport();
    const firstAttempt = recordValue(
      arrayValue(manualHandling.authoritative.attempts)[0],
    );
    recordValue(firstAttempt.closure).status = "manual_handling";
    firstAttempt.terminal = {
      paymentStatus: "unknown",
      orderStatus: "manual_handling",
      paymentState: "manual_handling",
      reservedInventory: false,
    };
    assert.equal(
      validateBusinessCheckReport(
        descriptor("paymentProvider"),
        manualHandling,
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
    recordValue(
      arrayValue(missingTerminal.authoritative.attempts)[1],
    ).terminal = {
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
    recordValue(
      recordValue(
        recordValue(arrayValue(incompleteCleanup.authoritative.attempts)[1])
          .cleanup,
      ).serialSession,
    ).aborted = false;
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
    const blocked = descriptor("paymentRecovery");
    const aggregate = buildFullWorkflowAggregate({
      mode: "full",
      selectedDescriptors: [blocked],
      executedTracks: [
        {
          key: blocked.name,
          validator: validateBusinessCheckReport(
            blocked,
            null,
            "/reports/payment-recovery.json",
          ),
        },
      ],
    });
    assert.equal(aggregate.ok, false);
    assert.match(
      String(recordValue(arrayValue(aggregate.failures)[0]).reason),
      /evidence is incomplete/,
    );
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
    assert.equal(
      recordValue(recordValue(aggregate.businessSets).sale).status,
      "failed",
    );
    assert.equal(recordValue(aggregate.businessOutcome).ok, false);
    assert.match(
      String(recordValue(arrayValue(aggregate.failures)[0]).reason),
      /terminal route is not settled/,
    );
  });
});

describe("full workflow stability gate", () => {
  it("compares the registered full business-set order across two reconstructed passes", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-stability-"));
    try {
      const descriptors = BUSINESS_CHECK_REGISTRY.filter(
        (descriptor) => descriptor.fullRequired,
      );
      const report = (reconstruction: string) => ({
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
      const gate = buildStabilityGateReport({
        commit: "c".repeat(40),
        passAPath: passA,
        passBPath: passB,
      });
      assert.equal(gate.ok, true);
      assert.match(
        String(gate.acceptanceReleaseManifestSha256),
        /^[a-f0-9]{64}$/,
      );
      assert.equal(
        recordValue(gate.acceptanceReleaseManifest).schemaVersion,
        "vem-runtime-testbed-acceptance-release/v1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains observed cache evidence without making it a drift gate", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-stability-"));
    try {
      const report = (reconstruction: string) => {
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

  it("fails when pass two changes one accepted release artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-release-drift-"));
    try {
      const descriptors = BUSINESS_CHECK_REGISTRY.filter(
        (descriptor) => descriptor.fullRequired,
      );
      const report = (reconstruction: string) => ({
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
      const first = report("a");
      const second = report("b");
      second.identity.backend.adminUi.build.sha256 = "9".repeat(64);
      const passA = join(root, "pass-a.json");
      const passB = join(root, "pass-b.json");
      writeFileSync(passA, `${JSON.stringify(first)}\n`);
      writeFileSync(passB, `${JSON.stringify(second)}\n`);
      const gate = buildStabilityGateReport({
        commit: "c".repeat(40),
        passAPath: passA,
        passBPath: passB,
      });
      assert.equal(gate.ok, false);
      assert.ok(
        arrayValue(gate.gateFailures).includes(
          "acceptance release pass 2 drifted from pass 1",
        ),
      );
      assert.equal("acceptanceReleaseManifest" in gate, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("withholds the acceptance release manifest when any other stability gate fails", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-release-failed-"));
    try {
      const descriptors = BUSINESS_CHECK_REGISTRY.filter(
        (descriptor) => descriptor.fullRequired,
      );
      const report = (reconstruction: string) => ({
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
      const first = report("a");
      const second = report("b");
      second.businessSets.sale.status = "failed";
      const passA = join(root, "pass-a.json");
      const passB = join(root, "pass-b.json");
      const out = join(root, "full-workflow-stability-gate.json");
      writeFileSync(passA, `${JSON.stringify(first)}\n`);
      writeFileSync(passB, `${JSON.stringify(second)}\n`);
      const gate = buildStabilityGateReport({
        commit: "c".repeat(40),
        passAPath: passA,
        passBPath: passB,
      });
      assert.equal(gate.ok, false);
      assert.equal("acceptanceReleaseManifest" in gate, false);
      assert.equal("acceptanceReleaseManifestSha256" in gate, false);
      const result = spawnSync(
        process.execPath,
        [
          new URL("./full-workflow-stability-gate.ts", import.meta.url)
            .pathname,
          "--commit",
          "c".repeat(40),
          "--pass-a",
          passA,
          "--pass-b",
          passB,
          "--out",
          out,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.equal(
        existsSync(join(root, "acceptance-release-manifest.json")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
