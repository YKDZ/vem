import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useAudioCueStore } from "./audio-cues";
import { useMachineStore } from "./machine";

function applyAudioPreferences(input: {
  cuesEnabled: boolean;
  presenceCuesEnabled: boolean;
  transactionCuesEnabled: boolean;
}): void {
  useMachineStore().applyEffectiveRuntimeConfiguration({
    experience: { audio: { volume: 0.7, ...input } },
  } as EffectiveMachineRuntimeConfiguration);
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  setActivePinia(createPinia());
});

describe("useAudioCueStore", () => {
  it("rejects cue requests while global audio cues are disabled", () => {
    const store = useAudioCueStore();
    applyAudioPreferences({
      cuesEnabled: false,
      presenceCuesEnabled: true,
      transactionCuesEnabled: true,
    });

    expect(
      store.requestCue({
        category: "presence",
        cueKey: "presence.detected",
        requestedAt: "2026-06-29T07:00:00.000Z",
      }),
    ).toBeNull();
    expect(store.playback.status).toBe("idle");
  });

  it("accepts enabled category requests as pending and then playing state", () => {
    const store = useAudioCueStore();
    applyAudioPreferences({
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: false,
    });

    const request = store.requestCue({
      category: "presence",
      cueKey: "presence.detected",
      requestedAt: "2026-06-29T07:00:00.000Z",
    });

    expect(request).toMatchObject({
      category: "presence",
      cueKey: "presence.detected",
    });
    expect(store.playback.status).toBe("pending");

    expect(store.markCuePlaying(request?.requestId ?? "")).toBe(true);
    expect(store.playback.status).toBe("playing");
  });

  it("tracks transaction-scoped duplicate memory by order key and cue key", () => {
    const store = useAudioCueStore();

    expect(store.hasOrderCuePlayed("ORDER-1", "payment.succeeded")).toBe(false);

    store.rememberOrderCuePlayed("ORDER-1", "payment.succeeded");

    expect(store.hasOrderCuePlayed("ORDER-1", "payment.succeeded")).toBe(true);
    expect(store.hasOrderCuePlayed("ORDER-2", "payment.succeeded")).toBe(false);
  });

  it("restores transaction-scoped duplicate memory in a fresh store runtime", () => {
    const store = useAudioCueStore();
    store.rememberOrderCuePlayed("ORDER-1", "payment.succeeded");

    setActivePinia(createPinia());
    const restoredStore = useAudioCueStore();

    expect(
      restoredStore.hasOrderCuePlayed("ORDER-1", "payment.succeeded"),
    ).toBe(true);
    expect(
      restoredStore.hasOrderCuePlayed("ORDER-1", "dispensing.started"),
    ).toBe(false);
  });

  it("records latest playback diagnostic without mutating transaction memory", () => {
    const store = useAudioCueStore();
    applyAudioPreferences({
      cuesEnabled: true,
      presenceCuesEnabled: false,
      transactionCuesEnabled: true,
    });
    const request = store.requestCue({
      category: "transaction",
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
      requestedAt: "2026-06-29T07:00:00.000Z",
    });
    store.markCuePlaying(request?.requestId ?? "");

    store.recordPlaybackOutcome({
      requestId: request?.requestId ?? "",
      outcome: "failed",
      message: "NotAllowedError",
      recordedAt: "2026-06-29T07:00:01.000Z",
    });

    expect(store.playback.status).toBe("idle");
    expect(store.latestPlaybackDiagnostic).toMatchObject({
      requestId: request?.requestId,
      category: "transaction",
      cueKey: "payment.succeeded",
      orderKey: "ORDER-1",
      outcome: "failed",
      message: "NotAllowedError",
      recordedAt: "2026-06-29T07:00:01.000Z",
    });
    expect(store.hasOrderCuePlayed("ORDER-1", "payment.succeeded")).toBe(false);
  });
});
