import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMachineAudioCuePlaybackAdapter,
  type BrowserAudioElement,
  type CustomerAudioCueEvent,
} from "@/audio-cues/browser-playback";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useCheckoutStore } from "@/stores/checkout";

import {
  requestDispensingStartedCue,
  requestPaymentSuccessCue,
  requestTerminalResultCue,
} from "./useTransactionFeedbackCues";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => {
      values.clear();
    }),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-TXN-CUE-001",
    productSummary: null,
    paymentNo: "PAY-TXN-CUE-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "dispensing",
    totalAmountCents: 4900,
    vending: {
      commandNo: "CMD-TXN-CUE-001",
      status: "sent",
      lastError: null,
    },
    nextAction: "dispensing",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-29T09:00:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-29T09:00:02.000Z",
    ...overrides,
  };
}

function createRequester() {
  const events: CustomerAudioCueEvent[] = [];
  return {
    events,
    requester: {
      requestCustomerAudioCue: vi.fn(async (event: CustomerAudioCueEvent) => {
        events.push(event);
        return true;
      }),
    },
  };
}

const TRANSACTION_UPDATED_AT_MS = new Date(
  "2026-06-29T09:00:02.000Z",
).getTime();

class MockAudio implements BrowserAudioElement {
  readonly src: string;
  currentTime = 0;
  readonly play = vi.fn<() => Promise<void>>();
  readonly pause = vi.fn<() => void>();
  private listeners = new Map<string, Array<() => void>>();

  constructor(src: string, playResult: Promise<void> = Promise.resolve()) {
    this.src = src;
    this.play.mockReturnValue(playResult);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

function enableAllAudioCues(): void {
  useAudioCueStore().applySettings({
    enabled: true,
    categories: { presence: true, transaction: true },
  });
}

describe("transaction feedback cues", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("requests payment success feedback when a paid transaction enters dispensing", async () => {
    const { events, requester } = createRequester();

    await requestPaymentSuccessCue(transaction(), requester);

    expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
    expect(events).toEqual([
      {
        type: "payment.succeeded",
        orderKey: "ORD-TXN-CUE-001",
        requestedAt: "2026-06-29T09:00:02.000Z",
        nowMs: TRANSACTION_UPDATED_AT_MS,
      },
    ]);
  });

  it("records a latest diagnostic when transaction feedback is disabled by category settings", async () => {
    useAudioCueStore().applySettings({
      enabled: true,
      categories: { presence: true, transaction: false },
    });
    const requester = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => new MockAudio("unused"),
    });

    await expect(
      requestPaymentSuccessCue(transaction(), requester),
    ).resolves.toBe(false);

    expect(useAudioCueStore().playback.status).toBe("idle");
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      category: "transaction",
      cueKey: "payment.succeeded",
      orderKey: "ORD-TXN-CUE-001",
      outcome: "skipped",
      message: "transaction audio cue category disabled",
      recordedAt: "2026-06-29T09:00:02.000Z",
    });
  });

  it("requests dispensing-start feedback for the active order", async () => {
    const { events, requester } = createRequester();

    await requestDispensingStartedCue(transaction(), requester);

    expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
    expect(events).toEqual([
      {
        type: "dispensing.started",
        orderKey: "ORD-TXN-CUE-001",
        requestedAt: "2026-06-29T09:00:02.000Z",
        nowMs: TRANSACTION_UPDATED_AT_MS,
      },
    ]);
  });

  it.each([
    ["success", "dispense.succeeded"],
    ["dispense_failed", "dispense.failed"],
    ["refund_pending", "refund.pending"],
    ["refunded", "refund.completed"],
    ["manual_handling", "manual_handling.required"],
    ["result_unknown", "manual_handling.required"],
  ] as const)(
    "requests %s terminal result feedback with distinct cue meaning",
    async (nextAction, cueKey) => {
      const { events, requester } = createRequester();

      await requestTerminalResultCue(
        transaction({
          nextAction,
          orderStatus: nextAction,
          vending:
            nextAction === "success"
              ? {
                  commandNo: "CMD-TXN-CUE-001",
                  status: "succeeded",
                  lastError: null,
                }
              : {
                  commandNo: "CMD-TXN-CUE-001",
                  status: "failed",
                  lastError: "dispense failed",
                },
        }),
        requester,
      );

      expect(requester.requestCustomerAudioCue).toHaveBeenCalledOnce();
      expect(events).toEqual([
        {
          type: cueKey,
          orderKey: "ORD-TXN-CUE-001",
          requestedAt: "2026-06-29T09:00:02.000Z",
          nowMs: TRANSACTION_UPDATED_AT_MS,
        },
      ]);
    },
  );

  it("does not replay a remembered dispense success cue during route recovery", async () => {
    enableAllAudioCues();
    const created: MockAudio[] = [];
    const requester = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });
    const snapshot = transaction({
      nextAction: "success",
      orderStatus: "fulfilled",
      vending: {
        commandNo: "CMD-TXN-CUE-001",
        status: "succeeded",
        lastError: null,
      },
    });

    await expect(requestTerminalResultCue(snapshot, requester)).resolves.toBe(
      true,
    );
    created[0]?.emit("ended");
    await expect(requestTerminalResultCue(snapshot, requester)).resolves.toBe(
      false,
    );

    expect(created).toHaveLength(1);
    expect(
      useAudioCueStore().hasOrderCuePlayed(
        "ORD-TXN-CUE-001",
        "dispense.succeeded",
      ),
    ).toBe(true);
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "dispense.succeeded",
      orderKey: "ORD-TXN-CUE-001",
      outcome: "skipped",
      message: "duplicate transaction cue",
    });
  });

  it("keeps transaction cue memory when a terminal transaction is dismissed and restored", async () => {
    enableAllAudioCues();
    const created: MockAudio[] = [];
    const requester = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });
    const snapshot = transaction({
      nextAction: "refunded",
      paymentStatus: "refunded",
      orderStatus: "refunded",
    });
    const checkoutStore = useCheckoutStore();

    checkoutStore.applyTransaction(snapshot);
    await requestTerminalResultCue(snapshot, requester);
    created[0]?.emit("ended");
    checkoutStore.dismissCurrentTerminalTransaction();
    checkoutStore.reset();

    expect(
      useAudioCueStore().hasOrderCuePlayed(
        "ORD-TXN-CUE-001",
        "refund.completed",
      ),
    ).toBe(true);
    await expect(requestTerminalResultCue(snapshot, requester)).resolves.toBe(
      false,
    );
    expect(created).toHaveLength(1);
  });

  it("does not replay an already played terminal cue after a fresh app runtime restores the transaction", async () => {
    enableAllAudioCues();
    const created: MockAudio[] = [];
    const requester = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });
    const snapshot = transaction({
      nextAction: "success",
      orderStatus: "fulfilled",
      vending: {
        commandNo: "CMD-TXN-CUE-001",
        status: "succeeded",
        lastError: null,
      },
    });

    await expect(requestTerminalResultCue(snapshot, requester)).resolves.toBe(
      true,
    );
    created[0]?.emit("ended");

    setActivePinia(createPinia());
    enableAllAudioCues();
    const restoredRequester = createMachineAudioCuePlaybackAdapter({
      audioFactory: (src) => {
        const audio = new MockAudio(src);
        created.push(audio);
        return audio;
      },
    });

    await expect(
      requestTerminalResultCue(snapshot, restoredRequester),
    ).resolves.toBe(false);

    expect(created).toHaveLength(1);
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "dispense.succeeded",
      orderKey: "ORD-TXN-CUE-001",
      outcome: "skipped",
      message: "duplicate transaction cue",
    });
  });

  it("lets manual-handling transaction feedback outrank a pending presence cue", async () => {
    enableAllAudioCues();
    const requester = createMachineAudioCuePlaybackAdapter({
      audioFactory: () => new MockAudio("unused"),
      autoStart: false,
    });

    await requester.requestCustomerAudioCue({
      type: "presence.detected",
      requestedAt: "2026-06-29T09:00:00.000Z",
      nowMs: new Date("2026-06-29T09:00:00.000Z").getTime(),
    });
    await requestTerminalResultCue(
      transaction({
        nextAction: "manual_handling",
        orderStatus: "manual_handling",
        updatedAt: "2026-06-29T09:00:01.000Z",
      }),
      requester,
    );

    expect(useAudioCueStore().playback.request).toMatchObject({
      category: "transaction",
      cueKey: "manual_handling.required",
      orderKey: "ORD-TXN-CUE-001",
    });
    expect(useAudioCueStore().latestPlaybackDiagnostic).toMatchObject({
      cueKey: "presence.detected",
      outcome: "skipped",
      message: "replaced by manual_handling.required",
    });
  });
});
