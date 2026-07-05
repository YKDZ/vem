import type { VisionPresenceOccupancyState } from "@vem/shared";

import {
  effectScope,
  shallowRef,
  watch,
  type EffectScope,
  type Ref,
} from "vue";

import type { CustomerExperienceEvent } from "@/customer-events/events";

import { useCheckoutStore } from "@/stores/checkout";
import { useNaturalContextStore } from "@/stores/natural-context";

import { emitCustomerExperienceEvent } from "./useCustomerExperienceEvents";

type VisionAudioCueState = "absent" | "single" | "crowd";

export type DirectCustomerAudioCueSourceFact = {
  event: CustomerExperienceEvent;
};

export type VisionPresenceAudioCueSourceFact = {
  type: "vision.presence";
  personPresent: boolean;
  occupancyState: VisionPresenceOccupancyState;
  observedAt: string;
  restored?: boolean;
};

export type LocalAwakenedAudioCueSourceFact = {
  type: "local.awakened";
  requestedAt: string;
  nowMs?: number;
};

export type CustomerAudioCueSourceFact =
  | DirectCustomerAudioCueSourceFact
  | VisionPresenceAudioCueSourceFact
  | LocalAwakenedAudioCueSourceFact;

export type CustomerAudioCueEventSourceOptions = {
  sourceFact?: Readonly<Ref<CustomerAudioCueSourceFact | null>>;
};

const sourceFact = shallowRef<CustomerAudioCueSourceFact | null>(null);

let activeScope: EffectScope | null = null;
let activeCleanup: (() => void) | null = null;
let lastVisionAudioCueState: VisionAudioCueState = "absent";
let emittedTransactionSourceFacts = new Set<string>();
let lastTransactionByOrderKey = new Map<string, string | null>();

function visionPresenceCueEvent(
  seenAt: string,
): CustomerExperienceEvent["type"] {
  const naturalContext = useNaturalContextStore();
  const sun = naturalContext.snapshot?.externalEnvironment.sun;
  if (sun?.status !== "ready" || !sun.sunriseAt || !sun.sunsetAt) {
    return "presence.detected";
  }

  const seenAtMs = Date.parse(seenAt);
  const sunriseAtMs = Date.parse(sun.sunriseAt);
  const sunsetAtMs = Date.parse(sun.sunsetAt);
  if (
    Number.isNaN(seenAtMs) ||
    Number.isNaN(sunriseAtMs) ||
    Number.isNaN(sunsetAtMs)
  ) {
    return "presence.detected";
  }

  if (seenAtMs >= sunriseAtMs && seenAtMs < sunsetAtMs) {
    return "presence.welcome.day";
  }
  return "presence.welcome.night";
}

function visionAudioCueState(
  fact: VisionPresenceAudioCueSourceFact,
): VisionAudioCueState {
  if (!fact.personPresent) return "absent";
  if (fact.occupancyState === "multiple") return "crowd";
  if (fact.occupancyState === "single") return "single";
  return "absent";
}

function eventForVisionPresenceFact(
  fact: VisionPresenceAudioCueSourceFact,
): CustomerExperienceEvent | null {
  const nextVisionAudioCueState = visionAudioCueState(fact);
  if (fact.restored) {
    lastVisionAudioCueState = nextVisionAudioCueState;
    return null;
  }
  if (nextVisionAudioCueState === "absent") {
    lastVisionAudioCueState = "absent";
    return null;
  }

  const shouldEmit =
    (nextVisionAudioCueState === "single" &&
      lastVisionAudioCueState === "absent") ||
    (nextVisionAudioCueState === "crowd" &&
      lastVisionAudioCueState !== "crowd");
  lastVisionAudioCueState = nextVisionAudioCueState;
  if (!shouldEmit) return null;

  return {
    type:
      nextVisionAudioCueState === "crowd"
        ? "privacy.crowd_detected"
        : visionPresenceCueEvent(fact.observedAt),
    requestedAt: fact.observedAt,
  };
}

function eventForSourceFact(
  fact: CustomerAudioCueSourceFact,
): CustomerExperienceEvent | null {
  if ("event" in fact) return fact.event;
  if (fact.type === "local.awakened") {
    return {
      type: "interaction.awakened",
      requestedAt: fact.requestedAt,
      nowMs: fact.nowMs,
    };
  }
  return eventForVisionPresenceFact(fact);
}

function emitTransactionEventOnce(event: CustomerExperienceEvent): void {
  if (!("orderKey" in event) || !event.orderKey) {
    emitCustomerExperienceEvent(event);
    return;
  }

  const sourceFactKey = `${event.orderKey}:${event.type}`;
  if (emittedTransactionSourceFacts.has(sourceFactKey)) return;
  emittedTransactionSourceFacts.add(sourceFactKey);
  emitCustomerExperienceEvent(event);
}

function eventTypeForTerminalTransaction(
  nextAction: string | null,
): CustomerExperienceEvent["type"] | null {
  switch (nextAction) {
    case null:
      return null;
    case "success":
      return "dispense.succeeded";
    case "dispense_failed":
      return "dispense.failed";
    case "refund_pending":
      return "refund.pending";
    case "refunded":
      return "refund.completed";
    case "manual_handling":
      return "manual_handling.required";
    default:
      return null;
  }
}

export function installCustomerAudioCueEventSource(
  options: CustomerAudioCueEventSourceOptions = {},
): () => void {
  if (activeCleanup) return activeCleanup;

  const runtimeSourceFact = options.sourceFact ?? sourceFact;
  const scope = effectScope();
  scope.run(() => {
    watch(
      () => runtimeSourceFact.value,
      (fact) => {
        if (!fact) return;
        const event = eventForSourceFact(fact);
        if (event) {
          emitCustomerExperienceEvent(event);
        }
      },
      { flush: "sync" },
    );

    const checkoutStore = useCheckoutStore();
    watch(
      () => checkoutStore.transactionObservation,
      (transaction) => {
        if (!transaction) return;

        const previousNextAction =
          lastTransactionByOrderKey.get(transaction.orderKey) ?? null;
        lastTransactionByOrderKey.set(
          transaction.orderKey,
          transaction.nextAction,
        );
        if (transaction.restored) return;

        if (transaction.nextAction === "wait_payment") {
          emitTransactionEventOnce({
            type: "payment.prompt",
            orderKey: transaction.orderKey,
          });
          return;
        }

        if (transaction.nextAction === "dispensing") {
          if (previousNextAction === "wait_payment") {
            emitTransactionEventOnce({
              type: "payment.succeeded",
              orderKey: transaction.orderKey,
            });
          }
          emitTransactionEventOnce({
            type: "dispensing.started",
            orderKey: transaction.orderKey,
          });
          return;
        }

        const terminalEventType = eventTypeForTerminalTransaction(
          transaction.nextAction,
        );
        if (terminalEventType) {
          emitTransactionEventOnce({
            type: terminalEventType,
            orderKey: transaction.orderKey,
          });
        }
      },
      { flush: "sync" },
    );
  });

  activeScope = scope;
  activeCleanup = () => {
    if (activeScope !== scope) return;
    scope.stop();
    activeScope = null;
    activeCleanup = null;
  };
  return activeCleanup;
}

export function recordCustomerAudioCueSourceFact(
  fact: CustomerAudioCueSourceFact,
): void {
  sourceFact.value = fact;
}

export function resetCustomerAudioCueEventSourceForTests(): void {
  activeCleanup?.();
  sourceFact.value = null;
  lastVisionAudioCueState = "absent";
  emittedTransactionSourceFacts = new Set();
  lastTransactionByOrderKey = new Map();
}
