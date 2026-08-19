import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import ts from "typescript";

import {
  buildFastRouteStressSaleFailureReport,
  buildFastRouteStressScenarioSteps,
  admitFreshSerialSessionForSale,
  combineCleanupError,
  controlPlaneRequest,
  daemonGet,
  dispatchRepeatedPaymentTouch,
  latestVisionPresence,
  parseFastRouteStressSaleArgs,
  runInstalledOwnerOrdinarySaleCompletion,
  runCleanupStep,
  settlePendingCreateOrder,
  shutdownControlledVisionMock,
  stopInstalledVisionOwnerForControlledMock,
  startContinuousCdpLocationHashObservation,
  waitForSaleStartReady,
  waitForOrdinarySaleCleanupPoll,
  waitForGuardedVisionDepartureTrace,
  waitForStableVisionArrivalTrace,
  waitForStableVisionDepartureTransition,
  waitForVisionArrivalOrTouchSession,
  validateFastRouteStressSaleEvidence,
} from "./fast-route-stress-sale.ts";
import { CdpClient } from "./machine-ui-cdp-driver.ts";

class InstalledOwnerFakeWebSocket {
  constructor() {
    this.readyState = 1;
    this.closeCalls = 0;
    this.listeners = new Map();
  }

  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ handler, once: options.once === true });
  }

  removeEventListener(type, handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (entry) => entry.handler !== handler,
      ),
    );
  }

  send() {}

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    for (const entry of this.listeners.get("close") ?? []) entry.handler({});
  }
}

async function connectedInstalledOwnerClient() {
  const socket = new InstalledOwnerFakeWebSocket();
  const client = new CdpClient("ws://127.0.0.1/devtools/page/ordinary-sale", {
    webSocketFactory: () => socket,
    defaultTimeoutMs: 100,
  });
  await client.connect();
  return { client, socket };
}

function ordinarySaleDependencies(evidence, events, options = {}) {
  let gateState = "open";
  let pendingPayment = null;
  const activateVisibleSelector = async (_client, selector) => {
    events.push(`touch:${selector}`);
    if (selector === '[data-test="checkout-submit"]') gateState = "pending";
    if (selector === '[data-test="checkout-submit"]')
      pendingPayment = {
        state: "pending",
        paymentNo: "PAY-1",
        observedAt: evidence.createOrderGate.pendingObservedAt,
      };
    return { input: { method: "Input.dispatchTouchEvent" } };
  };
  return {
    waitForRoute: async (_client, route) => events.push(`route:${route}`),
    waitForSaleStartReady: async () => evidence.saleStartCapability,
    readInstalledUiViewport: async () => evidence.uiViewport,
    readDaemonSaleView: async () => {
      const phase = events.includes("serial:evidence")
        ? "afterF2"
        : events.includes("serial:release-f0")
          ? "afterF1BeforeF2"
          : events.includes("payment:complete")
            ? "beforeF0"
            : "baseline";
      return evidence.daemon[phase];
    },
    readCurrentTransaction: async (_handoff, requestOptions) => {
      events.push("transaction:read");
      if (requestOptions)
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
      return {
        paymentNo: "PAY-1",
        orderNo: "ORD-1",
        nextAction:
          ((options.failed || options.transactionActive) && !options.settled) ||
          gateState === "pending"
            ? "wait_payment"
            : "completed",
      };
    },
    readPlatform: async () =>
      events.includes("serial:release-f0")
        ? evidence.platform.afterF1BeforeF2
        : evidence.platform.baseline,
    activateVisibleSelector,
    armCreateOrderGate: async () => {
      events.push("gate:arm");
      gateState = "armed";
      return {
        controlPlane: "mock-payment-create-gate",
        armedAt: evidence.createOrderGate.armedAt,
      };
    },
    waitForCreateOrderGatePending: async () => {
      events.push("gate:pending");
      if (options.failPendingOnce && !options.failed) {
        options.failed = true;
        throw new Error("injected status timeout after provider pending");
      }
      return {
        paymentNo: "PAY-1",
        observedAt: evidence.createOrderGate.pendingObservedAt,
      };
    },
    releaseCreateOrderGate: async (_guest, _paymentNo, requestOptions) => {
      events.push("gate:release");
      if (requestOptions)
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
      if (options.failReleaseOnce && !options.failed) {
        options.failed = true;
        throw new Error("injected payment gate release failure");
      }
      gateState = "released";
      pendingPayment = null;
      return { releasedAt: evidence.createOrderGate.releasedAt };
    },
    readRenderedPaymentSurface: async () => evidence.renderedSale,
    completeMockPayment: async () => {
      events.push("payment:complete");
      options.transactionActive = true;
    },
    waitForCommand: async () => evidence.liveSale,
    waitForBeforeF0Boundary: async () => evidence.platform.beforeF0,
    readUiBoundary: async () =>
      events.includes("serial:release-f0")
        ? evidence.ui.afterF1BeforeF2
        : evidence.ui.beforeF0,
    waitForSuccessfulResultSurface: async () => evidence.ui.afterF2,
    waitForPlatformMovement: async () => evidence.platform.afterF2,
    waitForDaemonSaleViewAfterF2: async () => evidence.daemon.afterF2,
    readRuntimeTraceSnapshot: async () => ({
      runtimeGenerationId: evidence.machineRuntimeTrace.runtimeGenerationId,
      entries: evidence.machineRuntimeTrace.entries,
    }),
    captureRuntimeTraceBoundary: async () => evidence.noCatalogTraceBoundary,
    startContinuousCdpLocationHashObservation: async () => ({
      assertArmed() {},
      async finish() {
        return evidence.continuousCdpLocationHash;
      },
      stop() {},
    }),
    serialRequest: async (_guest, _session, operation, body = {}) => {
      events.push(
        `serial:${operation}${body.parsedOpcode ? `:${body.parsedOpcode}` : ""}`,
      );
      if (operation === "evidence")
        return {
          mqtt: { messages: evidence.mqttMessages },
          rawFrames: evidence.serial.rawFrames,
        };
      return {
        frame: evidence.serial.rawFrames.find((frame) =>
          operation.includes(frame.parsedOpcode.toLowerCase()),
        ),
      };
    },
    cancelTransaction: async (_handoff, _transaction, requestOptions) => {
      events.push("transaction:cancel");
      assert.equal(requestOptions?.signal instanceof AbortSignal, true);
      options.settled = true;
      gateState = "settled";
    },
    openCreateOrderGate: async (_guest, requestOptions) => {
      events.push("gate:open");
      if (requestOptions)
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
      if (pendingPayment || (options.failed && !options.settled))
        throw new Error("provider refuses open while payment remains active");
      gateState = "open";
      return { state: "open" };
    },
    readCreateOrderGate: async (_guest, requestOptions) => {
      events.push("gate:status");
      if (requestOptions)
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
      return { state: gateState, pending: pendingPayment };
    },
  };
}

async function listenOnAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a TCP port");
  }
  return { server, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("controlled vision mock shutdown", () => {
  it("forces an unresponsive child to exit and fails when it remains alive", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };

    await assert.rejects(
      () => shutdownControlledVisionMock(child, 10, 0),
      /did not exit/,
    );
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });

  it("fails when the Vision port cannot be rebound after the child exits", async () => {
    const { server, port } = await listenOnAvailablePort();
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    };

    try {
      await assert.rejects(
        () => shutdownControlledVisionMock(child, 100, port),
        new RegExp(`did not release port ${port}`),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("does not wait or signal again after the child already exited by SIGTERM", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = "SIGTERM";
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };

    await shutdownControlledVisionMock(child, 10, 0);

    assert.deepEqual(signals, []);
  });
});

describe("pending create-order cleanup", () => {
  it("cancels the correlated active transaction and waits for terminal state", async () => {
    const reads = [
      null,
      {
        paymentNo: "PAY-1",
        orderNo: "ORD-1",
        orderStatus: "pending_payment",
        nextAction: "wait_payment",
      },
      {
        paymentNo: "PAY-1",
        orderNo: "ORD-1",
        orderStatus: "canceled",
        nextAction: "closed",
      },
    ];
    const canceled = [];
    let clock = 0;
    const result = await settlePendingCreateOrder({
      paymentNo: "PAY-1",
      readTransaction: async () => (reads.length > 0 ? reads.shift() : null),
      cancelTransaction: async (transaction) =>
        canceled.push(transaction.orderNo),
      wait: async () => undefined,
      now: () => clock++,
    });

    assert.equal(result.orderStatus, "canceled");
    assert.deepEqual(canceled, ["ORD-1"]);
  });
});

function validEvidence() {
  const runtimeGenerationId = "runtime-generation-1";
  const inventory = {
    id: "inventory-1",
    slotId: "slot-1",
    onHandQty: 3,
    reservedQty: 0,
  };
  const baselineRaw = {
    orders: [],
    orderItems: [],
    payments: [],
    commands: [],
    movements: [],
    inventories: [inventory],
  };
  const beforeF0Raw = {
    orders: [
      {
        id: "order-1",
        orderNo: "ORD-1",
        status: "dispensing",
        paymentState: "paid",
        fulfillmentState: "dispensing",
      },
    ],
    orderItems: [
      {
        id: "item-1",
        orderId: "order-1",
        inventoryId: "inventory-1",
        slotId: "slot-1",
        quantity: 1,
      },
    ],
    payments: [
      {
        id: "payment-1",
        orderId: "order-1",
        paymentNo: "PAY-1",
        status: "succeeded",
      },
    ],
    commands: [
      {
        id: "command-1",
        commandNo: "CMD-1",
        orderId: "order-1",
        orderItemId: "item-1",
        slotId: "slot-1",
        commandKind: "dispatch",
        status: "sent",
      },
    ],
    movements: [],
    inventories: [inventory],
  };
  const inFlightRaw = structuredClone(beforeF0Raw);
  const platformReport = (raw, capturedAt) => ({
    source: "authoritative_ephemeral_platform_database",
    capturedAt,
    scope: { machineCode: "VEM-TESTBED-LOCAL", machineId: "machine-1" },
    raw,
  });
  const rawFrame = (sequence, parsedOpcode, capturedAt) => ({
    sequence,
    direction:
      parsedOpcode === "VEND" ? "daemon-to-controller" : "controller-to-daemon",
    rawFrameHex: parsedOpcode === "VEND" ? "55020531" : `55${parsedOpcode}`,
    opcode: parsedOpcode === "VEND" ? 2 : Number.parseInt(parsedOpcode, 16),
    parsedOpcode,
    capturedAt,
    sessionId: "serial-session-1",
    boundaryId: `host-pty:serial-session-1:${sequence}`,
    provenance: "host_pty_raw_serial_journal",
  });
  return {
    saleCorrelationId: "sale-1",
    controlPlaneSessionId: "fast-sale-session-1",
    machineCode: "VEM-TESTBED-LOCAL",
    renderedSale: {
      orderId: "order-1",
      paymentId: "payment-1",
      orderNo: "ORD-1",
    },
    liveSale: {
      orderId: "order-1",
      paymentId: "payment-1",
      orderNo: "ORD-1",
      vendingCommandId: "command-1",
    },
    createOrderGate: {
      controlPlane: "mock-payment-create-gate",
      armedAt: "2026-07-18T03:59:59.800Z",
      paymentNo: "PAY-1",
      pendingObservedAt: "2026-07-18T03:59:59.900Z",
      releasedAt: "2026-07-18T04:00:00.200Z",
    },
    saleStartCapability: {
      revision: 7,
      canStartSale: true,
      paymentOptions: {
        options: [
          {
            optionKey: "mock:mock",
            providerCode: "mock",
            method: "mock",
            ready: true,
            disabledReason: null,
          },
        ],
      },
    },
    uiViewport: {
      innerWidth: 1080,
      innerHeight: 1920,
      documentClientWidth: 1080,
      documentClientHeight: 1920,
      visualViewportWidth: 1080,
      visualViewportHeight: 1920,
    },
    platform: {
      baseline: platformReport(baselineRaw, "2026-07-18T03:59:59.500Z"),
      beforeF0: platformReport(beforeF0Raw, "2026-07-18T04:00:00.900Z"),
      afterF1BeforeF2: platformReport(inFlightRaw, "2026-07-18T04:00:02.500Z"),
      afterF2: platformReport(
        {
          ...inFlightRaw,
          orders: [
            {
              ...inFlightRaw.orders[0],
              status: "fulfilled",
              fulfillmentState: "dispensed",
            },
          ],
          commands: [{ ...inFlightRaw.commands[0], status: "succeeded" }],
          movements: [
            {
              id: "movement-1",
              orderItemId: "item-1",
              orderNo: "ORD-1",
              commandNo: "CMD-1",
              inventoryId: "inventory-1",
              slotId: "slot-1",
              quantity: 1,
            },
          ],
          inventories: [{ ...inventory, onHandQty: 2 }],
        },
        "2026-07-18T04:00:04.500Z",
      ),
    },
    daemon: {
      baseline: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 3,
            saleableStock: 3,
          },
        ],
      },
      beforeF0: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 3,
            saleableStock: 2,
          },
        ],
      },
      afterF1BeforeF2: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 3,
            saleableStock: 2,
          },
        ],
      },
      afterF2: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 2,
            saleableStock: 2,
          },
        ],
      },
    },
    ui: {
      beforeF0: { route: "#/payment", result: null },
      afterF1BeforeF2: { route: "#/dispensing", result: null },
      afterF2: {
        route: "#/result/success",
        result: {
          kind: "success",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "ORD-1",
          commandId: "command-1",
        },
      },
    },
    visionDelivery: {
      ok: true,
      eventId: "departure-event-1",
      timestamp: "2026-07-18T04:00:00.000Z",
      requestedAt: "2026-07-18T04:00:00.000Z",
      completedAt: "2026-07-18T04:00:00.050Z",
      traceBoundary: {
        source: "installed_machine_runtime_trace_cdp",
        lastEntryId: 1,
        capturedAt: "2026-07-18T04:00:00.000Z",
        runtimeGenerationId,
      },
      connectedRuntimeClients: 1,
      acceptedDeliveries: 1,
    },
    noCatalogTraceBoundary: {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 0,
      capturedAt: "2026-07-18T03:59:59.700Z",
      runtimeGenerationId,
    },
    repeatedPaymentTouch: {
      traceEntryId: 3,
      pendingConfirmedAt: "2026-07-18T03:59:59.900Z",
      releaseRequestedAt: "2026-07-18T04:00:00.200Z",
      preDispatchTraceBoundary: {
        source: "installed_machine_runtime_trace_cdp",
        lastEntryId: 2,
        capturedAt: "2026-07-18T04:00:00.110Z",
        runtimeGenerationId,
      },
    },
    continuousCdpLocationHash: {
      source: "cdp_page_navigation_events_and_location_hash",
      startedAt: "2026-07-18T03:59:59.700Z",
      initialHash: "#/catalog",
      armedAt: "2026-07-18T03:59:59.710Z",
      terminalAt: "2026-07-18T04:00:04.010Z",
      terminalHash: "#/result/success",
      entries: [
        {
          sequence: 1,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/products/product-1",
          observedAt: "2026-07-18T03:59:59.710Z",
        },
        {
          sequence: 2,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/checkout",
          observedAt: "2026-07-18T03:59:59.800Z",
        },
        {
          sequence: 3,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/payment",
          observedAt: "2026-07-18T04:00:00.150Z",
        },
        {
          sequence: 4,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/result/success",
          observedAt: "2026-07-18T04:00:04.000Z",
        },
      ],
    },
    machineRuntimeTrace: {
      source: "installed_machine_runtime_trace_cdp",
      capturedAt: "2026-07-18T04:00:04.100Z",
      runtimeGenerationId,
      entries: [
        {
          type: "navigation",
          id: 1,
          intentType: "customer.touch",
          decision: "accepted",
          reasonCode: "touchscreen_session_renewed",
          fromRoute: "#/checkout",
          decidedRoute: null,
          finalRoute: null,
          targetRoute: null,
          at: "2026-07-18T03:59:59.850Z",
        },
        {
          type: "navigation",
          id: 2,
          intentType: "presence.departed",
          sourceEventId: "presence-2:departure",
          decision: "rejected",
          reasonCode: "touchscreen_session_active",
          fromRoute: "#/checkout",
          finalRoute: "#/checkout",
          at: "2026-07-18T04:00:00.100Z",
        },
        {
          type: "navigation",
          id: 3,
          intentType: "customer.touch",
          decision: "accepted",
          reasonCode: "touchscreen_session_renewed",
          fromRoute: "#/checkout",
          decidedRoute: null,
          finalRoute: null,
          targetRoute: null,
          at: "2026-07-18T04:00:00.125Z",
        },
        {
          type: "navigation",
          id: 4,
          intentType: "transaction.projection",
          decision: "accepted",
          reasonCode: "transaction_projection",
          fromRoute: "#/checkout",
          finalRoute: "#/payment",
          at: "2026-07-18T04:00:00.150Z",
          transactionOrderNo: "ORD-1",
        },
        {
          type: "transaction_surface",
          id: 5,
          at: "2026-07-18T04:00:04.000Z",
          recordedAt: "2026-07-18T04:00:04.000Z",
          route: "#/result/success",
          stage: "result",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "ORD-1",
          commandId: "command-1",
          resultKind: "success",
          resultDisplayIntent: "success",
        },
      ],
    },
    mqttMessages: [
      {
        topic: "vem/machines/VEM-TESTBED-LOCAL/commands/dispense",
        payload: {
          messageId: "command:CMD-1",
          machineCode: "VEM-TESTBED-LOCAL",
          payload: {
            commandNo: "CMD-1",
            orderNo: "ORD-1",
            slot: { rowNo: 2, cellNo: 5 },
            quantity: 1,
          },
        },
      },
    ],
    serial: {
      sessionId: "serial-session-1",
      rawFrames: [
        rawFrame(1, "VEND", "2026-07-18T04:00:00.950Z"),
        rawFrame(2, "F0", "2026-07-18T04:00:01.000Z"),
        rawFrame(3, "F1", "2026-07-18T04:00:02.000Z"),
        rawFrame(4, "F2", "2026-07-18T04:00:03.000Z"),
      ],
    },
  };
}

describe("fast route stress sale tracer", () => {
  it("awaits a new stable Vision arrival after the control-request boundary", async () => {
    let reads = 0;
    const boundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 4,
      capturedAt: "2026-07-18T03:59:59.000Z",
      runtimeGenerationId: "runtime-generation-1",
    };
    const result = await waitForStableVisionArrivalTrace(null, boundary, {
      timeoutMs: 100,
      sleepFn: async () => {},
      readTrace: async () => ({
        runtimeGenerationId: "runtime-generation-1",
        entries:
          reads++ === 0
            ? []
            : [
                {
                  id: 5,
                  type: "journey_transition",
                  transitionId: "vision:presence-8:welcome",
                },
              ],
      }),
    });
    assert.equal(result.transitionId, "vision:presence-8:welcome");
    assert.equal(reads, 2);
  });

  it("accepts an already active touch session when Vision arrival is deduped", async () => {
    const boundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 4,
      capturedAt: "2026-07-18T03:59:59.000Z",
      runtimeGenerationId: "runtime-generation-1",
    };
    const result = await waitForStableVisionArrivalTrace(null, boundary, {
      timeoutMs: 100,
      sleepFn: async () => {},
      readTrace: async () => ({
        runtimeGenerationId: "runtime-generation-1",
        entries: [
          {
            id: 5,
            type: "navigation",
            intentType: "customer.touch",
            decision: "accepted",
            reasonCode: "touchscreen_session_renewed",
          },
        ],
      }),
    });
    assert.equal(result.intentType, "customer.touch");
  });

  it("falls back to physical touch when Vision arrival is deduped", async () => {
    const boundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 4,
      capturedAt: "2026-07-18T03:59:59.000Z",
      runtimeGenerationId: "runtime-generation-1",
    };
    let touched = false;
    const result = await waitForVisionArrivalOrTouchSession(null, boundary, {
      arrivalTimeoutMs: 100,
      touchTimeoutMs: 100,
      dispatchTouch: async () => {
        touched = true;
        return { input: { method: "Input.dispatchTouchEvent" } };
      },
      waitArrival: async (_client, _boundary, options) => {
        if (!touched) throw new Error(`deduped after ${options.timeoutMs}`);
        return {
          id: 5,
          type: "navigation",
          intentType: "customer.touch",
          decision: "accepted",
          reasonCode: "touchscreen_session_renewed",
        };
      },
    });
    assert.equal(result.trace.intentType, "customer.touch");
    assert.equal(result.fallback.kind, "touchscreen_session");
    assert.match(result.fallback.arrivalError, /deduped/);
  });

  it("accepts an active touch session after physical touch when no new trace is emitted", async () => {
    const boundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 10,
      capturedAt: "2026-07-18T03:59:59.000Z",
      runtimeGenerationId: "runtime-generation-1",
    };
    let touched = false;
    const result = await waitForVisionArrivalOrTouchSession(null, boundary, {
      arrivalTimeoutMs: 100,
      touchTimeoutMs: 100,
      dispatchTouch: async () => {
        touched = true;
        return { input: { method: "Input.dispatchTouchEvent" } };
      },
      waitArrival: async () => {
        throw new Error(touched ? "no post-boundary trace" : "deduped");
      },
      readTrace: async () => ({
        runtimeGenerationId: "runtime-generation-1",
        entries: [
          {
            id: 9,
            type: "navigation",
            intentType: "customer.touch",
            decision: "accepted",
            reasonCode: "touchscreen_session_renewed",
            touchscreenSessionActive: true,
          },
        ],
      }),
    });
    assert.equal(result.trace.intentType, "customer.touch");
    assert.equal(
      result.trace.reasonCode,
      "touchscreen_session_active_after_dispatch",
    );
    assert.equal(
      result.fallback.kind,
      "touchscreen_session_active_after_dispatch",
    );
    assert.match(result.fallback.touchArrivalError, /no post-boundary trace/);
  });

  it("accepts an existing active touch session when no new trace is emitted", async () => {
    const boundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 10,
      capturedAt: "2026-07-18T03:59:59.000Z",
      runtimeGenerationId: "runtime-generation-1",
      touchscreenSessionActive: true,
    };
    const result = await waitForVisionArrivalOrTouchSession(null, boundary, {
      arrivalTimeoutMs: 100,
      dispatchTouch: async () => {
        throw new Error("touch should not be dispatched");
      },
      waitArrival: async () => {
        throw new Error("deduped active session");
      },
    });
    assert.equal(result.trace.intentType, "customer.touch");
    assert.equal(result.trace.reasonCode, "touchscreen_session_already_active");
    assert.equal(result.fallback.kind, "existing_touchscreen_session");
    assert.match(result.fallback.arrivalError, /deduped active session/);
  });

  it("awaits a stable Vision departure before establishing another arrival", async () => {
    let reads = 0;
    const boundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 4,
      capturedAt: "2026-07-18T03:59:59.000Z",
      runtimeGenerationId: "runtime-generation-1",
    };
    const result = await waitForStableVisionDepartureTransition(
      null,
      boundary,
      {
        timeoutMs: 100,
        sleepFn: async () => {},
        readTrace: async () => ({
          runtimeGenerationId: "runtime-generation-1",
          entries:
            reads++ === 0
              ? []
              : [
                  {
                    id: 5,
                    type: "journey_transition",
                    transitionId: "vision:presence-9:departed",
                  },
                ],
        }),
      },
    );
    assert.equal(result.transitionId, "vision:presence-9:departed");
    assert.equal(reads, 2);
  });

  it("does not dispatch synthetic Vision departure before the reset arrival is observed", () => {
    const source = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /resetArrivalDelivery = await dispatchVisionArrival/);
    assert.match(
      source,
      /resetArrivalTrace = await waitForStableVisionArrivalTrace/,
    );
    assert.match(source, /resetTransitionId: resetTrace\.transitionId/);
  });

  it("treats an existing touchscreen customer session as a valid sale presence precondition", () => {
    const source = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /resetBoundary\.touchscreenSessionActive\s*===\s*true/,
    );
    assert.match(source, /existing-touchscreen-session-retained/);
    assert.match(
      source,
      /touchNavigationTraceId:\s*resetBoundary\.lastEntryId/,
    );
  });

  it("derives existing stable Vision presence from the latest journey transition", () => {
    assert.deepEqual(
      latestVisionPresence([
        {
          type: "journey_transition",
          transitionId: "vision:presence-1:welcome",
        },
        { type: "audio_started", transitionId: "vision:presence-1:welcome" },
      ]),
      { active: true, transitionId: "vision:presence-1:welcome" },
    );
    assert.deepEqual(
      latestVisionPresence([
        {
          type: "journey_transition",
          transitionId: "vision:presence-1:welcome",
        },
        {
          type: "journey_transition",
          transitionId: "vision:presence-2:departed",
        },
      ]),
      { active: false, transitionId: "vision:presence-2:departed" },
    );
  });

  it("awaits a new stable Vision departure after the control-request trace boundary", async () => {
    let reads = 0;
    const traceBoundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 256,
      capturedAt: "2026-07-18T04:00:00.000Z",
      runtimeGenerationId: "runtime-generation-1",
    };
    const result = await waitForGuardedVisionDepartureTrace(
      null,
      traceBoundary,
      {
        timeoutMs: 100,
        sleepFn: async () => {},
        readTrace: async () => {
          reads += 1;
          const fullTraceWindow = Array.from({ length: 256 }, (_, index) => ({
            id: index + 1,
            type: "navigation",
            intentType: "presence.departed",
            sourceEventId: `presence-${index + 1}:departure`,
            decision: "rejected",
            reasonCode: "active_transaction_route",
            finalRoute: "#/checkout",
          }));
          return {
            runtimeGenerationId: "runtime-generation-1",
            entries:
              reads < 2
                ? fullTraceWindow
                : [
                    ...fullTraceWindow.slice(1),
                    {
                      id: 257,
                      type: "navigation",
                      intentType: "presence.departed",
                      sourceEventId: "presence-8:departure",
                      decision: "rejected",
                      reasonCode: "active_transaction_route",
                      finalRoute: "#/payment",
                    },
                  ],
          };
        },
      },
    );
    assert.equal(result.sourceEventId, "presence-8:departure");
    assert.equal(reads, 2);
  });

  it("accepts a restarted trace id only after the boundary and rejects its old departure", async () => {
    let reads = 0;
    const traceBoundary = {
      source: "installed_machine_runtime_trace_cdp",
      lastEntryId: 256,
      capturedAt: "2026-07-18T04:00:00.000Z",
      runtimeGenerationId: "runtime-generation-old",
    };
    const result = await waitForGuardedVisionDepartureTrace(
      null,
      traceBoundary,
      {
        timeoutMs: 100,
        sleepFn: async () => {},
        readTrace: async () => {
          reads += 1;
          return {
            runtimeGenerationId: "runtime-generation-new",
            entries: [
              {
                id: 1,
                at:
                  reads === 1
                    ? "2026-07-18T04:00:00.000Z"
                    : "2026-07-18T04:00:00.001Z",
                type: "navigation",
                intentType: "presence.departed",
                sourceEventId: "presence-9:departure",
                decision: "rejected",
                reasonCode: "active_transaction_route",
                finalRoute: "#/payment",
              },
            ],
          };
        },
      },
    );

    assert.equal(result.id, 1);
    assert.equal(reads, 2);
  });

  it("parses a guest-local tracer contract with handoff and guest input evidence", () => {
    const options = parseFastRouteStressSaleArgs([
      "--mode",
      "fast",
      "--guest-input",
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      "--handoff",
      "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
      "--out",
      "C:\\ProgramData\\VEM\\testbed\\fast-route-stress-sale.json",
    ]);

    assert.equal(options.mode, "fast");
    assert.equal(options.scenario, "route-stress");
    assert.equal(
      options.guestInputPath,
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
    );
    assert.equal(
      options.handoffPath,
      "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
    );
  });

  it("accepts sale-only evidence without the route-stress Vision departure", () => {
    const evidence = validEvidence();
    evidence.scenario = "sale-only";
    evidence.visionDelivery = {
      scenario: "sale-only",
      skippedReason: "route_stress_not_requested",
      arrival: null,
      traceBoundary: null,
      requestedAt: null,
      completedAt: null,
    };
    evidence.repeatedPaymentTouch = {
      scenario: "sale-only",
      traceEntryId: null,
      preDispatchTraceBoundary: null,
      pendingConfirmedAt: "2026-07-18T03:59:59.900Z",
      releaseRequestedAt: "2026-07-18T04:00:00.200Z",
    };
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) =>
          entry.intentType !== "presence.departed" &&
          entry.id !== 3 &&
          entry.intentType !== "transaction.projection",
      );

    assert.doesNotThrow(() => validateFastRouteStressSaleEvidence(evidence));
  });

  it("accepts an ordinary installed-owner sale without controlling Vision while retaining payment daemon and raw serial boundaries", async () => {
    const evidence = validEvidence();
    evidence.scenario = "sale-only";
    evidence.visionDelivery = {
      scenario: "sale-only",
      skippedReason: "installed_vision_owner_retained",
      arrival: null,
      traceBoundary: null,
      requestedAt: null,
      completedAt: null,
    };
    evidence.repeatedPaymentTouch = {
      scenario: "sale-only",
      traceEntryId: null,
      preDispatchTraceBoundary: null,
      pendingConfirmedAt: evidence.createOrderGate.pendingObservedAt,
      releaseRequestedAt: evidence.createOrderGate.releasedAt,
    };
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) =>
          entry.intentType !== "presence.departed" &&
          entry.intentType !== "transaction.projection" &&
          entry.id !== 3,
      );
    const events = [];
    const { client, socket } = await connectedInstalledOwnerClient();
    const serialSession = {
      sessionId: "serial-session-1",
      binding: { serialSessionId: "serial-session-1" },
      stopCalls: 0,
      abortCalls: 0,
    };
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const result = await runInstalledOwnerOrdinarySaleCompletion({
        client,
        guestInput: {
          runId: "ordinary-sale-run",
          machineCode: "VEM-TESTBED-LOCAL",
        },
        handoff: {},
        serialSession,
        testDependencies: ordinarySaleDependencies(evidence, events),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.summary.protocol, ["VEND", "F0", "F1", "F2"]);
      assert.equal(result.summary.platformStockDeltaAfterF2, -1);
      assert.equal(result.summary.daemonStockDeltaAfterF2, -1);
      assert.equal(result.summary.orderId, "order-1");
      assert.equal(result.summary.paymentId, "payment-1");
      assert.equal(result.summary.vendingCommandId, "command-1");
      assert.equal(socket.closeCalls, 0);
      assert.equal(client.closed, false);
      assert.equal(serialSession.stopCalls, 0);
      assert.equal(serialSession.abortCalls, 0);
      assert.deepEqual(
        events.filter((event) => event.startsWith("serial:")),
        [
          "serial:wait-frame:VEND",
          "serial:release-f0",
          "serial:wait-frame:F0",
          "serial:wait-frame:F1",
          "serial:release-f2",
          "serial:wait-frame:F2",
          "serial:evidence",
        ],
      );
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await client.close();
    }
  });

  it("restores the payment gate after failure so the retained owners can retry", async () => {
    const evidence = validEvidence();
    evidence.scenario = "sale-only";
    evidence.visionDelivery = {
      scenario: "sale-only",
      skippedReason: "installed_vision_owner_retained",
      arrival: null,
      traceBoundary: null,
      requestedAt: null,
      completedAt: null,
    };
    evidence.repeatedPaymentTouch = {
      scenario: "sale-only",
      traceEntryId: null,
      preDispatchTraceBoundary: null,
      pendingConfirmedAt: evidence.createOrderGate.pendingObservedAt,
      releaseRequestedAt: evidence.createOrderGate.releasedAt,
    };
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) =>
          entry.intentType !== "presence.departed" &&
          entry.intentType !== "transaction.projection" &&
          entry.id !== 3,
      );
    const { client, socket } = await connectedInstalledOwnerClient();
    const serialSession = {
      sessionId: "serial-session-1",
      binding: { serialSessionId: "serial-session-1" },
    };
    const failureEvents = [];
    const failureOptions = { failReleaseOnce: true, failed: false };
    const common = {
      client,
      guestInput: {
        runId: "ordinary-sale-retry",
        machineCode: "VEM-TESTBED-LOCAL",
      },
      handoff: {},
      serialSession,
    };
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await assert.rejects(
        runInstalledOwnerOrdinarySaleCompletion({
          ...common,
          testDependencies: ordinarySaleDependencies(
            evidence,
            failureEvents,
            failureOptions,
          ),
        }),
        /injected payment gate release failure/,
      );
      assert.deepEqual(failureEvents.slice(-6), [
        "gate:release",
        "transaction:read",
        "transaction:cancel",
        "transaction:read",
        "gate:open",
        "gate:status",
      ]);
      assert.equal(socket.closeCalls, 0);
      assert.equal(client.closed, false);

      const retryEvents = [];
      const retry = await runInstalledOwnerOrdinarySaleCompletion({
        ...common,
        testDependencies: ordinarySaleDependencies(evidence, retryEvents),
      });
      assert.equal(retry.ok, true);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await client.close();
    }
  });

  it("discovers provider pending state during cleanup when the main pending wait times out", async () => {
    const evidence = validEvidence();
    evidence.scenario = "sale-only";
    evidence.visionDelivery = {
      scenario: "sale-only",
      skippedReason: "installed_vision_owner_retained",
      arrival: null,
      traceBoundary: null,
      requestedAt: null,
      completedAt: null,
    };
    evidence.repeatedPaymentTouch = {
      scenario: "sale-only",
      traceEntryId: null,
      preDispatchTraceBoundary: null,
      pendingConfirmedAt: evidence.createOrderGate.pendingObservedAt,
      releaseRequestedAt: evidence.createOrderGate.releasedAt,
    };
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) =>
          entry.intentType !== "presence.departed" &&
          entry.intentType !== "transaction.projection" &&
          entry.id !== 3,
      );
    const { client } = await connectedInstalledOwnerClient();
    const common = {
      client,
      guestInput: {
        runId: "ordinary-sale-status-timeout",
        machineCode: "VEM-TESTBED-LOCAL",
      },
      handoff: {},
      serialSession: {
        sessionId: "serial-session-1",
        binding: { serialSessionId: "serial-session-1" },
      },
    };
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const failureEvents = [];
      await assert.rejects(
        runInstalledOwnerOrdinarySaleCompletion({
          ...common,
          testDependencies: ordinarySaleDependencies(evidence, failureEvents, {
            failPendingOnce: true,
          }),
        }),
        /injected status timeout after provider pending/,
      );
      assert.deepEqual(failureEvents.slice(-7), [
        "gate:status",
        "gate:release",
        "transaction:read",
        "transaction:cancel",
        "transaction:read",
        "gate:open",
        "gate:status",
      ]);

      const retry = await runInstalledOwnerOrdinarySaleCompletion({
        ...common,
        testDependencies: ordinarySaleDependencies(evidence, []),
      });
      assert.equal(retry.ok, true);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await client.close();
    }
  });

  it("settles the known payment after release removed provider pending and a later sale boundary fails", async () => {
    const evidence = validEvidence();
    const { client } = await connectedInstalledOwnerClient();
    const events = [];
    const base = ordinarySaleDependencies(evidence, events, {});
    const dependencies = {
      ...base,
      waitForBeforeF0Boundary: async () => {
        throw new Error("injected post-release VEND boundary failure");
      },
    };
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const common = {
      client,
      guestInput: {
        runId: "ordinary-sale-post-release-failure",
        machineCode: "VEM-TESTBED-LOCAL",
      },
      handoff: {},
      serialSession: {
        sessionId: "serial-session-1",
        binding: { serialSessionId: "serial-session-1" },
      },
    };
    try {
      await assert.rejects(
        runInstalledOwnerOrdinarySaleCompletion({
          ...common,
          testDependencies: dependencies,
        }),
        /injected post-release VEND boundary failure/,
      );
      assert.deepEqual(events.slice(-6), [
        "gate:status",
        "transaction:read",
        "transaction:cancel",
        "transaction:read",
        "gate:open",
        "gate:status",
      ]);
      const retry = await runInstalledOwnerOrdinarySaleCompletion({
        ...common,
        testDependencies: ordinarySaleDependencies(evidence, []),
      });
      assert.equal(retry.ok, true);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await client.close();
    }
  });

  it("waits through null and another payment until the released known payment projects", async () => {
    const evidence = validEvidence();
    const { client } = await connectedInstalledOwnerClient();
    const events = [];
    const options = {};
    const base = ordinarySaleDependencies(evidence, events, options);
    const projected = [
      null,
      {
        paymentNo: "PAY-OLD",
        orderNo: "ORD-OLD",
        nextAction: "wait_payment",
      },
      {
        paymentNo: "PAY-1",
        orderNo: "ORD-1",
        nextAction: "wait_payment",
      },
      {
        paymentNo: "PAY-1",
        orderNo: "ORD-1",
        nextAction: "completed",
      },
    ];
    let reads = 0;
    let wrongPaymentCancel = false;
    const dependencies = {
      ...base,
      waitForBeforeF0Boundary: async () => {
        throw new Error("injected post-release projection failure");
      },
      readCurrentTransaction: async (_handoff, requestOptions) => {
        if (!requestOptions) return { paymentNo: "PAY-1" };
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
        const value = projected[Math.min(reads, projected.length - 1)];
        reads += 1;
        return value;
      },
      cancelTransaction: async (_handoff, transaction, requestOptions) => {
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
        assert.equal(reads, 3);
        if (transaction.paymentNo !== "PAY-1") wrongPaymentCancel = true;
        events.push("transaction:cancel");
      },
    };
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const common = {
      client,
      guestInput: {
        runId: "ordinary-sale-projection-window",
        machineCode: "VEM-TESTBED-LOCAL",
      },
      handoff: {},
      serialSession: {
        sessionId: "serial-session-1",
        binding: { serialSessionId: "serial-session-1" },
      },
    };
    try {
      await assert.rejects(
        runInstalledOwnerOrdinarySaleCompletion({
          ...common,
          testDependencies: dependencies,
        }),
        /injected post-release projection failure/,
      );
      assert.equal(reads, 4);
      assert.equal(wrongPaymentCancel, false);
      const retry = await runInstalledOwnerOrdinarySaleCompletion({
        ...common,
        testDependencies: ordinarySaleDependencies(evidence, []),
      });
      assert.equal(retry.ok, true);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await client.close();
    }
  });

  it("aborts before a known payment projects and never cancels the other active payment", async () => {
    const evidence = validEvidence();
    const { client } = await connectedInstalledOwnerClient();
    const options = {};
    const base = ordinarySaleDependencies(evidence, [], options);
    let reads = 0;
    let cancels = 0;
    const dependencies = {
      ...base,
      waitForBeforeF0Boundary: async () => {
        throw new Error("injected projection timeout boundary");
      },
      readCurrentTransaction: async (_handoff, requestOptions) => {
        if (!requestOptions) return { paymentNo: "PAY-1" };
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
        reads += 1;
        return {
          paymentNo: "PAY-OTHER",
          orderNo: "ORD-OTHER",
          nextAction: "wait_payment",
        };
      },
      cancelTransaction: async () => {
        cancels += 1;
      },
    };
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await assert.rejects(
        runInstalledOwnerOrdinarySaleCompletion({
          client,
          guestInput: {
            runId: "ordinary-sale-projection-timeout",
            machineCode: "VEM-TESTBED-LOCAL",
          },
          handoff: {},
          serialSession: {
            sessionId: "serial-session-1",
            binding: { serialSessionId: "serial-session-1" },
          },
          testCleanupTimeoutMs: 20,
          testDependencies: dependencies,
        }),
        /projection timeout boundary.*cleanup|cleanup.*deadline/is,
      );
      assert.equal(reads, 1);
      assert.equal(cancels, 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(reads, 1);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await client.close();
    }
  });

  it("aborts a delayed control-plane request instead of allowing a late mutation", async () => {
    const { server, port } = await listenOnAvailablePort();
    let requestAborted = false;
    let lateMutation = false;
    server.removeAllListeners("connection");
    server.on("connection", (socket) => {
      socket.once("data", () => {
        socket.once("close", () => {
          requestAborted = true;
        });
        setTimeout(() => {
          if (!socket.destroyed) socket.end();
          else lateMutation = false;
        }, 100).unref();
      });
    });
    try {
      const signal = AbortSignal.timeout(20);
      await assert.rejects(
        controlPlaneRequest(
          {
            hostControlPlane: {
              endpoint: `http://127.0.0.1:${port}`,
              token: "test-token",
            },
          },
          "/v1/mock-payment-create-gate/release",
          { paymentNo: "PAY-1" },
          { timeoutMs: 20, signal },
        ),
        /abort|timeout/i,
      );
      assert.equal(signal.aborted, true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(requestAborted, true);
      assert.equal(lateMutation, false);
    } finally {
      await closeServer(server);
    }
  });

  it("passes the cleanup abort signal through a delayed production daemon GET", async () => {
    let requestClosed = false;
    let lateMutation = false;
    const server = createHttpServer((request, response) => {
      request.once("close", () => {
        requestClosed = true;
      });
      const timer = setTimeout(() => {
        lateMutation = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"paymentNo":"PAY-1"}');
      }, 100);
      request.once("close", () => clearTimeout(timer));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const signal = AbortSignal.timeout(20);
      await assert.rejects(
        daemonGet(
          {
            daemon: {
              ready: {
                healthzUrl: `http://127.0.0.1:${server.address().port}/healthz`,
                ipcToken: "test-ipc-token",
              },
            },
          },
          "/v1/transactions/current",
          { timeoutMs: 20, signal },
        ),
        /abort|timeout/i,
      );
      assert.equal(signal.aborted, true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(requestClosed, true);
      assert.equal(lateMutation, false);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not issue another terminal read when the monotonic deadline expires during backoff", async () => {
    const deadline = performance.now() + 20;
    const started = performance.now();
    await assert.rejects(
      waitForOrdinarySaleCleanupPoll(deadline, 100),
      /cleanup deadline exceeded/,
    );
    assert.equal(performance.now() - started < 80, true);
  });

  it("does not issue another transaction read after the cleanup deadline expires in polling backoff", async () => {
    const evidence = validEvidence();
    const { client } = await connectedInstalledOwnerClient();
    const base = ordinarySaleDependencies(evidence, [], {
      failPendingOnce: true,
    });
    let transactionReads = 0;
    const dependencies = {
      ...base,
      readCurrentTransaction: async (_handoff, requestOptions) => {
        assert.equal(requestOptions.signal instanceof AbortSignal, true);
        transactionReads += 1;
        return {
          paymentNo: "PAY-1",
          orderNo: "ORD-1",
          nextAction: "wait_payment",
        };
      },
    };
    const oldNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await assert.rejects(
        runInstalledOwnerOrdinarySaleCompletion({
          client,
          guestInput: {
            runId: "ordinary-sale-poll-deadline",
            machineCode: "VEM-TESTBED-LOCAL",
          },
          handoff: {},
          serialSession: {
            sessionId: "serial-session-1",
            binding: { serialSessionId: "serial-session-1" },
          },
          testCleanupTimeoutMs: 20,
          testDependencies: dependencies,
        }),
        /injected status timeout.*cleanup|cleanup.*deadline/is,
      );
      assert.equal(transactionReads, 2);
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      await client.close();
    }
  });

  for (const delayedOperation of [
    "status",
    "release",
    "transaction-read",
    "open",
  ]) {
    it(`aborts delayed ${delayedOperation} cleanup under one total deadline without late gate mutation`, async () => {
      const evidence = validEvidence();
      const { client } = await connectedInstalledOwnerClient();
      const events = [];
      const base = ordinarySaleDependencies(evidence, events, {
        failPendingOnce: true,
      });
      const signals = [];
      let lateMutation = 0;
      const delayed = (signal) =>
        new Promise((resolve, reject) => {
          signals.push(signal);
          const timer = setTimeout(() => {
            lateMutation += 1;
            resolve({ state: "open", pending: null });
          }, 100);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      let statusReads = 0;
      const dependencies = {
        ...base,
        readCreateOrderGate: async (...args) => {
          statusReads += 1;
          const signal = args[1]?.signal;
          if (delayedOperation === "status") return delayed(signal);
          return base.readCreateOrderGate(...args);
        },
        releaseCreateOrderGate: async (...args) =>
          delayedOperation === "release"
            ? delayed(args[2]?.signal)
            : base.releaseCreateOrderGate(...args),
        readCurrentTransaction: async (...args) =>
          delayedOperation === "transaction-read"
            ? delayed(args[1]?.signal)
            : base.readCurrentTransaction(...args),
        openCreateOrderGate: async (...args) =>
          delayedOperation === "open" && statusReads > 0
            ? delayed(args[1]?.signal)
            : base.openCreateOrderGate(...args),
      };
      const oldNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      try {
        const started = performance.now();
        await assert.rejects(
          runInstalledOwnerOrdinarySaleCompletion({
            client,
            guestInput: {
              runId: `ordinary-sale-delayed-${delayedOperation}`,
              machineCode: "VEM-TESTBED-LOCAL",
            },
            handoff: {},
            serialSession: {
              sessionId: "serial-session-1",
              binding: { serialSessionId: "serial-session-1" },
            },
            testCleanupTimeoutMs: 25,
            testDependencies: dependencies,
          }),
          /injected status timeout|cleanup|abort|timeout/i,
        );
        assert.equal(performance.now() - started < 200, true);
        assert.equal(signals.length >= 1, true);
        assert.equal(
          signals.every((signal) => signal.aborted),
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(lateMutation, 0);
      } finally {
        if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = oldNodeEnv;
        await client.close();
      }
    });
  }

  it("keeps the ordinary installed-owner helper free of Vision and owner cleanup operations", () => {
    const source = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );
    const tree = ts.createSourceFile(
      "fast-route-stress-sale.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const helper = tree.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "runInstalledOwnerOrdinarySaleCompletion",
    );
    assert.ok(helper?.body);
    const calls = [];
    const visit = (node) => {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(tree));
      ts.forEachChild(node, visit);
    };
    visit(helper.body);
    for (const forbidden of [
      "stopInstalledVisionOwnerForControlledMock",
      "ensureControlledVisionMock",
      "waitForControlledVisionRuntimeClient",
      "shutdownControlledVisionMock",
      "establishVisionPresenceForSale",
      "dispatchVisionDeparture",
      "dispatchRepeatedPaymentTouch",
      "client.close",
      "serialSession.stop",
      "serialSession.abort",
    ])
      assert.equal(calls.includes(forbidden), false, forbidden);
  });

  it("drives only physical touch navigation and repeats checkout submit during payment creation", () => {
    const steps = buildFastRouteStressScenarioSteps();
    assert.deepEqual(
      steps.map((step) => step.name),
      [
        "catalog category",
        "catalog product",
        "buy",
        "payment option",
        "payment submit",
        "payment submit repeat",
      ],
    );
    assert.equal(
      steps.every((step) => step.type === "customer-activation"),
      true,
    );
    assert.equal(
      steps.every((step) => (step.inputKind ?? "touch") === "touch"),
      true,
    );
  });

  it("opens the assigned fixture category before selecting its exact product", () => {
    const categorySelector =
      '[data-test="catalog-category"][data-category-key="underwear"]:not(:disabled)';
    const steps = buildFastRouteStressScenarioSteps(
      '[data-test="catalog-product"][data-slot-id="fixture-slot"]',
      categorySelector,
    );
    assert.equal(steps[0].selector, categorySelector);
    assert.equal(
      steps[1].selector,
      '[data-test="catalog-product"][data-slot-id="fixture-slot"]',
    );
  });

  it("dispatches the repeated payment touch at the original coordinates after DOM disablement", async () => {
    const calls = [];
    const client = {
      async send(method, params) {
        calls.push({ method, params });
        return {};
      },
    };
    const result = await dispatchRepeatedPaymentTouch(client, {
      center: { x: 412.5, y: 1711.25 },
    });

    assert.deepEqual(
      calls.map(({ method, params }) => ({
        method,
        type: params.type,
        point: params.touchPoints[0] ?? null,
      })),
      [
        {
          method: "Input.dispatchTouchEvent",
          type: "touchStart",
          point: { x: 412.5, y: 1711.25, radiusX: 1, radiusY: 1, force: 1 },
        },
        {
          method: "Input.dispatchTouchEvent",
          type: "touchEnd",
          point: null,
        },
      ],
    );
    assert.deepEqual(result.originalPoint, { x: 412.5, y: 1711.25 });
  });

  it("waits for sale readiness and a stable Catalog before observing customer navigation", async () => {
    let nowMs = 0;
    let sample = 0;
    const capability = {
      canStartSale: true,
      revision: 7,
      paymentOptions: {
        options: [
          {
            optionKey: "mock:mock",
            providerCode: "mock",
            method: "mock",
            ready: true,
            disabledReason: null,
          },
        ],
      },
    };
    const result = await waitForSaleStartReady({}, {}, 5_000, {
      now: () => nowMs,
      readRoute: async () => {
        sample += 1;
        return sample === 1
          ? "#/catalog"
          : sample === 2
            ? "#/boot"
            : "#/catalog";
      },
      readCapability: async () =>
        sample < 3 ? { canStartSale: false } : capability,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
    });

    assert.equal(result, capability);
    assert.ok(sample >= 7);
  });

  it("does not consider sale ready until the mock payment option is ready", async () => {
    let nowMs = 0;
    let sample = 0;
    const readyOption = {
      optionKey: "mock:mock",
      providerCode: "mock",
      method: "mock",
      ready: true,
      disabledReason: null,
    };
    const result = await waitForSaleStartReady({}, {}, 5_000, {
      now: () => nowMs,
      readRoute: async () => "#/catalog",
      readCapability: async () => {
        sample += 1;
        return sample < 3
          ? {
              canStartSale: true,
              paymentOptions: {
                options: [
                  { ...readyOption, ready: false, disabledReason: "cold" },
                ],
              },
            }
          : { canStartSale: true, paymentOptions: { options: [readyOption] } };
      },
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
    });
    assert.equal(result.paymentOptions.options[0].ready, true);
    assert.ok(sample >= 14, `expected repeated readiness polls, got ${sample}`);
  });

  it("captures root as the first CDP transition away from Catalog without runtime trace input", async () => {
    const handlers = new Map();
    let locationHash = "#/catalog";
    let tick = 0;
    const client = {
      on(method, handler) {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
      async send(method) {
        assert.equal(method, "Runtime.evaluate");
        return { result: { value: locationHash } };
      },
    };
    const observer = await startContinuousCdpLocationHashObservation(client, {
      clock: () => new Date(1_000 + tick++),
    });

    handlers.get("Page.navigatedWithinDocument")({
      url: "http://tauri.localhost/",
    });
    locationHash = "#/result/success";

    assert.throws(
      () => observer.throwIfFailed(),
      /continuous CDP location\.hash observation reached Catalog or root/,
    );
    assert.deepEqual(
      observer.snapshot().entries.map((entry) => entry.locationHash),
      [""],
    );
    observer.stop();
  });

  it("accepts exactly one fully correlated sale across real temporal boundaries", () => {
    const summary = validateFastRouteStressSaleEvidence(validEvidence());
    assert.deepEqual(summary.protocol, ["VEND", "F0", "F1", "F2"]);
    assert.equal(summary.orderNo, "ORD-1");
    assert.equal(summary.commandNo, "CMD-1");
    assert.equal(summary.slotDisplayLabel, "R2C5");
    assert.equal(summary.platformStockDeltaAfterF2, -1);
    assert.equal(summary.daemonStockDeltaAfterF2, -1);
    assert.equal(summary.saleStartCapabilityRevision, 7);
    assert.equal(summary.projectionRefreshReason, "transaction_projection");
    assert.equal(summary.projectionRefreshRoute, "#/payment");
    assert.equal(summary.repeatedPhysicalTouchTraceId, 3);
    assert.equal(summary.repeatedPhysicalTouchAt, "2026-07-18T04:00:00.125Z");
    assert.deepEqual(summary.uiViewport, { width: 1080, height: 1920 });
    assert.deepEqual(summary.runtimeTraceCorrelation.rawFrames, [
      {
        parsedOpcode: "F0",
        rawFrameHex: "55F0",
        capturedAt: "2026-07-18T04:00:01.000Z",
        boundaryId: "host-pty:serial-session-1:2",
        sessionId: "serial-session-1",
        provenance: "host_pty_raw_serial_journal",
      },
      {
        parsedOpcode: "F1",
        rawFrameHex: "55F1",
        capturedAt: "2026-07-18T04:00:02.000Z",
        boundaryId: "host-pty:serial-session-1:3",
        sessionId: "serial-session-1",
        provenance: "host_pty_raw_serial_journal",
      },
      {
        parsedOpcode: "F2",
        rawFrameHex: "55F2",
        capturedAt: "2026-07-18T04:00:03.000Z",
        boundaryId: "host-pty:serial-session-1:4",
        sessionId: "serial-session-1",
        provenance: "host_pty_raw_serial_journal",
      },
    ]);
  });

  it("accepts consecutive repeated lower-controller status reports", () => {
    const evidence = validEvidence();
    const [vend, f0, f1, f2] = evidence.serial.rawFrames;
    evidence.serial.rawFrames = [
      vend,
      f0,
      { ...f0, capturedAt: "2026-07-18T04:00:01.100Z" },
      f1,
      { ...f1, capturedAt: "2026-07-18T04:00:02.100Z" },
      f2,
      { ...f2, capturedAt: "2026-07-18T04:00:03.100Z" },
    ];

    const summary = validateFastRouteStressSaleEvidence(evidence);

    assert.deepEqual(summary.protocol, ["VEND", "F0", "F1", "F2"]);
  });

  it("fails closed when raw serial direction/order is inferred from semantic event names", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[0] = {
      ...evidence.serial.rawFrames[0],
      parsedOpcode: "F0",
    };
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /raw serial frame 1 F0 must match the 2-byte production frame 55 F0/,
    );
  });

  it("fails closed when the raw inbound production bytes are not exact 55 F0/F1/F2 frames", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[1] = {
      ...evidence.serial.rawFrames[1],
      rawFrameHex: "55F000",
    };
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /raw serial frame 2 F0 must match the 2-byte production frame 55 F0/,
    );
  });

  it("fails closed on success UI or stock movement before inbound F2", () => {
    const evidence = validEvidence();
    evidence.ui.afterF1BeforeF2.result = { kind: "success" };
    evidence.platform.afterF1BeforeF2.raw.inventories[0].onHandQty = 2;
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /UI must not show success before inbound F2/,
    );
  });

  it("fails closed when the installed UI viewport is not exact 1080x1920 portrait", () => {
    const evidence = validEvidence();
    evidence.uiViewport.innerHeight = 1080;
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /installed UI viewport must be exactly 1080x1920/,
    );
  });

  it("fails closed when sale-start-capability does not expose the ready mock option", () => {
    const evidence = validEvidence();
    evidence.saleStartCapability.paymentOptions.options = [];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /sale-start-capability must expose a ready mock:mock payment option/,
    );
  });

  it("fails closed when Vision departure has no accepted installed-runtime delivery or guarded trace", () => {
    const evidence = validEvidence();
    evidence.visionDelivery.connectedRuntimeClients = 0;
    evidence.visionDelivery.acceptedDeliveries = 0;
    evidence.machineRuntimeTrace.entries = [];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /Vision departure requires a connected installed runtime client/,
    );
  });

  it("fails closed when the post-request trace has no stable departure session edge", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries.find(
      (entry) => entry.intentType === "presence.departed",
    ).sourceEventId = "departure-event-other";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /guarded stable Vision departure navigation effect after the control-request boundary/,
    );
  });

  it("fails closed when Vision departure is not anchored inside the gated pending payment creation interval", () => {
    const evidence = validEvidence();
    evidence.repeatedPaymentTouch.releaseRequestedAt =
      "2026-07-18T03:59:59.950Z";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /Vision departure must occur while payment creation is explicitly pending/,
    );
  });

  it("fails closed when the repeated physical touch has no installed-runtime trace after its pre-dispatch boundary", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter((entry) => entry.id !== 3);
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /repeated physical customer\.touch after its pre-dispatch boundary/,
    );
  });

  it("fails closed on a pre-Vision decided Catalog navigation after the stressed customer flow begins", () => {
    const evidence = validEvidence();
    const preVisionTouch = evidence.machineRuntimeTrace.entries.find(
      (entry) => entry.id === 1,
    );
    preVisionTouch.decidedRoute = "#/catalog";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /actual or decided Catalog navigation after the stressed customer flow began/,
    );
  });

  it("fails closed on transient Catalog or root CDP location.hash even when the runtime trace reset hides it", () => {
    for (const forbiddenHash of ["#/catalog", "", "#/"]) {
      const evidence = validEvidence();
      evidence.noCatalogTraceBoundary.lastEntryId = 99;
      evidence.continuousCdpLocationHash.entries.splice(2, 0, {
        sequence: 99,
        method: "Page.navigatedWithinDocument",
        locationHash: forbiddenHash,
        observedAt: "2026-07-18T04:00:00.120Z",
      });
      assert.throws(
        () => validateFastRouteStressSaleEvidence(evidence),
        /continuous CDP location\.hash observation reached Catalog or root/,
      );
    }
  });

  it("fails closed when the runtime trace has no correlated result surface", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) => entry.type !== "transaction_surface",
      );
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /runtime trace must expose a correlated result surface/,
    );
  });

  it("does not compare unsynchronised Windows and host raw-journal clocks", () => {
    const evidence = validEvidence();
    const resultSurface = evidence.machineRuntimeTrace.entries.find(
      (entry) => entry.type === "transaction_surface",
    );
    resultSurface.at = "2026-07-18T04:00:02.000Z";
    resultSurface.recordedAt = "2026-07-18T04:00:02.000Z";
    assert.doesNotThrow(() => validateFastRouteStressSaleEvidence(evidence));
  });

  it("fails closed when F0/F1/F2 do not retain host raw journal provenance", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[2].capturedAt = "2026-07-18T04:00:01.000Z";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /host raw F0\/F1\/F2 capturedAt values must be strictly ordered/,
    );
  });

  it("fails closed when the real transaction projection refresh is missing after Vision departure", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) => entry.intentType !== "transaction.projection",
      );
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /real transaction projection refresh/,
    );
  });

  it("fails closed when MQTT command or serial slot is not correlated to the order", () => {
    const evidence = validEvidence();
    evidence.mqttMessages[0].payload.payload.commandNo = "CMD-OTHER";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /MQTT vend command must correlate commandNo CMD-1/,
    );
  });

  it("accepts MQTT vend coordinates when the payload serializes rowNo and cellNo as strings", () => {
    const evidence = validEvidence();
    evidence.mqttMessages[0].payload.payload.slot = {
      rowNo: "2",
      cellNo: "5",
    };

    const summary = validateFastRouteStressSaleEvidence(evidence);

    assert.equal(summary.slotDisplayLabel, "R2C5");
  });

  it("fails closed when the repeated touch creates a late duplicate order or payment", () => {
    const evidence = validEvidence();
    evidence.platform.afterF2.raw.orders = [
      ...evidence.platform.afterF2.raw.orders,
      { id: "order-2", orderNo: "ORD-2" },
    ];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /duplicate order, payment, or vending command appeared after inbound F2/,
    );
  });

  it("fails closed when the pre-F0 boundary does not already hold the correlated command", () => {
    const evidence = validEvidence();
    evidence.platform.beforeF0.raw.commands = [];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /before inbound F0 the correlated order, payment, and vending command must already exist exactly once/,
    );
  });

  it("fails closed when authoritative pre-F0 payment status or paymentNo is not the gated payment", () => {
    const wrongStatus = validEvidence();
    wrongStatus.platform.beforeF0.raw.payments[0].status = "pending";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongStatus),
      /authoritative pre-F0 payment status must be succeeded/,
    );

    const wrongPaymentNo = validEvidence();
    wrongPaymentNo.platform.beforeF0.raw.payments[0].paymentNo = "PAY-OTHER";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongPaymentNo),
      /authoritative pre-F0 paymentNo must match the create-order gate paymentNo/,
    );
  });

  it("rejects synthetic authorized as a pre-F0 payment status", () => {
    const evidence = validEvidence();
    evidence.platform.beforeF0.raw.payments[0].status = "authorized";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /authoritative pre-F0 payment status must be succeeded/,
    );
  });

  it("fails closed when post-F2 paymentNo or succeeded status drifts from pre-F0", () => {
    const wrongPaymentNo = validEvidence();
    wrongPaymentNo.platform.afterF2.raw.payments[0].paymentNo = "PAY-OTHER";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongPaymentNo),
      /authoritative post-F2 payment must retain the gated paymentNo and succeeded status/,
    );

    const wrongStatus = validEvidence();
    wrongStatus.platform.afterF2.raw.payments[0].status = "pending";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongStatus),
      /authoritative post-F2 payment must retain the gated paymentNo and succeeded status/,
    );
  });

  it("fails closed when authoritative post-F2 order or command status is not terminal", () => {
    const evidence = validEvidence();
    evidence.platform.afterF2.raw.orders[0].status = "dispensing";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /authoritative post-F2 order and dispatch command must be fulfilled, paid, dispensed, and succeeded/,
    );
  });

  it("preserves bounded failure evidence snapshots and collected log references", () => {
    const report = buildFastRouteStressSaleFailureReport({
      mode: "fast",
      stage: "snapshot-before-f0",
      error: new Error("before F0 gate timed out"),
      controlPlaneSessionId: "fast-sale-session-1",
      liveSale: { orderId: "order-1", paymentId: "payment-1" },
      runtimeTrace: [{ type: "navigation", at: "2026-07-18T04:00:00.000Z" }],
      snapshots: {
        platform: {
          baseline: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
          beforeF0: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
          afterF1BeforeF2: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
          afterF2: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
        },
        daemon: {
          baseline: { items: [] },
          beforeF0: { items: [] },
          afterF1BeforeF2: { items: [] },
          afterF2: { items: [] },
        },
      },
      hostEvidence: {
        references: {
          simulatorLog: "/tmp/fast-route/simulator.log",
        },
      },
      checkpoints: [
        { screenshot: { ref: "/tmp/fast-route/failure-before-f0.png" } },
      ],
      logs: {
        daemonStdout: { ref: "/tmp/fast-route/daemon-stdout.tail.log" },
        daemonStderr: { ref: "/tmp/fast-route/daemon-stderr.tail.log" },
        platform: { ref: "/tmp/fast-route/platform-service-api.log" },
        platformError: "journalctl exited with 1: stdout was empty",
        simulator: "/tmp/fast-route/simulator.log",
      },
    });

    assert.equal(report.ok, false);
    assert.deepEqual(Object.keys(report.snapshots.platform), [
      "baseline",
      "beforeF0",
      "afterF1BeforeF2",
      "afterF2",
    ]);
    assert.deepEqual(Object.keys(report.snapshots.daemon), [
      "baseline",
      "beforeF0",
      "afterF1BeforeF2",
      "afterF2",
      "failureCurrentTransaction",
    ]);
    assert.deepEqual(report.logs.platform, {
      ref: "/tmp/fast-route/platform-service-api.log",
    });
    assert.equal(
      report.logs.platformError,
      "journalctl exited with 1: stdout was empty",
    );
    assert.equal(report.logs.simulator, "/tmp/fast-route/simulator.log");
    assert.deepEqual(report.logs.failureScreenshots, [
      "/tmp/fast-route/failure-before-f0.png",
    ]);
  });

  it("anchors the tracer in production-equivalent runtime surfaces", () => {
    const implementation = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );
    assert.match(implementation, /Input\.dispatchTouchEvent/);
    assert.match(implementation, /__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__/);
    assert.match(implementation, /mock:mock/);
    assert.match(
      implementation,
      /payments\/mock\/\$\{encodeURIComponent\(paymentNo\)\}\/complete/,
    );
    assert.match(implementation, /vision\/control\/departure/);
    assert.match(implementation, /mock-payment-create-gate\/arm/);
    assert.match(implementation, /mock-payment-create-gate\/status/);
    assert.match(implementation, /mock-payment-create-gate\/release/);
    assert.match(implementation, /replaceSerialSessionAndUpdateHandoff/);
    assert.match(implementation, /release-f0/);
    assert.match(implementation, /platform-log/);
    assert.match(implementation, /snapshots:/);
    assert.match(
      implementation,
      /--import",\s*"tsx",\s*"apps\/vision-mock\/src\/server\.ts/,
    );
    assert.match(implementation, /control\/status/);
    assert.match(implementation, /shutdownControlledVisionMock/);
    assert.match(implementation, /did not release port.*after SIGTERM/);
    assert.match(
      implementation,
      /installed UI viewport must be exactly 1080x1920/,
    );
    assert.match(
      implementation,
      /sale-start-capability must expose a ready mock:mock payment option/,
    );
    assert.match(implementation, /installed_machine_runtime_trace_cdp/);
    assert.match(implementation, /customer\.touch/);
    assert.match(implementation, /pre-dispatch trace boundary/);
    assert.match(implementation, /no-Catalog trace boundary/);
    assert.match(implementation, /actual or decided Catalog navigation/);
    assert.match(implementation, /Page\.navigatedWithinDocument/);
    assert.match(implementation, /Page\.frameNavigated/);
    assert.match(implementation, /Runtime\.evaluate\(location\.hash\)/);
    assert.doesNotMatch(implementation, /\["authorized", "succeeded"\]/);
    assert.match(implementation, /terminal post-F2 order\/command state/);
    assert.match(implementation, /host_pty_raw_serial_journal/);
    assert.doesNotMatch(implementation, /observe-payment/);
    assert.doesNotMatch(implementation, /observe-result/);
    assert.doesNotMatch(implementation, /fastSale\.createOrderGate\.statePath/);
    assert.match(implementation, /run-vm-host-adapter/);
    assert.doesNotMatch(implementation, /simulatedHardwareSaleFlow/);
    assert.doesNotMatch(implementation, /scannerCode/);
  });

  it("replaces the accumulated serial observer before any sale action", () => {
    const implementation = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );
    const runner = implementation.slice(
      implementation.indexOf("async function runFastRouteStressSale(options)"),
    );
    const replacement = runner.indexOf(
      "await admitFreshSerialSessionForSale({",
    );
    const saleReadyAfterReplacement = runner.indexOf(
      "await waitForSaleStartReady(handoff, client)",
      replacement,
    );
    const createOrderGate = runner.indexOf(
      "createOrderGate = await serialAdmission.armCreateOrderGate()",
    );
    const firstCustomerAction = runner.indexOf(
      'stage = "physical-catalog-to-checkout"',
    );

    assert.ok(
      replacement >= 0,
      "the full sale must replace its inherited serial observer instead of reusing an accumulated journal",
    );
    assert.ok(
      replacement < saleReadyAfterReplacement &&
        saleReadyAfterReplacement < createOrderGate &&
        createOrderGate < firstCustomerAction,
      "the replacement session must be ready before gate, order/payment, and first customer action",
    );
    assert.doesNotMatch(
      runner.slice(0, firstCustomerAction),
      /commissioningSession\s*\?\?\s*\(await controlPlaneRequest/,
    );
  });

  it("waits for fresh lower-controller readiness before opening the sale admission", async () => {
    const events = [];
    const journals = {
      "serial-old": Array.from({ length: 257 }, () => ({ raw: "stale" })),
      "serial-fresh": [],
    };
    const handoff = { commissioningSerialSession: { sessionId: "serial-old" } };
    let hardwarePolls = 0;
    let ready = false;
    let replacementStarted = false;
    const admission = await admitFreshSerialSessionForSale({
      guestInput: {
        runId: "RUN-FRESH",
        machineCode: "VEM-FRESH",
        hostControlPlane: {
          targetIdentity: "vm-target://fresh",
          runtimeBaseIdentity: "runtime-base://fresh",
        },
      },
      handoff,
      handoffPath: "C:\\handoff.json",
      writeJsonFile: () => events.push("handoff:persisted"),
      control: async (_input, path) => {
        events.push(`control:${path}`);
        if (path.endsWith("/serial-old/abort")) return { aborted: true };
        if (path.endsWith("/start")) {
          replacementStarted = true;
          return { sessionId: "serial-fresh" };
        }
        const sessionId = path.match(/serial-sessions\/([^/]+)\//)?.[1];
        if (sessionId === "serial-old") {
          throw new Error(
            `raw serial evidence exceeded ${journals[sessionId].length} records`,
          );
        }
        assert.equal(sessionId, "serial-fresh");
        assert.equal(ready, true);
        return { frame: { sessionId } };
      },
      daemonGet: async (path) => {
        events.push(`daemon:${path}`);
        assert.equal(replacementStarted, true);
        if (path === "/v1/hardware-bindings") hardwarePolls += 1;
        ready = hardwarePolls >= 2;
        return path === "/v1/hardware-bindings"
          ? { roles: [{ role: "lower_controller", ready }] }
          : { canStartSale: ready };
      },
      armCreateOrderGate: async () => {
        events.push("gate:arm");
        assert.equal(ready, true);
        return { controlPlane: "mock-payment-create-gate" };
      },
    });

    assert.equal(hardwarePolls, 2);
    assert.ok(journals["serial-old"].length > 256);
    assert.equal(handoff.commissioningSerialSession.sessionId, "serial-fresh");
    assert.equal(events.includes("gate:arm"), false);
    assert.equal(events.includes("customer:touch"), false);
    await admission.armCreateOrderGate();
    await admission.runCustomerAction(async () => {
      events.push("customer:touch");
    });
    await admission.serialRequest("wait-frame", { parsedOpcode: "VEND" });
    await admission.serialRequest("release-f0");
    await admission.serialRequest("wait-frame", { parsedOpcode: "F0" });
    await admission.serialRequest("wait-frame", { parsedOpcode: "F1" });
    await admission.serialRequest("release-f2");
    await admission.serialRequest("wait-frame", { parsedOpcode: "F2" });
    await admission.serialRequest("evidence");
    await admission.serialRequest("stop");

    assert.ok(
      events.indexOf("daemon:/v1/hardware-bindings") <
        events.indexOf("gate:arm"),
    );
    assert.ok(events.indexOf("gate:arm") < events.indexOf("customer:touch"));
    assert.deepEqual(
      events.filter((event) => event.startsWith("control:")),
      [
        "control:/v1/serial-sessions/serial-old/abort",
        "control:/v1/serial-sessions/start",
        "control:/v1/serial-sessions/serial-fresh/wait-frame",
        "control:/v1/serial-sessions/serial-fresh/release-f0",
        "control:/v1/serial-sessions/serial-fresh/wait-frame",
        "control:/v1/serial-sessions/serial-fresh/wait-frame",
        "control:/v1/serial-sessions/serial-fresh/release-f2",
        "control:/v1/serial-sessions/serial-fresh/wait-frame",
        "control:/v1/serial-sessions/serial-fresh/evidence",
        "control:/v1/serial-sessions/serial-fresh/stop",
      ],
    );
  });

  it("exports an explicit controlled vision mock shutdown path", () => {
    assert.equal(typeof shutdownControlledVisionMock, "function");
  });

  it("stops the installed Vision owner before binding the controlled Vision mock", () => {
    assert.equal(typeof stopInstalledVisionOwnerForControlledMock, "function");
    const source = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );

    assert.match(source, /Stop-ScheduledTask -TaskName "VEMVisionRuntime"/);
    assert.match(source, /verifyPortCanBeRebound\(7892\)/);
    assert.ok(
      source.indexOf("await stopInstalledVisionOwnerForControlledMock()") <
        source.indexOf("await ensureControlledVisionMock"),
    );
  });

  it("retries controlled departure until the persistent runtime client accepts it", () => {
    const source = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /async function dispatchVisionDeparture[\s\S]*Date\.now\(\) \+ 15_000[\s\S]*await sleep\(250\)/,
    );
  });

  it("waits for a protocol-registered Vision runtime before customer input", () => {
    const source = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /waitForControlledVisionRuntimeClient/);
    assert.match(source, /connectedRuntimeClients\) >= 1/);
    assert.ok(
      source.indexOf("await waitForControlledVisionRuntimeClient") <
        source.indexOf('stage = "physical-catalog-to-checkout"'),
    );
  });

  it("aggregates cleanup failures without dropping the primary error", async () => {
    const primary = new Error("sale flow failed");
    let cleanup;
    await assert.rejects(async () => {
      await runCleanupStep("reopen payment create gate", async () => {
        throw new Error("gate status unavailable");
      });
    });
    try {
      await runCleanupStep("reopen payment create gate", async () => {
        throw new Error("gate status unavailable");
      });
    } catch (error) {
      cleanup = error;
    }
    const combined = combineCleanupError(primary, [cleanup]);
    assert.equal(combined instanceof AggregateError, true);
    assert.equal(combined.errors[0], primary);
    assert.match(combined.message, /sale flow failed/);
    assert.match(combined.message, /reopen payment create gate failed/);
  });

  it("releases the provider before settling the correlated transaction and reopening the gate", () => {
    const implementation = readFileSync(
      new URL("./fast-route-stress-sale.ts", import.meta.url),
      "utf8",
    );

    assert.match(implementation, /"release pending create gate"/);
    assert.match(implementation, /"settle pending create transaction"/);
    assert.match(implementation, /"reopen payment create gate"/);
    assert.match(implementation, /"verify payment create gate"/);
    assert.ok(
      implementation.indexOf('"release pending create gate"') <
        implementation.indexOf('"settle pending create transaction"'),
    );
    assert.ok(
      implementation.indexOf('"settle pending create transaction"') <
        implementation.indexOf('"reopen payment create gate"'),
    );
    assert.ok(
      implementation.indexOf('"reopen payment create gate"') <
        implementation.indexOf('"verify payment create gate"'),
    );
    assert.match(implementation, /CLEANUP_REQUEST_TIMEOUT_MS/);
    assert.match(implementation, /mock-payment-create-gate\/status/);
    assert.match(
      implementation,
      /payment create gate did not return to open with no pending payment/,
    );
    assert.match(implementation, /runCleanupStep\("abort serial session"/);
    assert.match(
      implementation,
      /serial session abort did not confirm inactive state/,
    );
    assert.match(
      implementation,
      /runCleanupStep\(\s*"stop controlled vision mock"/,
    );
  });
});
