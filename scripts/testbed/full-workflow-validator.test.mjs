import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    health: {
      vision: {
        protocolSummary: {
          protocol: "vem.vision.v2",
          presenceDetectedAt: "2026-07-22T00:00:02.000Z",
          profileDetectedAt: "2026-07-22T00:00:03.000Z",
          departureDetectedAt: "2026-07-22T00:00:04.000Z",
          eventFence: {
            source: "installed_machine_runtime_trace_generation",
            runtimeGenerationId: "runtime:vision-acceptance",
            lastEntryId: 4,
            visionStartedAt: "2026-07-22T00:00:01.000Z",
          },
        },
      },
    },
    visionInstall: {
      runtimeExpectation: {
        recommendationVariants: [
          { productId: "product-t", variantId: "variant-s", size: "S" },
          { productId: "product-t", variantId: "variant-m", size: "M" },
        ],
        productMedia: [
          {
            categoryKey: "socks",
            catalogKey: "product-socks",
            coverImageUrl: "/api/media-assets/main-socks/content",
          },
          {
            categoryKey: "underwear",
            catalogKey: "product-underwear",
            coverImageUrl: "/api/media-assets/main-underwear/content",
          },
          {
            categoryKey: "tshirts",
            catalogKey: "product-tshirts",
            coverImageUrl: "/api/media-assets/main-tshirts/content",
          },
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
        automatic: { variantId: "variant-s", recommendedSize: "S" },
        onlineUnmatched: { variantId: "variant-online", recommendedSize: null },
        manual: { variantId: "variant-m", recommendedSize: null },
        visionUnavailable: { variantId: "variant-m", recommendedSize: null },
      },
      tryOnSelectedProduct: { variantId: "variant-m" },
      tryOnSummary: {
        attemptId: "attempt-fast-1",
        resultUrl:
          "http://127.0.0.1:7892/v2/try-on/results/attempt-fast-1?token=result-token",
        contentType: "image/png",
        byteLength: 2048,
        width: 640,
        height: 480,
      },
      tryOnAttempts: [{ result: "passed" }],
      mediaPresentation: {
        source: "installed_machine_runtime_cdp",
        productCards: [
          {
            categoryKey: "socks",
            catalogKey: "product-socks",
            expectedMainImageUrl: "/api/media-assets/main-socks/content",
            mainImageUrl: "/api/media-assets/main-socks/content",
            finalUrl: "/api/media-assets/main-socks/content",
            httpStatus: 200,
            naturalWidth: 320,
            naturalHeight: 320,
          },
          {
            categoryKey: "underwear",
            catalogKey: "product-underwear",
            expectedMainImageUrl: "/api/media-assets/main-underwear/content",
            mainImageUrl: "/api/media-assets/main-underwear/content",
            finalUrl: "/api/media-assets/main-underwear/content",
            httpStatus: 200,
            naturalWidth: 320,
            naturalHeight: 320,
          },
          {
            categoryKey: "tshirts",
            catalogKey: "product-tshirts",
            expectedMainImageUrl: "/api/media-assets/main-tshirts/content",
            mainImageUrl: "/api/media-assets/main-tshirts/content",
            finalUrl: "/api/media-assets/main-tshirts/content",
            httpStatus: 200,
            naturalWidth: 320,
            naturalHeight: 320,
          },
        ],
      },
    },
  };
}

function aiVirtualTryOnReport() {
  const attempt = ({ caseKey, template, attemptId, suffix }) => ({
    attemptId,
    caseKey,
    template,
    mode: "ai",
    stateTrace: ["acquiring", "generating", "completed"],
    input: { contentType: "image/png", sha256: suffix.repeat(64) },
    garment: {
      contentType: "image/png",
      garmentId:
        caseKey === "short"
          ? "0198f44e-21bd-7c62-8f52-b7c86cc2c001"
          : "0198f44e-21bd-7c62-8f52-b7c86cc2c002",
      sha256: String(Number(suffix) + 1).repeat(64),
    },
    result: {
      contentType: "image/png",
      decodedWidth: 768,
      decodedHeight: 1024,
      durationMs: 12_000,
      peakRssBytes: 512 * 1024 * 1024,
      sha256: String(Number(suffix) + 2).repeat(64),
    },
    outputFacts: {
      decodable: true,
      differsFromGarment: true,
      differsFromInput: true,
      nonPlaceholder: true,
    },
    regionalEvidence: {
      path: `regional/${caseKey}/${attemptId}.regional-evidence.json`,
      schemaVersion: "vem-ai-regional-evidence-reference/v1",
      sha256: String(Number(suffix) + 3).repeat(64),
      verdict: "passed",
    },
    screenshots: ["acquisition", "result"].map((stage) => ({
      byteLength: 64,
      path: `screenshots/${caseKey}/${attemptId}-${stage}.png`,
      sha256: String(
        stage === "acquisition" ? suffix : Number(suffix) + 4,
      ).repeat(64),
      stage,
    })),
  });
  const attempts = [
    attempt({
      caseKey: "short",
      template: "tshirt_short_sleeve",
      attemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2b001",
      suffix: "1",
    }),
    attempt({
      caseKey: "long",
      template: "tshirt_long_sleeve",
      attemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2b002",
      suffix: "5",
    }),
  ];
  attempts[0].journey = {
    catalogRoute: "#/catalog",
    categorySelector:
      '[data-test="catalog-category"][data-category-key="tshirts"]',
    productRoute: "#/products/product:short",
    productSelector:
      '[data-test="catalog-product"][data-catalog-key="product:short"]',
    resultAttemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2b003",
    resultRoute:
      "#/try-on?catalogKey=product:short&variantId=0198f44e-21bd-7c62-8f52-b7c86cc2d001",
    returnedCatalogRoute: "#/catalog",
    returnProductRoute: "#/products/product:short",
    selectedCatalogKey: "product:short",
    selectedVariantId: "0198f44e-21bd-7c62-8f52-b7c86cc2d001",
    startSelector: '[data-test="try-on-ai"]',
  };
  attempts[0].retry = {
    completedAttemptId: attempts[0].attemptId,
    lifecycle: ["acquiring", "generating", "completed"],
    result: {
      decodedHeight: 1024,
      decodedWidth: 768,
      sha256: "f".repeat(64),
    },
    retriedAttemptId: "0198f44e-21bd-7c62-8f52-b7c86cc2b003",
  };
  attempts[1].journey = {
    catalogRoute: "#/catalog",
    categorySelector:
      '[data-test="catalog-category"][data-category-key="tshirts"]',
    productRoute: "#/products/product:long",
    productSelector:
      '[data-test="catalog-product"][data-catalog-key="product:long"]',
    resultAttemptId: attempts[1].attemptId,
    resultRoute:
      "#/try-on?catalogKey=product:long&variantId=0198f44e-21bd-7c62-8f52-b7c86cc2d005",
    returnedCatalogRoute: "#/catalog",
    returnProductRoute: "#/products/product:long",
    selectedCatalogKey: "product:long",
    selectedVariantId: "0198f44e-21bd-7c62-8f52-b7c86cc2d005",
    startSelector: '[data-test="try-on-ai"]',
  };
  return {
    schemaVersion: "vem-ai-virtual-try-on-acceptance/v2",
    ok: true,
    error: null,
    reasons: [],
    calibration: {
      policySha256: "sha256:" + "a".repeat(64),
      receiptSha256: "sha256:" + "b".repeat(64),
    },
    execution: {
      source: "installed_machine_ui_cdp",
      protocol: "vem.vision.v2",
      noDirectWorker: true,
      recordedSources: ["front", "top"],
      identities: {
        runtime: "sha256:" + "1".repeat(64),
        contract: "sha256:" + "2".repeat(64),
        aiRuntime: "sha256:" + "3".repeat(64),
        modelPack: "sha256:" + "4".repeat(64),
      },
    },
    attempts,
    postAi: {
      browseAvailable: true,
      saleAvailable: true,
      ordinarySaleCompleted: true,
    },
    degradations: Object.fromEntries(
      ["missingPack", "corruptPack", "workerFailure"].map((name) => [
        name,
        {
          aiReady: false,
          fastReady: true,
          coreReady: true,
          machineUiAvailable: true,
          daemonReady: true,
          saleAvailable: true,
        },
      ]),
    ),
    runtimeTrace: attempts.flatMap((value) =>
      value.stateTrace.map((state) => ({
        attemptId: value.attemptId,
        mode: "ai",
        state,
      })),
    ),
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
    overlapRejection: {
      rejected: true,
      httpStatus: 409,
      error: "ENVIRONMENT_COMMAND_IN_PROGRESS",
    },
    daemon: {
      health: { hardwareOnline: true },
      readiness: { ready: true },
      automaticVent: {
        health: {
          component: "automatic_vent",
          level: "ok",
          code: "AUTOMATIC_VENT_READY",
        },
        outcomes: [
          { edgeId: "presence-1:arrival", outcome: "accepted" },
          { edgeId: "presence-1:arrival", outcome: "deduplicated" },
          { edgeId: "presence-2:departure", outcome: "accepted" },
        ],
      },
    },
    precedence: {
      automaticArrival: {
        edgeId: "presence-1:arrival",
        requestedSpeed: 3,
        outcome: "accepted",
        b3FrameCountDelta: 1,
        protocolFrames: ["B3"],
        frame: {
          sessionId: "serial-replacement",
          parsedOpcode: "B3",
          rawFrameHex: "55b303",
          capturedAt: "2026-07-22T08:00:00.000Z",
        },
      },
      adminB3: {
        commandNo: "MCMD-3",
        resultStatus: "succeeded",
        mqttCommandNo: "MCMD-3",
        mqttResultNo: "MCMD-3",
        frame: {
          sessionId: "serial-replacement",
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
          sessionId: "serial-replacement",
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
      request: { ventSpeed: 3 },
      result: { success: true },
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
      automaticVent: {
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
        ],
        speeds: [3, 0],
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
    aiVirtualTryOn: {
      authority: {
        candidate: {
          sourceCommit: "d".repeat(40),
          subjectSha256: "5".repeat(64),
        },
        contract: {
          bundleDigest: "7".repeat(64),
          manifestSha256: "8".repeat(64),
          protocol: "vem.vision.v2",
        },
        modelPack: {
          archive: { byteSize: 14, sha256: "9".repeat(64) },
          descriptorSha256: "a".repeat(64),
          sourceRevision: "e".repeat(40),
        },
        resources: {
          aiLockSha256: "b".repeat(64),
          runtimeDescriptorSha256: "c".repeat(64),
          sourceDescriptorSha256: "d".repeat(64),
          workerExecutableSha256: "e".repeat(64),
        },
      },
      input: {
        manifestSha256: "f".repeat(64),
        modelPackArchive: { byteSize: 14, sha256: "9".repeat(64) },
        materializedModelPackRoot: {
          byteSize: 15,
          members: [
            { name: "weights/model.bin", byteSize: 15, sha256: "1".repeat(64) },
          ],
          sha256: "0".repeat(64),
        },
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
  it("rejects an AI report without independently owned regional evidence", () => {
    const report = aiVirtualTryOnReport();
    delete report.attempts[0].regionalEvidence;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("aiVirtualTryOn"),
        report,
        "ai-virtual-try-on.json",
      ).status,
      "failed",
    );
  });

  it("accepts the exact regional sidecar reference shape for root-aware adjudication", () => {
    assert.equal(
      validateBusinessCheckReport(
        descriptor("aiVirtualTryOn"),
        aiVirtualTryOnReport(),
        "ai-virtual-try-on.json",
      ).status,
      "passed",
    );
  });

  it("rejects a percent-encoded product hash that Vue Router never observed", () => {
    const report = aiVirtualTryOnReport();
    for (const attempt of report.attempts) {
      const encoded = `#/products/${encodeURIComponent(
        attempt.journey.selectedCatalogKey,
      )}`;
      attempt.journey.productRoute = encoded;
      attempt.journey.returnProductRoute = encoded;
    }
    assert.equal(
      validateBusinessCheckReport(
        descriptor("aiVirtualTryOn"),
        report,
        "ai-virtual-try-on.json",
      ).status,
      "failed",
    );
  });

  it("binds the short return route to the retry attempt that owned the visible result", () => {
    const report = aiVirtualTryOnReport();
    report.attempts[0].journey.resultAttemptId = report.attempts[0].attemptId;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("aiVirtualTryOn"),
        report,
        "ai-virtual-try-on.json",
      ).status,
      "failed",
    );
  });

  it("requires the long attempt to carry its observed catalog-to-product causal path", () => {
    const report = aiVirtualTryOnReport();
    report.attempts[1].journey.productSelector =
      '[data-test="catalog-product"][data-catalog-key="product:short"]';
    assert.equal(
      validateBusinessCheckReport(
        descriptor("aiVirtualTryOn"),
        report,
        "ai-virtual-try-on.json",
      ).status,
      "failed",
    );
  });

  for (const [label, mutate] of [
    [
      "garment identity reuse",
      (report) =>
        (report.attempts[1].garment.garmentId =
          report.attempts[0].garment.garmentId),
    ],
    [
      "garment digest reuse",
      (report) =>
        (report.attempts[1].garment.sha256 = report.attempts[0].garment.sha256),
    ],
    [
      "result digest reuse",
      (report) =>
        (report.attempts[1].result.sha256 = report.attempts[0].result.sha256),
    ],
    [
      "regional digest reuse",
      (report) =>
        (report.attempts[1].regionalEvidence.sha256 =
          report.attempts[0].regionalEvidence.sha256),
    ],
    [
      "regional reference swap",
      (report) => {
        const first = report.attempts[0].regionalEvidence;
        report.attempts[0].regionalEvidence =
          report.attempts[1].regionalEvidence;
        report.attempts[1].regionalEvidence = first;
      },
    ],
  ]) {
    it(`rejects cross-attempt ${label}`, () => {
      const report = aiVirtualTryOnReport();
      mutate(report);
      assert.equal(
        validateBusinessCheckReport(
          descriptor("aiVirtualTryOn"),
          report,
          "ai-virtual-try-on.json",
        ).status,
        "failed",
      );
    });
  }

  it("allows both garment cases to bind the same captured input", () => {
    const report = aiVirtualTryOnReport();
    report.attempts[1].input.sha256 = report.attempts[0].input.sha256;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("aiVirtualTryOn"),
        report,
        "ai-virtual-try-on.json",
      ).status,
      "passed",
    );
  });

  for (const [label, mutate] of [
    [
      "a direct worker path",
      (report) => (report.execution.noDirectWorker = false),
    ],
    ["a non-V2 protocol", (report) => (report.execution.protocol = "legacy")],
    [
      "an incomplete state trace",
      (report) => (report.attempts[0].stateTrace = ["acquiring", "completed"]),
    ],
    [
      "a missing output truth",
      (report) => (report.attempts[0].outputFacts.nonPlaceholder = false),
    ],
    [
      "a sale-impacting missing pack",
      (report) => (report.degradations.missingPack.saleAvailable = false),
    ],
    ["an unknown report field", (report) => (report.selfAsserted = true)],
    [
      "the retired v1 schema",
      (report) =>
        (report.schemaVersion = "vem-ai-virtual-try-on-acceptance/v1"),
    ],
    ["a missing garment case", (report) => report.attempts.pop()],
    [
      "an extra garment case",
      (report) => report.attempts.push(structuredClone(report.attempts[0])),
    ],
    ["a duplicate case", (report) => (report.attempts[1].caseKey = "short")],
    [
      "a duplicate template",
      (report) => (report.attempts[1].template = "tshirt_short_sleeve"),
    ],
    [
      "a duplicate attempt identity",
      (report) => (report.attempts[1].attemptId = report.attempts[0].attemptId),
    ],
    [
      "a cross-attempt runtime trace",
      (report) =>
        (report.runtimeTrace[3].attemptId = report.attempts[0].attemptId),
    ],
    [
      "a sidecar path outside its attempt",
      (report) =>
        (report.attempts[0].regionalEvidence.path = `regional/long/${report.attempts[0].attemptId}.regional-evidence.json`),
    ],
    [
      "an unknown attempt field",
      (report) => (report.attempts[0].selfAsserted = true),
    ],
  ]) {
    it(`rejects ${label} in AI virtual try-on evidence`, () => {
      const report = aiVirtualTryOnReport();
      mutate(report);
      assert.equal(
        validateBusinessCheckReport(
          descriptor("aiVirtualTryOn"),
          report,
          "ai-virtual-try-on.json",
        ).status,
        "failed",
      );
    });
  }
  it("rejects vision experience reports without each recommendation presentation state", () => {
    const complete = validateBusinessCheckReport(
      descriptor("visionExperience"),
      visionExperienceReport(),
      "vision-experience.json",
    );
    assert.equal(complete.status, "passed");

    const unsupportedProtocol = visionExperienceReport();
    unsupportedProtocol.health.vision.protocolSummary.protocol =
      "vem.vision.unsupported";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        unsupportedProtocol,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const incomplete = visionExperienceReport();
    delete incomplete.ui.recommendationPresentation.onlineUnmatched;
    const rejected = validateBusinessCheckReport(
      descriptor("visionExperience"),
      incomplete,
      "vision-experience.json",
    );
    assert.equal(rejected.status, "failed");
    assert.match(rejected.reason, /vision degradation evidence is incomplete/);

    const unfenced = visionExperienceReport();
    delete unfenced.health.vision.protocolSummary.eventFence;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        unfenced,
        "vision-experience.json",
      ).status,
      "failed",
    );

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
      "variant-s";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        reusedRecommendationVariant,
        "vision-experience.json",
      ).status,
      "failed",
    );

    const wrongTryOnIdentity = visionExperienceReport();
    wrongTryOnIdentity.ui.tryOnSelectedProduct.variantId = "variant-s";
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
      "variant-s";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        wrongUnavailableIdentity,
        "vision-experience.json",
      ).status,
      "failed",
    );
    const reusedMedia = visionExperienceReport();
    reusedMedia.ui.mediaPresentation.productCards[2].mainImageUrl =
      reusedMedia.ui.mediaPresentation.productCards[1].mainImageUrl;
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        reusedMedia,
        "/reports/vision.json",
      ).status,
      "failed",
    );
    const wrongOwnedMedia = visionExperienceReport();
    wrongOwnedMedia.ui.mediaPresentation.productCards[0].expectedMainImageUrl =
      "/api/media-assets/main-underwear/content";
    assert.equal(
      validateBusinessCheckReport(
        descriptor("visionExperience"),
        wrongOwnedMedia,
        "/reports/vision.json",
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
    const manualHandling = paymentProviderReport();
    manualHandling.authoritative.attempts[0].closure.status = "manual_handling";
    manualHandling.authoritative.attempts[0].terminal = {
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
      const gate = buildStabilityGateReport({
        commit: "c".repeat(40),
        passAPath: passA,
        passBPath: passB,
      });
      assert.equal(gate.ok, true);
      assert.match(gate.acceptanceReleaseManifestSha256, /^[a-f0-9]{64}$/);
      assert.equal(
        gate.acceptanceReleaseManifest.schemaVersion,
        "vem-runtime-testbed-acceptance-release/v1",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains observed cache evidence without making it a drift gate", () => {
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

  it("requires AI virtual try-on to pass independently in both full passes", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-stability-ai-"));
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
      const passAReport = report("a");
      const passBReport = report("b");
      passBReport.businessSets.aiVirtualTryOn.status = "failed";
      const passA = join(root, "pass-a.json");
      const passB = join(root, "pass-b.json");
      writeFileSync(passA, `${JSON.stringify(passAReport)}\n`);
      writeFileSync(passB, `${JSON.stringify(passBReport)}\n`);
      const gate = buildStabilityGateReport({
        commit: "c".repeat(40),
        passAPath: passA,
        passBPath: passB,
      });
      assert.equal(gate.ok, false);
      assert.ok(
        gate.gateFailures.includes(
          "pass B aiVirtualTryOn status is not passed",
        ),
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
        gate.gateFailures.includes(
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
          new URL("./full-workflow-stability-gate.mjs", import.meta.url)
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
