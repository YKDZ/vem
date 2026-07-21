import type { CustomerJourneyTransition } from "@/customer-journey/transition-projector";

import {
  createBrowserMachineAudioPlaybackDriver,
  createTauriNativeMachineAudioPlaybackDriver,
} from "@/audio-playback/machine-audio-playback";
import {
  createMachineRuntimeTrace,
  type MachineRuntimeTrace,
  type MachineRuntimeTraceEntry,
} from "@/runtime/machine-runtime-trace";

export type AudioCoordinatorPlaybackTerminal = {
  status: "completed" | "failed" | "stopped";
  message?: string | null;
};

export type AudioCoordinatorPlaybackDriver = {
  readonly name: "browser" | "mock" | "native";
  playLocal(
    sourceUrl: string,
    options?: {
      requestId: string;
      volume: number;
      onTerminal: (outcome: AudioCoordinatorPlaybackTerminal) => void;
    },
  ): Promise<void>;
  stop(): void | Promise<void>;
};

export type CustomerAudioPreferences = {
  volume: number;
  cuesEnabled: boolean;
  presenceCuesEnabled: boolean;
  transactionCuesEnabled: boolean;
};

type AudioPresentation = {
  sourceUrl: string;
  priority: number;
};

export type AudioCoordinatorRequest = {
  requestId: string;
  transitionId: string;
  sourceUrl: string;
  priority: number;
  category: CustomerJourneyTransition["category"];
};

type QueuedAudioRequest = AudioCoordinatorRequest & {
  volume?: number;
};

export type AudioCoordinator = {
  accept(transitions: readonly CustomerJourneyTransition[]): Promise<void>;
  requestTestPlayback(
    sourceUrl: string,
    volume: number,
  ): Promise<string | null>;
  refreshPreferences(): Promise<void>;
  activeRequest(): AudioCoordinatorRequest | null;
  queuedRequestIds(): string[];
  trace(): readonly MachineRuntimeTraceEntry[];
  dispose(): Promise<void>;
};

type AudioCoordinatorOptions = {
  driver: AudioCoordinatorPlaybackDriver;
  preferences: () => CustomerAudioPreferences;
  mapTransition: (
    transition: CustomerJourneyTransition,
  ) => AudioPresentation | null;
  trace?: MachineRuntimeTrace;
  maxQueueSize?: number;
};

type CustomerJourneyAudioCoordinatorOptions = Omit<
  AudioCoordinatorOptions,
  "driver"
>;

const DEFAULT_QUEUE_SIZE = 8;
const DEDUPLICATION_LIMIT = 256;

export function createAudioCoordinator(
  options: AudioCoordinatorOptions,
): AudioCoordinator {
  const trace = options.trace ?? createMachineRuntimeTrace();
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_QUEUE_SIZE;
  const acceptedTransitionIds = new Set<string>();
  const terminalRequestIds = new Set<string>();
  const queue: QueuedAudioRequest[] = [];
  let nextRequestSequence = 1;
  let active: QueuedAudioRequest | null = null;
  let stoppingActive = false;
  let disposed = false;
  let disposalPromise: Promise<void> | null = null;

  async function accept(
    transitions: readonly CustomerJourneyTransition[],
  ): Promise<void> {
    if (disposed) return;
    for (const transition of transitions) {
      trace.record({
        type: "journey_transition",
        transitionId: transition.transitionId,
        requestId: null,
        terminalOutcomeId: null,
        outcome: null,
        message: null,
      });
      if (acceptedTransitionIds.has(transition.transitionId)) {
        trace.record({
          type: "audio_rejected",
          transitionId: transition.transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: "duplicate transition",
        });
        continue;
      }
      const presentation = options.mapTransition(transition);
      if (!presentation) continue;
      const preferences = options.preferences();
      if (!preferencesAllow(preferences, transition.category)) {
        trace.record({
          type: "audio_rejected",
          transitionId: transition.transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: "audio cue preference disabled",
        });
        continue;
      }
      if (
        transition.category === "presence" &&
        (active?.category === "transaction" ||
          queue.some((request) => request.category === "transaction"))
      ) {
        trace.record({
          type: "audio_rejected",
          transitionId: transition.transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: "transaction audio active",
        });
        continue;
      }
      if (transition.category === "transaction") {
        discardSupersededQueuedRequests();
      }
      if (queue.length >= maxQueueSize) {
        trace.record({
          type: "audio_rejected",
          transitionId: transition.transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
          message: "audio queue full",
        });
        continue;
      }
      rememberTransition(acceptedTransitionIds, transition.transitionId);
      const request = createRequest({
        transitionId: transition.transitionId,
        sourceUrl: presentation.sourceUrl,
        priority: presentation.priority,
        category: transition.category,
      });
      queue.push(request);
      queue.sort(compareQueuedRequests);
      trace.record({
        type: "audio_queued",
        transitionId: request.transitionId,
        requestId: request.requestId,
        terminalOutcomeId: null,
        outcome: null,
        message: null,
      });
    }
    await interruptForHigherPriorityRequest();
    await startNext();
  }

  function discardSupersededQueuedRequests(): void {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const request = queue[index];
      if (!request) continue;
      queue.splice(index, 1);
      recordTerminal(request, {
        status: "stopped",
        message:
          request.category === "presence"
            ? "superseded by transaction audio"
            : "superseded by newer transaction audio",
      });
    }
  }

  async function requestTestPlayback(
    sourceUrl: string,
    volume: number,
  ): Promise<string | null> {
    if (disposed || queue.length >= maxQueueSize) return null;
    const request = createRequest({
      transitionId: `local-operations-test:${nextRequestSequence}`,
      sourceUrl,
      priority: Number.MAX_SAFE_INTEGER,
      category: "transaction",
    });
    queue.push({ ...request, volume: normalizeVolume(volume) });
    trace.record({
      type: "audio_queued",
      transitionId: request.transitionId,
      requestId: request.requestId,
      terminalOutcomeId: null,
      outcome: null,
      message: "local operations test playback",
    });
    await interruptForHigherPriorityRequest();
    await startNext();
    return request.requestId;
  }

  async function refreshPreferences(): Promise<void> {
    if (disposed) return;
    const preferences = options.preferences();
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const request = queue[index];
      if (!request || preferencesAllow(preferences, request.category)) continue;
      queue.splice(index, 1);
      recordTerminal(request, {
        status: "stopped",
        message: "audio cue preference disabled",
      });
    }
    if (active && !preferencesAllow(preferences, active.category)) {
      stoppingActive = true;
      try {
        await options.driver.stop();
      } catch (error) {
        finishActive({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await startNext();
  }

  function createRequest(
    input: Omit<AudioCoordinatorRequest, "requestId">,
  ): QueuedAudioRequest {
    const requestId = `audio-request-${nextRequestSequence}`;
    nextRequestSequence += 1;
    return { requestId, ...input };
  }

  async function interruptForHigherPriorityRequest(): Promise<void> {
    const next = queue[0];
    const transactionPreemptsPresence =
      next?.category === "transaction" && active?.category === "presence";
    const newerTransactionPreemptsActive =
      next?.category === "transaction" &&
      active?.category === "transaction" &&
      next.priority >= active.priority;
    if (
      !active ||
      !next ||
      (!transactionPreemptsPresence &&
        !newerTransactionPreemptsActive &&
        next.priority <= active.priority) ||
      stoppingActive
    ) {
      return;
    }
    stoppingActive = true;
    try {
      await options.driver.stop();
    } catch (error) {
      finishActive({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function startNext(): Promise<void> {
    if (disposed || active || queue.length === 0) return;
    const request = queue.shift();
    if (!request) return;
    active = request;
    stoppingActive = false;
    const preferences = options.preferences();
    const volume = request.volume ?? normalizeVolume(preferences.volume);
    try {
      await options.driver.playLocal(request.sourceUrl, {
        requestId: request.requestId,
        volume,
        onTerminal: finishActive,
      });
      if (active?.requestId !== request.requestId) return;
      trace.record({
        type: "audio_started",
        transitionId: request.transitionId,
        requestId: request.requestId,
        terminalOutcomeId: null,
        outcome: null,
        message: options.driver.name,
      });
    } catch (error) {
      finishActive({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function finishActive(outcome: AudioCoordinatorPlaybackTerminal): void {
    const request = active;
    if (!request || terminalRequestIds.has(request.requestId)) return;
    active = null;
    stoppingActive = false;
    recordTerminal(request, outcome);
    void startNext();
  }

  function recordTerminal(
    request: AudioCoordinatorRequest,
    outcome: AudioCoordinatorPlaybackTerminal,
  ): void {
    if (terminalRequestIds.has(request.requestId)) return;
    terminalRequestIds.add(request.requestId);
    trace.record({
      type: "audio_terminal",
      transitionId: request.transitionId,
      requestId: request.requestId,
      terminalOutcomeId: `audio-terminal:${request.requestId}`,
      outcome: outcome.status,
      message: outcome.message ?? null,
    });
  }

  async function performDispose(): Promise<void> {
    disposed = true;
    const request = active;
    if (request) {
      try {
        await options.driver.stop();
      } catch (error) {
        finishActive({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const queued of queue.splice(0)) {
      recordTerminal(queued, {
        status: "stopped",
        message: "runtime disposed",
      });
    }
  }

  // oxlint-disable-next-line typescript/promise-function-async -- every disposer must receive the exact shared teardown promise.
  function dispose(): Promise<void> {
    disposalPromise ??= performDispose();
    return disposalPromise;
  }

  return {
    accept,
    requestTestPlayback,
    refreshPreferences,
    activeRequest: () => active,
    queuedRequestIds: () => queue.map((request) => request.requestId),
    trace: () => trace.entries(),
    dispose,
  };
}

function compareQueuedRequests(
  left: QueuedAudioRequest,
  right: QueuedAudioRequest,
): number {
  if (left.category !== right.category) {
    return left.category === "transaction" ? -1 : 1;
  }
  return right.priority - left.priority;
}

export function createCustomerJourneyAudioCoordinator(
  options: CustomerJourneyAudioCoordinatorOptions,
): AudioCoordinator {
  return createAudioCoordinator({
    ...options,
    driver:
      createTauriNativeMachineAudioPlaybackDriver() ??
      createBrowserMachineAudioPlaybackDriver(),
  });
}

function preferencesAllow(
  preferences: CustomerAudioPreferences,
  category: CustomerJourneyTransition["category"],
): boolean {
  return (
    preferences.cuesEnabled &&
    (category === "presence"
      ? preferences.presenceCuesEnabled
      : preferences.transactionCuesEnabled)
  );
}

function normalizeVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.7;
}

function rememberTransition(memory: Set<string>, transitionId: string): void {
  memory.add(transitionId);
  if (memory.size <= DEDUPLICATION_LIMIT) return;
  const oldest = memory.values().next().value;
  if (oldest) memory.delete(oldest);
}
