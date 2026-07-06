import type { VisionPresenceOccupancyState } from "@vem/shared";

import {
  effectScope,
  shallowRef,
  watch,
  type EffectScope,
  type Ref,
} from "vue";

import type {
  CustomerEventObservationPhase,
  CustomerEventPickupCue,
} from "@/checkout/customer-checkout-view";
import type { CustomerExperienceEvent } from "@/customer-events/events";

import { useCheckoutStore } from "@/stores/checkout";
import { useNaturalContextStore } from "@/stores/natural-context";

import { emitCustomerEvent } from "./useCustomerEvents";

type VisionAudioCueState = "absent" | "single" | "crowd";

export type DirectCustomerSourceFact = {
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

export type CustomerSessionIdleAudioCueSourceFact = {
  type: "customer_session.idle";
  idleEvent: "assistance_prompt" | "sleep";
  occurredAt: string;
};

export type CustomerSourceFact =
  | DirectCustomerSourceFact
  | VisionPresenceAudioCueSourceFact
  | LocalAwakenedAudioCueSourceFact
  | CustomerSessionIdleAudioCueSourceFact;

export type CustomerEventSourceOptions = {
  sourceFact?: Readonly<Ref<CustomerSourceFact | null>>;
  routeName?: Readonly<Ref<unknown>>;
};

const sourceFact = shallowRef<CustomerSourceFact | null>(null);

let activeScope: EffectScope | null = null;
let activeCleanup: (() => void) | null = null;
let lastVisionAudioCueState: VisionAudioCueState = "absent";
let emittedTransactionSourceFacts = new Set<string>();
let lastTransactionByOrderKey = new Map<
  string,
  CustomerEventObservationPhase | null
>();
let emittedIdleSourceFacts = new Set<string>();

const ASSISTANCE_PROMPT_ROUTE_NAMES = new Set([
  "catalog",
  "product-detail",
  "virtual-try-on",
  "checkout",
]);

function isAssistancePromptRouteName(routeName: unknown): boolean {
  return (
    typeof routeName === "string" &&
    ASSISTANCE_PROMPT_ROUTE_NAMES.has(routeName)
  );
}

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
  fact: CustomerSourceFact,
  routeName: unknown,
): CustomerExperienceEvent | null {
  if ("event" in fact) return fact.event;
  if (fact.type === "local.awakened") {
    return {
      type: "interaction.awakened",
      requestedAt: fact.requestedAt,
      nowMs: fact.nowMs,
    };
  }
  if (fact.type === "customer_session.idle") {
    if (
      fact.idleEvent === "assistance_prompt" &&
      !isAssistancePromptRouteName(routeName)
    ) {
      return null;
    }
    return {
      type:
        fact.idleEvent === "assistance_prompt"
          ? "idle.assistance_prompt"
          : "idle.sleep",
      requestedAt: fact.occurredAt,
    };
  }
  return eventForVisionPresenceFact(fact);
}

function emitTransactionEventOnce(event: CustomerExperienceEvent): void {
  if (!("orderKey" in event) || !event.orderKey) {
    emitCustomerEvent(event);
    return;
  }

  const sourceFactKey = transactionSourceFactKey(event.orderKey, event.type);
  if (emittedTransactionSourceFacts.has(sourceFactKey)) return;
  emittedTransactionSourceFacts.add(sourceFactKey);
  emitCustomerEvent(event);
}

function transactionSourceFactKey(
  orderKey: string,
  eventType: CustomerExperienceEvent["type"],
): string {
  return `${orderKey}:${eventType}`;
}

function rememberTransactionEventHandled(
  orderKey: string,
  eventType: CustomerExperienceEvent["type"],
): void {
  emittedTransactionSourceFacts.add(
    transactionSourceFactKey(orderKey, eventType),
  );
}

function eventTypeForTerminalObservation(
  phase: CustomerEventObservationPhase,
): CustomerExperienceEvent["type"] | null {
  switch (phase) {
    case "dispense_failed_result":
      return "dispense.failed";
    case "refund_pending_result":
      return "refund.pending";
    case "refund_completed_result":
      return "refund.completed";
    case "manual_handling_result":
      return "manual_handling.required";
    default:
      return null;
  }
}

function eventTypeForPickupCue(
  cue: CustomerEventPickupCue | null,
): CustomerExperienceEvent["type"] | null {
  switch (cue) {
    case null:
      return null;
    case "outlet_opened":
      return "dispense.outlet_opened";
    case "waiting":
      return "pickup.waiting";
    case "warning":
      return "pickup.warning";
    case "urgent":
      return "pickup.urgent";
    case "completed":
      return "pickup.completed";
    default:
      return null;
  }
}

function rememberRestoredObservationEvents(input: {
  orderKey: string;
  phase: CustomerEventObservationPhase;
  pickupCue: CustomerEventPickupCue | null;
}): void {
  if (input.phase === "dispensing") {
    rememberTransactionEventHandled(input.orderKey, "dispensing.started");
    const pickupEventType = eventTypeForPickupCue(input.pickupCue);
    if (pickupEventType) {
      rememberTransactionEventHandled(input.orderKey, pickupEventType);
    }
    return;
  }

  if (input.phase === "success_result") {
    rememberTransactionEventHandled(input.orderKey, "pickup.completed");
    rememberTransactionEventHandled(input.orderKey, "dispense.succeeded");
    return;
  }

  const terminalEventType = eventTypeForTerminalObservation(input.phase);
  if (terminalEventType) {
    rememberTransactionEventHandled(input.orderKey, terminalEventType);
  }
}

export function installCustomerEventSources(
  options: CustomerEventSourceOptions = {},
): () => void {
  if (activeCleanup) return activeCleanup;

  const runtimeSourceFact = options.sourceFact ?? sourceFact;
  const routeName = options.routeName;
  const scope = effectScope();
  scope.run(() => {
    watch(
      () => runtimeSourceFact.value,
      (fact) => {
        if (!fact) return;
        if ("type" in fact && fact.type === "customer_session.idle") {
          const idleFactKey = `${fact.idleEvent}:${fact.occurredAt}`;
          if (emittedIdleSourceFacts.has(idleFactKey)) return;
          emittedIdleSourceFacts.add(idleFactKey);
        }
        const event = eventForSourceFact(fact, routeName?.value);
        if (event) {
          emitCustomerEvent(event);
        }
      },
      { flush: "sync" },
    );

    const checkoutStore = useCheckoutStore();
    watch(
      () => checkoutStore.customerEventObservation,
      (observation) => {
        const orderKey = observation.orderCredential;
        if (!orderKey) return;

        const previousPhase = lastTransactionByOrderKey.get(orderKey) ?? null;
        lastTransactionByOrderKey.set(
          orderKey,
          observation.phase,
        );
        if (observation.restored) {
          rememberRestoredObservationEvents({
            orderKey,
            phase: observation.phase,
            pickupCue: observation.pickupCue,
          });
          return;
        }

        if (observation.phase === "awaiting_payment") {
          if (previousPhase === "awaiting_payment") return;
          emitTransactionEventOnce({
            type: "payment.prompt",
            orderKey,
          });
          return;
        }

        if (observation.phase === "dispensing") {
          if (previousPhase === "awaiting_payment") {
            emitTransactionEventOnce({
              type: "payment.succeeded",
              orderKey,
            });
          }
          emitTransactionEventOnce({
            type: "dispensing.started",
            orderKey,
          });
          const pickupReminderEventType = eventTypeForPickupCue(
            observation.pickupCue,
          );
          if (pickupReminderEventType) {
            emitTransactionEventOnce({
              type: pickupReminderEventType,
              orderKey,
            });
          }
          return;
        }

        const terminalEventType = eventTypeForTerminalObservation(
          observation.phase,
        );
        if (observation.phase === "success_result") {
          emitTransactionEventOnce({
            type: "pickup.completed",
            orderKey,
          });
          emitTransactionEventOnce({
            type: "dispense.succeeded",
            orderKey,
          });
          return;
        }
        if (terminalEventType) {
          emitTransactionEventOnce({
            type: terminalEventType,
            orderKey,
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

export function recordCustomerSourceFact(fact: CustomerSourceFact): void {
  sourceFact.value = fact;
}

export function resetCustomerEventSourcesForTests(): void {
  activeCleanup?.();
  sourceFact.value = null;
  lastVisionAudioCueState = "absent";
  emittedTransactionSourceFacts = new Set();
  lastTransactionByOrderKey = new Map();
  emittedIdleSourceFacts = new Set();
}
