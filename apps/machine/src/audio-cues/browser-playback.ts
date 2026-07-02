import type {
  AudioCueCategory,
  CustomerAudioCueRequest,
} from "@/stores/audio-cues";

import { useAudioCueStore } from "@/stores/audio-cues";

export type CustomerAudioCueEvent =
  | {
      type: "presence.detected";
      requestedAt?: string;
      nowMs?: number;
    }
  | {
      type:
        | "payment.succeeded"
        | "dispensing.started"
        | "dispense.succeeded"
        | "dispense.failed"
        | "refund.pending"
        | "refund.completed"
        | "manual_handling.required";
      orderKey: string;
      requestedAt?: string;
      nowMs?: number;
    };

export type BrowserAudioElement = {
  readonly src: string;
  currentTime: number;
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

const PRESENCE_MINIMUM_INTERVAL_MS = 10_000;
const PRESENCE_STALE_AFTER_MS = 2_000;

const CUE_PRIORITIES: Record<string, number> = {
  "presence.detected": 10,
  "payment.succeeded": 40,
  "dispensing.started": 40,
  "dispense.succeeded": 40,
  "refund.pending": 50,
  "dispense.failed": 90,
  "manual_handling.required": 100,
  "refund.completed": 50,
};

const PLACEHOLDER_TONE_SOURCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

const CUE_SOURCES: Record<string, string> = {
  "presence.detected": `${PLACEHOLDER_TONE_SOURCE}#presence-detected`,
  "payment.succeeded": `${PLACEHOLDER_TONE_SOURCE}#payment-succeeded`,
  "dispensing.started": `${PLACEHOLDER_TONE_SOURCE}#dispensing-started`,
  "dispense.succeeded": `${PLACEHOLDER_TONE_SOURCE}#dispense-succeeded`,
  "dispense.failed": `${PLACEHOLDER_TONE_SOURCE}#dispense-failed`,
  "refund.pending": `${PLACEHOLDER_TONE_SOURCE}#refund-pending`,
  "refund.completed": `${PLACEHOLDER_TONE_SOURCE}#refund-completed`,
  "manual_handling.required": `${PLACEHOLDER_TONE_SOURCE}#manual-handling-required`,
};

const sharedPlaybackState: SharedPlaybackState = {
  pendingSources: new Map<string, string>(),
  activeAudio: null,
};

export function createMachineAudioCuePlaybackAdapter(
  options: MachineAudioCuePlaybackAdapterOptions = {},
): {
  requestCustomerAudioCue(event: CustomerAudioCueEvent): Promise<boolean>;
  startPendingCue(): Promise<boolean>;
  clearPendingCue(message?: string): boolean;
  pendingSourceCount(): number;
} {
  const audioFactory = options.audioFactory ?? defaultBrowserAudioFactory;
  const autoStart = options.autoStart ?? true;

  async function requestCustomerAudioCue(
    event: CustomerAudioCueEvent,
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

function descriptorFromEvent(event: CustomerAudioCueEvent): CueDescriptor {
  const nowMs = event.nowMs ?? Date.now();
  if (event.type === "presence.detected") {
    return {
      category: "presence",
      cueKey: event.type,
      orderKey: null,
      requestedAt: event.requestedAt,
      nowMs,
      minimumIntervalMs: PRESENCE_MINIMUM_INTERVAL_MS,
      priority: CUE_PRIORITIES[event.type],
      staleAfterMs: PRESENCE_STALE_AFTER_MS,
      source: CUE_SOURCES[event.type],
    };
  }

  return {
    category: "transaction",
    cueKey: event.type,
    orderKey: event.orderKey,
    requestedAt: event.requestedAt,
    nowMs,
    minimumIntervalMs: undefined,
    priority: CUE_PRIORITIES[event.type],
    staleAfterMs: null,
    source: CUE_SOURCES[event.type],
  };
}

function priorityFor(cueKey: string): number {
  return CUE_PRIORITIES[cueKey] ?? 0;
}

function isStaleLowPriorityCue(
  request: CustomerAudioCueRequest,
  nowMs: number,
): boolean {
  if (request.category !== "presence") return false;
  return nowMs - request.requestedAtMs > PRESENCE_STALE_AFTER_MS;
}

function sourceForRequest(request: CustomerAudioCueRequest): string {
  return CUE_SOURCES[request.cueKey] ?? CUE_SOURCES["presence.detected"];
}

function defaultBrowserAudioFactory(src: string): BrowserAudioElement {
  return new Audio(src);
}
