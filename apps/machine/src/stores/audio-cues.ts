import { defineStore } from "pinia";

import type { AudioCueSettings } from "@/config/machine-config";

export type AudioCueCategory = "presence" | "transaction";
export type AudioCuePlaybackStatus = "idle" | "pending" | "playing";
export type AudioCuePlaybackOutcome =
  | "played"
  | "completed"
  | "failed"
  | "skipped";

export type CustomerAudioCueRequest = {
  requestId: string;
  category: AudioCueCategory;
  cueKey: string;
  orderKey: string | null;
  requestedAt: string;
  requestedAtMs: number;
};

export type AudioCuePlaybackState = {
  status: AudioCuePlaybackStatus;
  request: CustomerAudioCueRequest | null;
};

export type AudioCuePlaybackDiagnostic = {
  requestId: string;
  category: AudioCueCategory;
  cueKey: string;
  orderKey: string | null;
  outcome: AudioCuePlaybackOutcome;
  message: string | null;
  recordedAt: string;
};

type AudioCueRequestInput = {
  category: AudioCueCategory;
  cueKey: string;
  orderKey?: string | null;
  requestedAt?: string;
  nowMs?: number;
  minimumIntervalMs?: number;
};

type AudioCuePlaybackOutcomeInput = {
  requestId: string;
  outcome: AudioCuePlaybackOutcome;
  message?: string | null;
  recordedAt?: string;
  finishPlayback?: boolean;
};

type SuppressedCueDiagnosticInput = {
  category: AudioCueCategory;
  cueKey: string;
  orderKey?: string | null;
  message: string;
  recordedAt?: string;
};

type AudioCueState = {
  settings: AudioCueSettings;
  playback: AudioCuePlaybackState;
  latestPlaybackDiagnostic: AudioCuePlaybackDiagnostic | null;
  orderCueMemory: Record<string, Record<string, true>>;
  lastRequestedAtMsByCategory: Record<AudioCueCategory, number | null>;
  nextRequestSequence: number;
};

const DEFAULT_AUDIO_CUE_SETTINGS: AudioCueSettings = {
  enabled: false,
  categories: {
    presence: false,
    transaction: false,
  },
};

const ORDER_CUE_MEMORY_STORAGE_KEY = "vem.machine.transactionAudioCueMemory.v1";
const ORDER_CUE_MEMORY_LIMIT = 100;

export const useAudioCueStore = defineStore("audio-cues", {
  state: (): AudioCueState => ({
    settings: cloneAudioCueSettings(DEFAULT_AUDIO_CUE_SETTINGS),
    playback: {
      status: "idle",
      request: null,
    },
    latestPlaybackDiagnostic: null,
    orderCueMemory: readOrderCueMemory(),
    lastRequestedAtMsByCategory: {
      presence: null,
      transaction: null,
    },
    nextRequestSequence: 1,
  }),
  actions: {
    applySettings(settings: AudioCueSettings): void {
      this.settings = cloneAudioCueSettings(settings);
    },
    requestCue(input: AudioCueRequestInput): CustomerAudioCueRequest | null {
      if (!this.settings.enabled) {
        this.recordSuppressedCue({
          category: input.category,
          cueKey: input.cueKey,
          orderKey: input.orderKey ?? null,
          message: "global audio cues disabled",
          recordedAt: input.requestedAt,
        });
        return null;
      }
      if (!this.settings.categories[input.category]) {
        this.recordSuppressedCue({
          category: input.category,
          cueKey: input.cueKey,
          orderKey: input.orderKey ?? null,
          message: `${input.category} audio cue category disabled`,
          recordedAt: input.requestedAt,
        });
        return null;
      }
      if (this.playback.status !== "idle") {
        this.recordSuppressedCue({
          category: input.category,
          cueKey: input.cueKey,
          orderKey: input.orderKey ?? null,
          message: `playback already ${this.playback.status}`,
          recordedAt: input.requestedAt,
        });
        return null;
      }
      const nowMs = input.nowMs ?? Date.now();
      const lastRequestedAtMs =
        this.lastRequestedAtMsByCategory[input.category];
      if (
        lastRequestedAtMs !== null &&
        input.minimumIntervalMs !== undefined &&
        nowMs - lastRequestedAtMs < input.minimumIntervalMs
      ) {
        this.recordSuppressedCue({
          category: input.category,
          cueKey: input.cueKey,
          orderKey: input.orderKey ?? null,
          message: `${input.category} audio cue cooldown`,
          recordedAt: input.requestedAt,
        });
        return null;
      }
      const requestSequence = this.nextRequestSequence;
      this.nextRequestSequence += 1;
      const request: CustomerAudioCueRequest = {
        requestId: `audio-cue-${requestSequence}`,
        category: input.category,
        cueKey: input.cueKey,
        orderKey: input.orderKey ?? null,
        requestedAt: input.requestedAt ?? new Date().toISOString(),
        requestedAtMs: nowMs,
      };
      this.lastRequestedAtMsByCategory[input.category] = nowMs;
      this.playback = {
        status: "pending",
        request,
      };
      return request;
    },
    markCuePlaying(requestId: string): boolean {
      if (
        this.playback.status !== "pending" ||
        this.playback.request?.requestId !== requestId
      ) {
        return false;
      }
      this.playback = {
        status: "playing",
        request: this.playback.request,
      };
      return true;
    },
    hasOrderCuePlayed(orderKey: string, cueKey: string): boolean {
      return this.orderCueMemory[orderKey]?.[cueKey] ?? false;
    },
    rememberOrderCuePlayed(orderKey: string, cueKey: string): void {
      this.orderCueMemory = pruneOrderCueMemory({
        ...this.orderCueMemory,
        [orderKey]: {
          ...this.orderCueMemory[orderKey],
          [cueKey]: true,
        },
      });
      writeOrderCueMemory(this.orderCueMemory);
    },
    clearOrderCueMemory(orderKey: string): void {
      const { [orderKey]: _removed, ...remaining } = this.orderCueMemory;
      this.orderCueMemory = {
        ...remaining,
      };
      writeOrderCueMemory(this.orderCueMemory);
    },
    recordPlaybackOutcome(input: AudioCuePlaybackOutcomeInput): void {
      const request =
        this.playback.request?.requestId === input.requestId
          ? this.playback.request
          : null;
      if (!request) return;
      this.latestPlaybackDiagnostic = {
        requestId: input.requestId,
        category: request.category,
        cueKey: request.cueKey,
        orderKey: request.orderKey,
        outcome: input.outcome,
        message: input.message ?? null,
        recordedAt: input.recordedAt ?? new Date().toISOString(),
      };
      if (input.finishPlayback ?? true) {
        this.playback = {
          status: "idle",
          request: null,
        };
      }
    },
    recordSuppressedCue(input: SuppressedCueDiagnosticInput): void {
      this.latestPlaybackDiagnostic = {
        requestId: `suppressed-audio-cue-${this.nextRequestSequence}`,
        category: input.category,
        cueKey: input.cueKey,
        orderKey: input.orderKey ?? null,
        outcome: "skipped",
        message: input.message,
        recordedAt: input.recordedAt ?? new Date().toISOString(),
      };
    },
  },
});

function cloneAudioCueSettings(settings: AudioCueSettings): AudioCueSettings {
  return {
    enabled: settings.enabled,
    categories: {
      presence: settings.categories.presence,
      transaction: settings.categories.transaction,
    },
  };
}

function runtimeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readOrderCueMemory(): Record<string, Record<string, true>> {
  const storage = runtimeStorage();
  if (!storage) return {};
  try {
    const parsed = JSON.parse(
      storage.getItem(ORDER_CUE_MEMORY_STORAGE_KEY) ?? "{}",
    );
    return pruneOrderCueMemory(parseOrderCueMemory(parsed));
  } catch {
    storage.removeItem(ORDER_CUE_MEMORY_STORAGE_KEY);
    return {};
  }
}

function writeOrderCueMemory(
  memory: Record<string, Record<string, true>>,
): void {
  const storage = runtimeStorage();
  if (!storage) return;
  try {
    storage.setItem(ORDER_CUE_MEMORY_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Duplicate suppression is customer-experience state only; storage failures
    // must not affect checkout, readiness, or transaction recovery.
  }
}

function parseOrderCueMemory(
  value: unknown,
): Record<string, Record<string, true>> {
  if (!isPlainRecord(value)) {
    return {};
  }
  const memory: Record<string, Record<string, true>> = {};
  for (const [orderKey, cueMap] of Object.entries(value)) {
    if (!isPlainRecord(cueMap)) {
      continue;
    }
    const cues: Record<string, true> = {};
    for (const [cueKey, played] of Object.entries(cueMap)) {
      if (played === true) cues[cueKey] = true;
    }
    if (Object.keys(cues).length > 0) {
      memory[orderKey] = cues;
    }
  }
  return memory;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pruneOrderCueMemory(
  memory: Record<string, Record<string, true>>,
): Record<string, Record<string, true>> {
  const entries = Object.entries(memory).flatMap(([orderKey, cueMap]) =>
    Object.keys(cueMap).map((cueKey) => [orderKey, cueKey] as const),
  );
  const retained = entries.slice(-ORDER_CUE_MEMORY_LIMIT);
  const pruned: Record<string, Record<string, true>> = {};
  for (const [orderKey, cueKey] of retained) {
    pruned[orderKey] = {
      ...pruned[orderKey],
      [cueKey]: true,
    };
  }
  return pruned;
}
