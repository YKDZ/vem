// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import {
  installPresenceDepartureNavigation,
  resetCustomerPresenceSessionForTests,
} from "@/composables/usePresenceInteraction";
import {
  installTransactionRouteAuthority,
  machineRuntimeTrace,
} from "@/router/transaction-route-authority";
import { useCheckoutStore } from "@/stores/checkout";
import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

type RuntimeEventHandlers = {
  onEvent: (event: unknown) => void;
  onError?: (error: unknown) => void;
  onStale: () => void;
  onReconnect?: () => void;
};

const {
  initializeMock,
  getHealthMock,
  getReadyMock,
  getSaleStartCapabilityMock,
  getSaleViewMock,
  getSyncStatusMock,
  getCurrentTransactionMock,
  getEffectiveRuntimeConfigurationMock,
  subscribeEventsMock,
  createJourneyAudioRuntimeMock,
  disposeJourneyAudioMock,
} = vi.hoisted(() => {
  return {
    initializeMock: vi.fn(),
    getHealthMock: vi.fn(),
    getReadyMock: vi.fn(),
    getSaleStartCapabilityMock: vi.fn(),
    getSaleViewMock: vi.fn(),
    getSyncStatusMock: vi.fn(),
    getCurrentTransactionMock: vi.fn(),
    getEffectiveRuntimeConfigurationMock: vi.fn(),
    subscribeEventsMock: vi.fn<
      (handlers: RuntimeEventHandlers) => { close(): void }
    >(() => ({ close: vi.fn() })),
    createJourneyAudioRuntimeMock: vi.fn(),
    disposeJourneyAudioMock: vi.fn(),
  };
});

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    initialize: initializeMock,
    getHealth: getHealthMock,
    getReady: getReadyMock,
    getSaleStartCapability: getSaleStartCapabilityMock,
    getSaleView: getSaleViewMock,
    getSyncStatus: getSyncStatusMock,
    getCurrentTransaction: getCurrentTransactionMock,
    getEffectiveRuntimeConfiguration: getEffectiveRuntimeConfigurationMock,
    subscribeEvents: subscribeEventsMock,
  },
}));

vi.mock("./customer-journey-audio-runtime", () => ({
  createCustomerJourneyAudioRuntime: createJourneyAudioRuntimeMock,
}));

import { useSaleCapabilityStore } from "@/stores/sale-capability";

import { startMachineRuntime, stopMachineRuntime } from "./machine-runtime";

let pinia: ReturnType<typeof createPinia>;
let disposeRouteAuthority: (() => void) | null = null;
let presenceRuntime: ReturnType<typeof createApp> | null = null;
let presenceHost: HTMLDivElement | null = null;

function noCurrentTransaction() {
  return {
    orderId: null,
    orderNo: null,
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
    nextAction: null,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function activePaymentTransaction() {
  return {
    ...noCurrentTransaction(),
    orderId: "550e8400-e29b-41d4-a716-446655440012",
    orderNo: "ORD-RUNTIME-VISION-001",
    paymentId: "550e8400-e29b-41d4-a716-446655440013",
    paymentNo: "PAY-RUNTIME-VISION-001",
    paymentMethod: "qr_code" as const,
    paymentProvider: "alipay" as const,
    paymentUrl: "https://pay.example/runtime-vision",
    paymentStatus: "pending" as const,
    orderStatus: "pending_payment" as const,
    totalAmountCents: 4900,
    nextAction: "wait_payment" as const,
    expiresAt: "2099-06-30T08:15:00.000Z",
    updatedAt: "2026-07-18T08:00:00.000Z",
  };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  initializeMock.mockResolvedValue(undefined);
  getHealthMock.mockResolvedValue({ updatedAt: "2026-07-17T00:00:00.000Z" });
  getReadyMock.mockResolvedValue({
    ready: true,
    updatedAt: "2026-07-17T00:00:00.000Z",
  });
  getSaleViewMock.mockResolvedValue({
    items: [],
    source: "local_stock",
    planogramVersion: null,
    lastUpdatedAt: null,
  });
  getSyncStatusMock.mockResolvedValue({
    mqttConnected: true,
    mqttRunning: true,
    lastCommandNo: null,
    outboxSize: 0,
    outboxMax: 100,
    outboxUsage: 0,
    lastHeartbeatAt: null,
    lastError: null,
  });
  getCurrentTransactionMock.mockResolvedValue(noCurrentTransaction());
  getEffectiveRuntimeConfigurationMock.mockResolvedValue({
    schemaVersion: 1,
    revision: "runtime-config-1",
    machine: { code: "VEM-TESTBED" },
    platform: { apiBaseUrl: "http://127.0.0.1/api" },
    experience: {
      audio: {
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      },
    },
  });
  disposeJourneyAudioMock.mockResolvedValue(undefined);
  createJourneyAudioRuntimeMock.mockReturnValue({
    requestTestPlayback: vi.fn(),
    trace: vi.fn(() => []),
    dispose: disposeJourneyAudioMock,
  });
});

afterEach(async () => {
  presenceRuntime?.unmount();
  presenceRuntime = null;
  presenceHost?.remove();
  presenceHost = null;
  resetCustomerPresenceSessionForTests();
  disposeRouteAuthority?.();
  disposeRouteAuthority = null;
  await stopMachineRuntime(pinia);
  vi.useRealTimers();
});

describe("Machine runtime coordinator", () => {
  it("exposes production teardown that settles only after audio disposal", async () => {
    let resolveAudioDisposal: (() => void) | null = null;
    disposeJourneyAudioMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAudioDisposal = resolve;
        }),
    );
    startMachineRuntime(pinia);

    const teardown = stopMachineRuntime(pinia);
    expect(stopMachineRuntime(pinia)).toBe(teardown);
    let teardownSettled = false;
    void teardown.then(() => {
      teardownSettled = true;
    });
    await Promise.resolve();

    expect(teardownSettled).toBe(false);
    const finishDisposal = resolveAudioDisposal as (() => void) | null;
    if (!finishDisposal) throw new Error("audio disposal did not start");
    finishDisposal();
    await teardown;
    expect(teardownSettled).toBe(true);
  });

  it("owns one initial read, one shared event subscription, and one fallback poll", async () => {
    vi.useFakeTimers();
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 1 }))
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 2 }));

    startMachineRuntime(pinia);
    startMachineRuntime(pinia);
    await vi.advanceTimersByTimeAsync(0);

    expect(getSaleStartCapabilityMock).toHaveBeenCalledOnce();
    expect(getEffectiveRuntimeConfigurationMock).toHaveBeenCalledOnce();
    expect(subscribeEventsMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(2);

    await stopMachineRuntime(pinia);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(2);
  });

  it("returns an idle offline machine to catalog after sale capability recovers", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/offline", name: "offline", component: {} },
      ],
    });
    disposeRouteAuthority = installTransactionRouteAuthority(router, pinia);
    await router.push("/offline");
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(
        saleCapabilitySnapshot({ revision: 1, canStartSale: false }),
      )
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 2 }));

    startMachineRuntime(pinia);
    await vi.waitFor(() => {
      expect(useSaleCapabilityStore().orderingKey).toBe(
        "machine-test-daemon:1",
      );
    });
    const subscription = subscribeEventsMock.mock.calls[0];
    if (!subscription)
      throw new Error("runtime did not subscribe to daemon events");
    subscription[0].onEvent({
      type: "sale_start_capability_changed",
      eventId: "capability-recovered",
      updatedAt: "2026-07-19T00:00:00.000Z",
      generation: "machine-test-daemon",
      revision: 2,
    });

    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe("catalog");
    });
    expect(machineRuntimeTrace()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intentType: "readiness.recovered",
          decision: "accepted",
          reasonCode: "sale_capability_recovered",
        }),
      ]),
    );
  });

  it("refreshes the active order projection after a live Vision departure", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/catalog", name: "catalog", component: {} },
        { path: "/payment", name: "payment", component: {} },
      ],
    });
    disposeRouteAuthority = installTransactionRouteAuthority(router, pinia);
    useCheckoutStore(pinia).applyTransaction(activePaymentTransaction());
    await router.push("/payment");

    presenceHost = document.createElement("div");
    document.body.appendChild(presenceHost);
    presenceRuntime = createApp(
      defineComponent({
        setup() {
          installPresenceDepartureNavigation({
            visionDepartureHysteresisMs: 0,
          });
          return () => null;
        },
      }),
    );
    presenceRuntime.use(pinia);
    presenceRuntime.mount(presenceHost);

    startMachineRuntime(pinia);
    const subscription = subscribeEventsMock.mock.calls[0];
    if (!subscription)
      throw new Error("runtime did not create an event subscription");
    const [handlers] = subscription;

    handlers.onEvent({
      type: "vision_changed",
      eventId: "daemon-vision-present-001",
      updatedAt: "2026-07-18T08:00:01.000Z",
      enabled: true,
      online: true,
      message: "Vision presence observed",
      latestDiagnosticPayload: {
        type: "vision.presence_status",
        payload: {
          source: "top",
          eventId: "VISION-PRESENT-001",
          state: "approach",
          reason: "person_present_but_not_close",
          detectedAt: "2026-07-18T08:00:01.000Z",
          personPresent: true,
          closeNow: false,
          close: false,
          closeTrigger: null,
          proximity: { present: true },
        },
      },
    });
    await nextTick();

    handlers.onEvent({
      type: "vision_changed",
      eventId: "daemon-vision-departure-001",
      updatedAt: "2026-07-18T08:00:02.000Z",
      enabled: true,
      online: true,
      message: "Vision departure observed",
      latestDiagnosticPayload: {
        type: "vision.person_departed",
        payload: {
          source: "top",
          eventId: "VISION-DEPARTURE-001",
          detectedAt: "2026-07-18T08:00:02.000Z",
          lastSeenAt: "2026-07-18T08:00:01.000Z",
          reason: "left_frame",
        },
      },
    });

    await vi.waitFor(() => {
      expect(getCurrentTransactionMock).toHaveBeenCalledOnce();
      expect(machineRuntimeTrace()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "navigation",
            intentType: "presence.departed",
            sourceEventId: "VISION-DEPARTURE-001",
            decision: "rejected",
            reasonCode: "active_transaction_route",
            transactionOrderNo: "ORD-RUNTIME-VISION-001",
          }),
          expect.objectContaining({
            type: "navigation",
            intentType: "transaction.projection",
            decision: "accepted",
            transactionOrderNo: "ORD-RUNTIME-VISION-001",
            reasonCode: expect.stringMatching(/^transaction_projection/),
          }),
        ]),
      );
    });
  });

  it("exposes transaction recovery when the daemon stream drops during payment", async () => {
    const checkoutStore = useCheckoutStore(pinia);
    checkoutStore.applyTransaction(activePaymentTransaction());
    getCurrentTransactionMock.mockRejectedValueOnce(
      new Error("daemon transport unavailable"),
    );
    startMachineRuntime(pinia);

    const subscription = subscribeEventsMock.mock.calls[0];
    if (!subscription)
      throw new Error("runtime did not subscribe to daemon events");
    subscription[0].onStale();

    await vi.waitFor(() => {
      expect(checkoutStore.customerCheckoutRecovery).toEqual({
        active: true,
        orderCredential: "ORD-RUNTIME-VISION-001",
      });
    });
  });

  it("reconciles only after the replacement event stream opens", async () => {
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 1 }))
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 2 }))
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 3 }));
    startMachineRuntime(pinia);
    await vi.waitFor(() => {
      expect(useSaleCapabilityStore().orderingKey).toBe(
        "machine-test-daemon:1",
      );
    });

    const firstSubscription = subscribeEventsMock.mock.calls[0];
    if (!firstSubscription) {
      throw new Error("runtime did not create an event subscription");
    }
    const [handlers] = firstSubscription;
    handlers.onEvent({
      type: "sale_start_capability_changed",
      eventId: "capability-2",
      updatedAt: "2026-07-17T00:00:02.000Z",
      generation: "machine-test-daemon",
      revision: 2,
    });
    await vi.waitFor(() => {
      expect(useSaleCapabilityStore().orderingKey).toBe(
        "machine-test-daemon:2",
      );
    });

    handlers.onStale();
    await Promise.resolve();
    expect(useSaleCapabilityStore().orderingKey).toBe("machine-test-daemon:2");

    handlers.onReconnect?.();
    await vi.waitFor(() => {
      expect(useSaleCapabilityStore().orderingKey).toBe(
        "machine-test-daemon:3",
      );
    });
    expect(initializeMock).toHaveBeenCalledWith(true);
  });

  it("retries a failed forced IPC initialization after a bounded backoff", async () => {
    vi.useFakeTimers();
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 1 }))
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 2 }));
    initializeMock
      .mockRejectedValueOnce(new Error("daemon ready file unavailable"))
      .mockResolvedValueOnce(undefined);
    startMachineRuntime(pinia);
    await vi.advanceTimersByTimeAsync(0);

    const firstSubscription = subscribeEventsMock.mock.calls[0];
    if (!firstSubscription) {
      throw new Error("runtime did not create an event subscription");
    }
    const [handlers] = firstSubscription;
    handlers.onReconnect?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(initializeMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(initializeMock).toHaveBeenCalledTimes(2);
    expect(useSaleCapabilityStore().orderingKey).toBe("machine-test-daemon:2");
  });

  it("retries reconnect reconciliation when only sale capability refresh resolves stale data", async () => {
    vi.useFakeTimers();
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 1 }))
      .mockRejectedValueOnce(new Error("sale capability unavailable"))
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 2 }));
    startMachineRuntime(pinia);
    await vi.advanceTimersByTimeAsync(0);

    const firstSubscription = subscribeEventsMock.mock.calls[0];
    if (!firstSubscription) {
      throw new Error("runtime did not create an event subscription");
    }
    const [handlers] = firstSubscription;
    handlers.onReconnect?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(2);
    expect(getCurrentTransactionMock).toHaveBeenCalledOnce();
    expect(getHealthMock).toHaveBeenCalledOnce();
    expect(getReadyMock).toHaveBeenCalledOnce();
    expect(getSaleViewMock).toHaveBeenCalledOnce();
    expect(getSyncStatusMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(250);

    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(3);
    expect(useSaleCapabilityStore().orderingKey).toBe("machine-test-daemon:2");
  });

  it("retries reconnect reconciliation when only current transaction refresh resolves null", async () => {
    vi.useFakeTimers();
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 1 }))
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 2 }))
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 3 }));
    getCurrentTransactionMock
      .mockRejectedValueOnce(new Error("current transaction unavailable"))
      .mockResolvedValueOnce(noCurrentTransaction());
    startMachineRuntime(pinia);
    await vi.advanceTimersByTimeAsync(0);

    const firstSubscription = subscribeEventsMock.mock.calls[0];
    if (!firstSubscription) {
      throw new Error("runtime did not create an event subscription");
    }
    const [handlers] = firstSubscription;
    handlers.onReconnect?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(getCurrentTransactionMock).toHaveBeenCalledOnce();
    expect(getHealthMock).toHaveBeenCalledOnce();
    expect(getReadyMock).toHaveBeenCalledOnce();
    expect(getSaleViewMock).toHaveBeenCalledOnce();
    expect(getSyncStatusMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(250);

    expect(getCurrentTransactionMock).toHaveBeenCalledTimes(2);
    expect(useSaleCapabilityStore().orderingKey).toBe("machine-test-daemon:3");
  });

  it("bounds retries when sale capability refresh keeps resolving stale data", async () => {
    vi.useFakeTimers();
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(saleCapabilitySnapshot({ revision: 1 }))
      .mockRejectedValue(new Error("sale capability unavailable"));
    startMachineRuntime(pinia);
    await vi.advanceTimersByTimeAsync(0);

    const firstSubscription = subscribeEventsMock.mock.calls[0];
    if (!firstSubscription) {
      throw new Error("runtime did not create an event subscription");
    }
    const [handlers] = firstSubscription;
    handlers.onReconnect?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(initializeMock).toHaveBeenCalledTimes(3);
    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(4);
  });
});
