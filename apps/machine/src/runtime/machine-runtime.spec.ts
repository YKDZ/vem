import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saleCapabilitySnapshot } from "@/test-support/sale-capability";

type RuntimeEventHandlers = {
  onEvent: (event: unknown) => void;
  onStale: () => void;
  onReconnect?: () => void;
};

const { initializeMock, getSaleStartCapabilityMock, subscribeEventsMock } = vi.hoisted(() => {
  return {
    initializeMock: vi.fn(),
    getSaleStartCapabilityMock: vi.fn(),
    subscribeEventsMock: vi.fn<
      (handlers: RuntimeEventHandlers) => { close(): void }
    >(() => ({ close: vi.fn() })),
  };
});

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    initialize: initializeMock,
    getSaleStartCapability: getSaleStartCapabilityMock,
    subscribeEvents: subscribeEventsMock,
  },
}));

import { useSaleCapabilityStore } from "@/stores/sale-capability";

import { startMachineRuntime, stopMachineRuntime } from "./machine-runtime";

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  initializeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  stopMachineRuntime(pinia);
  vi.useRealTimers();
});

describe("Machine runtime coordinator", () => {
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

    stopMachineRuntime(pinia);
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
    expect(useSaleCapabilityStore().orderingKey).toBe(
      "machine-test-daemon:2",
    );

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
    expect(useSaleCapabilityStore().orderingKey).toBe(
      "machine-test-daemon:2",
    );
  });
});
