// @vitest-environment jsdom
import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TransactionSnapshot } from "@/daemon/schemas";

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
import { useMachineStore } from "@/stores/machine";

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
    runtime = null;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await runtime?.dispose();
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
});
