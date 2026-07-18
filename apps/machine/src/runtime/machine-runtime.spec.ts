import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

type RuntimeEventHandlers = {
  onEvent: (event: unknown) => void;
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
    subscribeEvents: subscribeEventsMock,
  },
}));

vi.mock("./customer-journey-audio-runtime", () => ({
  createCustomerJourneyAudioRuntime: createJourneyAudioRuntimeMock,
}));

import { useSaleCapabilityStore } from "@/stores/sale-capability";

import { startMachineRuntime, stopMachineRuntime } from "./machine-runtime";

let pinia: ReturnType<typeof createPinia>;

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
  disposeJourneyAudioMock.mockResolvedValue(undefined);
  createJourneyAudioRuntimeMock.mockReturnValue({
    requestTestPlayback: vi.fn(),
    trace: vi.fn(() => []),
    dispose: disposeJourneyAudioMock,
  });
});

afterEach(async () => {
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
    expect(subscribeEventsMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(2);

    await stopMachineRuntime(pinia);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(2);
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
