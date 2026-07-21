// @vitest-environment jsdom
import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type { TransactionSnapshot } from "@/daemon/schemas";

import { resetCustomerPresenceSessionForTests } from "@/composables/usePresenceInteraction";

const { nativePlaybackDriver, nativePlaybackFactory } = vi.hoisted(() => {
  let activeTerminal:
    | ((outcome: { status: "completed" | "failed" | "stopped" }) => void)
    | null = null;
  const nativePlaybackDriver = {
    name: "native" as const,
    playLocal: vi.fn(
      async (
        _sourceUrl: string,
        options?: {
          requestId: string;
          volume: number;
          onTerminal: (outcome: {
            status: "completed" | "failed" | "stopped";
          }) => void;
        },
      ) => {
        activeTerminal = options?.onTerminal ?? null;
      },
    ),
    stop: vi.fn(() => {
      const terminal = activeTerminal;
      activeTerminal = null;
      terminal?.({ status: "stopped" });
    }),
  };

  return {
    nativePlaybackDriver,
    nativePlaybackFactory: vi.fn(() => nativePlaybackDriver),
  };
});

vi.mock("@/audio-playback/machine-audio-playback", () => ({
  createTauriNativeMachineAudioPlaybackDriver: nativePlaybackFactory,
  createBrowserMachineAudioPlaybackDriver: vi.fn(),
}));

import { useCheckoutStore } from "@/stores/checkout";
import { useCustomerJourneyStore } from "@/stores/customer-journey";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

import { createCustomerJourneyAudioRuntime } from "./customer-journey-audio-runtime";

function effectiveConfiguration(input: {
  volume: number;
  transactionCuesEnabled: boolean;
}): EffectiveMachineRuntimeConfiguration {
  return {
    experience: {
      audio: {
        volume: input.volume,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: input.transactionCuesEnabled,
      },
    },
  } as EffectiveMachineRuntimeConfiguration;
}

function transaction(
  nextAction: "wait_payment" | "payment_failed",
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440100",
    orderNo: "ORD-AUDIO-RUNTIME-001",
    productSummary: null,
    paymentId: "550e8400-e29b-41d4-a716-446655440101",
    paymentNo: "PAY-AUDIO-RUNTIME-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/audio-runtime",
    paymentStatus: nextAction === "wait_payment" ? "pending" : "failed",
    orderStatus:
      nextAction === "wait_payment" ? "pending_payment" : "payment_expired",
    totalAmountCents: 4900,
    vending: null,
    nextAction,
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-07-19T08:15:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt:
      nextAction === "wait_payment"
        ? "2026-07-19T08:00:00.000Z"
        : "2026-07-19T08:00:01.000Z",
  };
}

describe("Customer journey audio runtime", () => {
  let pinia: ReturnType<typeof createPinia>;
  let runtime: ReturnType<typeof createCustomerJourneyAudioRuntime> | null;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    resetCustomerPresenceSessionForTests();
    runtime = null;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await runtime?.dispose();
    resetCustomerPresenceSessionForTests();
  });

  it("plays transaction transitions with effective customer audio settings and rejects later disabled cues", async () => {
    const machineStore = useMachineStore(pinia);
    machineStore.applyEffectiveRuntimeConfiguration(
      effectiveConfiguration({ volume: 0.34, transactionCuesEnabled: true }),
    );
    expect(machineStore.customerAudio).toEqual({
      volume: 0.34,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: true,
    });

    runtime = createCustomerJourneyAudioRuntime(pinia);
    useCheckoutStore(pinia).applyTransaction(transaction("wait_payment"));

    await vi.waitFor(() => {
      expect(nativePlaybackDriver.playLocal).toHaveBeenCalledWith(
        "/audio/voice/payment/prompt.mp3",
        expect.objectContaining({ volume: 0.34 }),
      );
    });

    machineStore.applyEffectiveRuntimeConfiguration(
      effectiveConfiguration({ volume: 0.34, transactionCuesEnabled: false }),
    );
    await vi.waitFor(() => {
      expect(nativePlaybackDriver.stop).toHaveBeenCalledOnce();
    });
    useCheckoutStore(pinia).applyTransaction(transaction("payment_failed"));

    await vi.waitFor(() => {
      expect(runtime?.trace()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "audio_rejected",
            transitionId: "transaction:ORD-AUDIO-RUNTIME-001:payment-failed",
            message: "audio cue preference disabled",
          }),
        ]),
      );
    });
    expect(nativePlaybackDriver.playLocal).toHaveBeenCalledTimes(1);
  });

  it("plays each category introduction at product-list entry only", async () => {
    useMachineStore(pinia).applyEffectiveRuntimeConfiguration(
      effectiveConfiguration({ volume: 0.52, transactionCuesEnabled: true }),
    );
    runtime = createCustomerJourneyAudioRuntime(pinia);
    const journeyStore = useCustomerJourneyStore(pinia);

    journeyStore.enterCategory({ categoryKey: "socks", category: "袜子" });
    await vi.waitFor(() => {
      expect(nativePlaybackDriver.playLocal).toHaveBeenCalledWith(
        "/audio/voice/product/socks.mp3",
        expect.objectContaining({ volume: 0.52 }),
      );
    });

    journeyStore.enterCategory({ categoryKey: "socks", category: "袜子" });
    expect(nativePlaybackDriver.playLocal).toHaveBeenCalledTimes(1);
  });

  it("does not replay welcome when a transient Vision absence recovers", async () => {
    vi.useFakeTimers();
    useMachineStore(pinia).applyEffectiveRuntimeConfiguration(
      effectiveConfiguration({ volume: 0.7, transactionCuesEnabled: true }),
    );
    runtime = createCustomerJourneyAudioRuntime(pinia);
    const visionStore = useVisionStore(pinia);

    visionStore.applyPresenceStatus({
      source: "top",
      eventId: "VISION-PRESENT-001",
      state: "approach",
      reason: "person_present_but_not_close",
      detectedAt: "2026-07-19T08:00:00.000Z",
      personPresent: true,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: true },
    });
    await vi.waitFor(() => {
      expect(nativePlaybackDriver.playLocal).toHaveBeenCalledWith(
        "/audio/voice/interaction/awakened.mp3",
        expect.any(Object),
      );
    });

    visionStore.applyPresenceStatus({
      source: "top",
      eventId: "VISION-TRANSIENT-EMPTY-001",
      state: "empty",
      reason: "no_person",
      detectedAt: "2026-07-19T08:00:01.000Z",
      personPresent: false,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: false },
    });
    await nextTick();
    await vi.advanceTimersByTimeAsync(2_999);
    visionStore.applyPresenceStatus({
      source: "top",
      eventId: "VISION-PRESENT-002",
      state: "approach",
      reason: "person_present_but_not_close",
      detectedAt: "2026-07-19T08:00:04.000Z",
      personPresent: true,
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: { present: true },
    });
    await nextTick();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(nativePlaybackDriver.playLocal).toHaveBeenCalledTimes(1);
    expect(
      runtime
        ?.trace()
        .filter(
          (entry) =>
            entry.type === "journey_transition" &&
            entry.transitionId.endsWith(":welcome"),
        ),
    ).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not project touchscreen inactivity as a Vision departure cue", async () => {
    vi.useFakeTimers();
    useMachineStore(pinia).applyEffectiveRuntimeConfiguration(
      effectiveConfiguration({ volume: 0.7, transactionCuesEnabled: true }),
    );
    runtime = createCustomerJourneyAudioRuntime(pinia);

    window.dispatchEvent(new Event("pointerdown"));
    await nextTick();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(
      runtime
        .trace()
        .filter(
          (entry) =>
            entry.type === "journey_transition" &&
            entry.transitionId.endsWith(":departed"),
        ),
    ).toHaveLength(0);
    expect(nativePlaybackDriver.playLocal).not.toHaveBeenCalledWith(
      expect.stringContaining("/departure/"),
      expect.any(Object),
    );
    vi.useRealTimers();
  });
});
