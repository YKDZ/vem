import type {
  AudioCueCategory,
  CustomerAudioCueRequest,
} from "@/stores/audio-cues";

import {
  CUSTOMER_EXPERIENCE_EVENT_PRIORITIES,
  describeCustomerExperienceEvent,
  type CustomerExperienceEvent,
} from "@/customer-events/events";
import { useAudioCueStore } from "@/stores/audio-cues";
import { useMachineStore } from "@/stores/machine";

export type CustomerAudioCueEvent = CustomerExperienceEvent;

export type BrowserAudioElement = {
  readonly src: string;
  currentTime: number;
  volume: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(event: "ended", listener: () => void): void;
  addEventListener(event: string, listener: () => void): void;
};

type BrowserAudioFactory = (src: string) => BrowserAudioElement;

type MachineAudioCuePlaybackAdapterOptions = {
  audioFactory?: BrowserAudioFactory;
  autoStart?: boolean;
};

type ActiveAudio = {
  requestId: string;
  audio: BrowserAudioElement;
};

type SharedPlaybackState = {
  pendingSources: Map<string, string>;
  activeAudio: ActiveAudio | null;
};

type CueDescriptor = {
  category: AudioCueCategory;
  cueKey: string;
  orderKey: string | null;
  requestedAt?: string;
  nowMs: number;
  minimumIntervalMs?: number;
  priority: number;
  staleAfterMs: number | null;
  source: string;
};

const PRESENCE_STALE_AFTER_MS = 2_000;

const PLACEHOLDER_TONE_SOURCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

const CUE_SOURCES: Record<CustomerExperienceEvent["type"], string> = {
  "presence.detected": `${PLACEHOLDER_TONE_SOURCE}#presence-detected`,
  "presence.welcome.day": `${PLACEHOLDER_TONE_SOURCE}#presence-welcome-day`,
  "presence.welcome.night": `${PLACEHOLDER_TONE_SOURCE}#presence-welcome-night`,
  "presence.easter_egg": `${PLACEHOLDER_TONE_SOURCE}#presence-easter-egg`,
  "interaction.awakened": `${PLACEHOLDER_TONE_SOURCE}#interaction-awakened`,
  "privacy.crowd_detected": `${PLACEHOLDER_TONE_SOURCE}#privacy-crowd-detected`,
  "idle.assistance_prompt": `${PLACEHOLDER_TONE_SOURCE}#idle-assistance-prompt`,
  "idle.sleep": `${PLACEHOLDER_TONE_SOURCE}#idle-sleep`,
  "product.selected": `${PLACEHOLDER_TONE_SOURCE}#product-selected`,
  "payment.prompt": `${PLACEHOLDER_TONE_SOURCE}#payment-prompt`,
  "payment.succeeded": `${PLACEHOLDER_TONE_SOURCE}#payment-succeeded`,
  "dispensing.started": `${PLACEHOLDER_TONE_SOURCE}#dispensing-started`,
  "dispense.succeeded": `${PLACEHOLDER_TONE_SOURCE}#dispense-succeeded`,
  "dispense.failed": `${PLACEHOLDER_TONE_SOURCE}#dispense-failed`,
  "pickup.completed": `${PLACEHOLDER_TONE_SOURCE}#pickup-completed`,
  "refund.pending": `${PLACEHOLDER_TONE_SOURCE}#refund-pending`,
  "refund.completed": `${PLACEHOLDER_TONE_SOURCE}#refund-completed`,
  "manual_handling.required": `${PLACEHOLDER_TONE_SOURCE}#manual-handling-required`,
  "system.hardware_fault": `${PLACEHOLDER_TONE_SOURCE}#system-hardware-fault`,
};

const CUE_SOURCE_BY_KEY: Readonly<Record<string, string | undefined>> =
  CUE_SOURCES;

const CUE_PRIORITY_BY_KEY: Readonly<Record<string, number | undefined>> =
  CUSTOMER_EXPERIENCE_EVENT_PRIORITIES;

const sharedPlaybackState: SharedPlaybackState = {
  pendingSources: new Map<string, string>(),
  activeAudio: null,
};

export function createMachineAudioCuePlaybackAdapter(
  options: MachineAudioCuePlaybackAdapterOptions = {},
): {
  requestCustomerExperienceEvent(
    event: CustomerExperienceEvent,
  ): Promise<boolean>;
  requestCustomerAudioCue(event: CustomerAudioCueEvent): Promise<boolean>;
  startPendingCue(): Promise<boolean>;
  clearPendingCue(message?: string): boolean;
  pendingSourceCount(): number;
} {
  const audioFactory = options.audioFactory ?? defaultBrowserAudioFactory;
  const autoStart = options.autoStart ?? true;

  async function requestCustomerExperienceEvent(
    event: CustomerExperienceEvent,
  ): Promise<boolean> {
    const store = useAudioCueStore();
    const descriptor = descriptorFromEvent(event);
    const currentRequest = store.playback.request;
    if (!currentRequest) {
      sharedPlaybackState.pendingSources.clear();
    }
    let droppedCurrentRequest = false;

    if (
      descriptor.orderKey &&
      store.hasOrderCuePlayed(descriptor.orderKey, descriptor.cueKey)
    ) {
      store.recordSuppressedCue({
        category: descriptor.category,
        cueKey: descriptor.cueKey,
        orderKey: descriptor.orderKey,
        message: "duplicate transaction cue",
        recordedAt: descriptor.requestedAt,
      });
      return false;
    }

    if (currentRequest) {
      const currentPriority = priorityFor(currentRequest.cueKey);
      if (isStaleLowPriorityCue(currentRequest, descriptor.nowMs)) {
        sharedPlaybackState.pendingSources.delete(currentRequest.requestId);
        stopActiveAudio(currentRequest.requestId);
        store.recordPlaybackOutcome({
          requestId: currentRequest.requestId,
          outcome: "skipped",
          message: "stale",
          recordedAt: descriptor.requestedAt,
        });
        droppedCurrentRequest = true;
      } else if (descriptor.priority <= currentPriority) {
        store.recordSuppressedCue({
          category: descriptor.category,
          cueKey: descriptor.cueKey,
          orderKey: descriptor.orderKey,
          message: `lower priority than ${currentRequest.cueKey}`,
          recordedAt: descriptor.requestedAt,
        });
        return false;
      } else {
        sharedPlaybackState.pendingSources.delete(currentRequest.requestId);
        stopActiveAudio(currentRequest.requestId);
        store.recordPlaybackOutcome({
          requestId: currentRequest.requestId,
          outcome: "skipped",
          message: `replaced by ${descriptor.cueKey}`,
          recordedAt: descriptor.requestedAt,
        });
      }
    }

    const request = store.requestCue({
      category: descriptor.category,
      cueKey: descriptor.cueKey,
      orderKey: descriptor.orderKey,
      requestedAt: descriptor.requestedAt,
      nowMs: descriptor.nowMs,
      minimumIntervalMs:
        currentRequest && !droppedCurrentRequest
          ? undefined
          : descriptor.minimumIntervalMs,
    });
    if (!request) return false;
    sharedPlaybackState.pendingSources.set(
      request.requestId,
      descriptor.source,
    );

    if (!autoStart) return true;
    return startPlayback(request, descriptor.source);
  }

  async function requestCustomerAudioCue(
    event: CustomerAudioCueEvent,
  ): Promise<boolean> {
    return requestCustomerExperienceEvent(event);
  }

  async function startPendingCue(): Promise<boolean> {
    const store = useAudioCueStore();
    const request = store.playback.request;
    if (!request || store.playback.status !== "pending") return false;
    return startPlayback(
      request,
      sharedPlaybackState.pendingSources.get(request.requestId) ??
        sourceForRequest(request),
    );
  }

  function clearPendingCue(message = "cleared"): boolean {
    const store = useAudioCueStore();
    const request = store.playback.request;
    if (!request || store.playback.status !== "pending") return false;
    sharedPlaybackState.pendingSources.delete(request.requestId);
    store.recordPlaybackOutcome({
      requestId: request.requestId,
      outcome: "skipped",
      message,
    });
    return true;
  }

  async function startPlayback(
    request: CustomerAudioCueRequest,
    source: string,
  ): Promise<boolean> {
    const store = useAudioCueStore();
    if (!store.markCuePlaying(request.requestId)) return false;
    sharedPlaybackState.pendingSources.delete(request.requestId);
    stopActiveAudio();

    const audio = audioFactory(source);
    sharedPlaybackState.activeAudio = {
      requestId: request.requestId,
      audio,
    };
    audio.addEventListener("ended", () => {
      if (sharedPlaybackState.activeAudio?.requestId === request.requestId) {
        sharedPlaybackState.activeAudio = null;
      }
      store.recordPlaybackOutcome({
        requestId: request.requestId,
        outcome: "completed",
      });
    });

    try {
      audio.volume = normalizeMachineAudioVolume(
        useMachineStore().config.machineAudioVolume,
      );
      await audio.play();
      if (request.orderKey) {
        store.rememberOrderCuePlayed(request.orderKey, request.cueKey);
      }
      store.recordPlaybackOutcome({
        requestId: request.requestId,
        outcome: "played",
        finishPlayback: false,
      });
      return true;
    } catch (error) {
      if (sharedPlaybackState.activeAudio?.requestId === request.requestId) {
        sharedPlaybackState.activeAudio = null;
      }
      store.recordPlaybackOutcome({
        requestId: request.requestId,
        outcome: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return {
    requestCustomerExperienceEvent,
    requestCustomerAudioCue,
    startPendingCue,
    clearPendingCue,
    pendingSourceCount: () => sharedPlaybackState.pendingSources.size,
  };

  function stopActiveAudio(requestId?: string): void {
    if (
      requestId !== undefined &&
      sharedPlaybackState.activeAudio?.requestId !== requestId
    ) {
      return;
    }
    if (!sharedPlaybackState.activeAudio) return;
    const audio = sharedPlaybackState.activeAudio.audio;
    sharedPlaybackState.activeAudio = null;
    audio.pause();
    audio.currentTime = 0;
  }
}

function descriptorFromEvent(event: CustomerExperienceEvent): CueDescriptor {
  const descriptor = describeCustomerExperienceEvent(event);
  return {
    category: descriptor.category,
    cueKey: descriptor.eventKey,
    orderKey: descriptor.orderKey,
    requestedAt: descriptor.requestedAt,
    nowMs: descriptor.nowMs,
    minimumIntervalMs: descriptor.minimumIntervalMs,
    priority: descriptor.priority,
    staleAfterMs: descriptor.staleAfterMs,
    source: CUE_SOURCES[descriptor.eventKey],
  };
}

function priorityFor(cueKey: string): number {
  return CUE_PRIORITY_BY_KEY[cueKey] ?? 0;
}

function isStaleLowPriorityCue(
  request: CustomerAudioCueRequest,
  nowMs: number,
): boolean {
  if (request.category !== "presence") return false;
  return nowMs - request.requestedAtMs > PRESENCE_STALE_AFTER_MS;
}

function sourceForRequest(request: CustomerAudioCueRequest): string {
  return CUE_SOURCE_BY_KEY[request.cueKey] ?? CUE_SOURCES["presence.detected"];
}

function defaultBrowserAudioFactory(src: string): BrowserAudioElement {
  return new Audio(src);
}

function normalizeMachineAudioVolume(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return 0.7;
  return Math.min(1, Math.max(0, numericValue));
}
