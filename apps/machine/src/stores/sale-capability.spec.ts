import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SaleStartCapabilitySnapshot } from "@/daemon/schemas";

const { getSaleStartCapabilityMock, subscribeEventsMock } = vi.hoisted(() => ({
  getSaleStartCapabilityMock: vi.fn(),
  subscribeEventsMock: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleStartCapability: getSaleStartCapabilityMock,
    subscribeEvents: subscribeEventsMock,
  },
}));

import { useSaleCapabilityStore } from "./sale-capability";

function capability(
  generation: string,
  revision: number,
  canStartSale = true,
): SaleStartCapabilitySnapshot {
  return {
    generation,
    revision,
    observedAt: `2026-07-17T00:00:0${revision}Z`,
    canStartSale,
    blockers: canStartSale
      ? []
      : [
          {
            code: "PLATFORM_UNREACHABLE",
            component: "platform",
            message: "platform unavailable",
          },
        ],
    degradations: [],
    paymentOptions: {
      ready: true,
      defaultOptionKey: "qr_code:alipay",
      defaultProviderCode: "alipay",
      options: [
        {
          optionKey: "qr_code:alipay",
          providerCode: "alipay",
          method: "qr_code",
          displayName: "支付宝",
          description: "扫码支付",
          icon: "alipay",
          recommended: true,
          ready: true,
          disabledReason: null,
        },
      ],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSaleCapabilityStore", () => {
  it("accepts only increasing revisions within one daemon generation", () => {
    const store = useSaleCapabilityStore();

    expect(store.acceptSnapshot(capability("daemon-a", 2, true))).toBe(true);
    expect(store.acceptSnapshot(capability("daemon-a", 1, false))).toBe(false);
    expect(store.acceptSnapshot(capability("daemon-a", 2, false))).toBe(false);

    expect(store.accepted).toEqual(capability("daemon-a", 2, true));
    expect(store.lastRejectedObservation).toBe("daemon-a:2");
  });

  it("projects only payment options supported by the Machine checkout UI", () => {
    const store = useSaleCapabilityStore();
    const snapshot = capability("daemon-a", 1, true);
    snapshot.paymentOptions.options.push({
      optionKey: "future_wallet:provider",
      providerCode: "future_provider",
      method: "future_wallet",
      displayName: "未来钱包",
      description: "尚未支持",
      icon: "future_wallet",
      recommended: false,
      ready: true,
      disabledReason: null,
    });

    store.acceptSnapshot(snapshot);

    expect(store.paymentOptions.map((option) => option.optionKey)).toEqual([
      "qr_code:alipay",
    ]);
  });

  it("retires the previous generation and rejects a late pre-restart observation", () => {
    const store = useSaleCapabilityStore();

    store.acceptSnapshot(capability("daemon-before-restart", 9, false));
    expect(
      store.acceptSnapshot(capability("daemon-after-restart", 1, true)),
    ).toBe(true);
    expect(
      store.acceptSnapshot(capability("daemon-before-restart", 10, false)),
    ).toBe(false);

    expect(store.orderingKey).toBe("daemon-after-restart:1");
    expect(store.canStartSale).toBe(true);
  });

  it("rejects an older concurrent response that completes after a newer one", async () => {
    const slowOlder = deferred<SaleStartCapabilitySnapshot>();
    const fastNewer = deferred<SaleStartCapabilitySnapshot>();
    getSaleStartCapabilityMock
      .mockReturnValueOnce(slowOlder.promise)
      .mockReturnValueOnce(fastNewer.promise);
    const store = useSaleCapabilityStore();

    const olderRefresh = store.refresh();
    const newerRefresh = store.refresh();
    fastNewer.resolve(capability("daemon-a", 4, true));
    await newerRefresh;
    slowOlder.resolve(capability("daemon-a", 3, false));
    await olderRefresh;

    expect(store.orderingKey).toBe("daemon-a:4");
    expect(store.canStartSale).toBe(true);
    expect(store.updating).toBe(false);
  });

  it("rejects a pre-restart first response that resolves after the new generation", async () => {
    const beforeRestart = deferred<SaleStartCapabilitySnapshot>();
    const afterRestart = deferred<SaleStartCapabilitySnapshot>();
    getSaleStartCapabilityMock
      .mockReturnValueOnce(beforeRestart.promise)
      .mockReturnValueOnce(afterRestart.promise);
    const store = useSaleCapabilityStore();

    const oldGenerationRefresh = store.refresh();
    const newGenerationRefresh = store.refresh();
    afterRestart.resolve(capability("daemon-after-restart", 1, true));
    await newGenerationRefresh;
    beforeRestart.resolve(capability("daemon-before-restart", 99, false));
    await oldGenerationRefresh;

    expect(store.orderingKey).toBe("daemon-after-restart:1");
    expect(store.canStartSale).toBe(true);
    expect(store.lastRejectedObservation).toBe("daemon-before-restart:99");
  });

  it("retains the accepted capability and marks diagnostics stale after refresh failure", async () => {
    const store = useSaleCapabilityStore();
    store.acceptSnapshot(capability("daemon-a", 4, true));
    getSaleStartCapabilityMock.mockRejectedValueOnce(
      new Error("capability refresh unavailable"),
    );

    await expect(store.refresh()).resolves.toEqual(
      capability("daemon-a", 4, true),
    );

    expect(store.canStartSale).toBe(true);
    expect(store.accepted).toEqual(capability("daemon-a", 4, true));
    expect(store.stale).toBe(true);
    expect(store.diagnostic).toBe("capability refresh unavailable");
  });

  it("does not let an older failed refresh overwrite a newer successful outcome", async () => {
    const slowFailure = deferred<SaleStartCapabilitySnapshot>();
    getSaleStartCapabilityMock
      .mockReturnValueOnce(slowFailure.promise)
      .mockResolvedValueOnce(capability("daemon-a", 5, true));
    const store = useSaleCapabilityStore();

    const olderRefresh = store.refresh();
    await store.refresh();
    slowFailure.reject(new Error("superseded request failed"));
    await olderRefresh;

    expect(store.orderingKey).toBe("daemon-a:5");
    expect(store.stale).toBe(false);
    expect(store.diagnostic).toBeNull();
  });

  it("invalidates only for an observation newer than the accepted tuple", async () => {
    const store = useSaleCapabilityStore();
    store.acceptSnapshot(capability("daemon-a", 4, true));
    getSaleStartCapabilityMock.mockResolvedValue(
      capability("daemon-a", 5, false),
    );

    store.invalidate({
      type: "sale_start_capability_changed",
      eventId: "event-4",
      updatedAt: "2026-07-17T00:00:04Z",
      generation: "daemon-a",
      revision: 4,
    });
    expect(getSaleStartCapabilityMock).not.toHaveBeenCalled();

    store.invalidate({
      type: "sale_start_capability_changed",
      eventId: "event-5",
      updatedAt: "2026-07-17T00:00:05Z",
      generation: "daemon-a",
      revision: 5,
    });
    await vi.waitFor(() => {
      expect(store.orderingKey).toBe("daemon-a:5");
    });
    expect(getSaleStartCapabilityMock).toHaveBeenCalledOnce();
  });

  it("polls as a fallback and stops the runtime coordinator cleanly", async () => {
    vi.useFakeTimers();
    getSaleStartCapabilityMock
      .mockResolvedValueOnce(capability("daemon-a", 1, true))
      .mockResolvedValueOnce(capability("daemon-a", 2, false));
    const store = useSaleCapabilityStore();

    store.startRuntime();
    vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.orderingKey).toBe("daemon-a:1");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.orderingKey).toBe("daemon-a:2");

    store.stopRuntime();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getSaleStartCapabilityMock).toHaveBeenCalledTimes(2);
  });
});
