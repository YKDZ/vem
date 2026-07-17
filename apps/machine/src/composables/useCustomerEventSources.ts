import type { VisionPresenceOccupancyState } from "@vem/shared";

import {
  effectScope,
  shallowRef,
  watch,
  type EffectScope,
  type Ref,
} from "vue";

import type {
  CustomerEventJourneyFact,
  CustomerEventPickupCue,
} from "@/checkout/customer-checkout-view";
import type {
  CustomerExperienceEvent,
  PresenceEventType,
  TransactionEventType,
} from "@/customer-events/events";

import { useCheckoutStore } from "@/stores/checkout";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useSaleCapabilityStore } from "@/stores/sale-capability";

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

export type NaturalContextAudioCueSourceFact = {
  type: "natural_context.cue";
  eventType: PresenceEventType;
  occurredAt: string;
};

export type CustomerSourceFact =
  | DirectCustomerSourceFact
  | VisionPresenceAudioCueSourceFact
  | LocalAwakenedAudioCueSourceFact
  | CustomerSessionIdleAudioCueSourceFact
  | NaturalContextAudioCueSourceFact;

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
  CustomerEventJourneyFact | null
>();
let emittedIdleSourceFacts = new Set<string>();
let lastSystemHardwareFaultCapabilityKey: string | null = null;

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

function visionPresenceCueEvent(seenAt: string): PresenceEventType {
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

  if (nextVisionAudioCueState === "crowd") {
    return {
      type: "privacy.crowd_detected",
      requestedAt: fact.observedAt,
    };
  }

  return {
    type: visionPresenceCueEvent(fact.observedAt),
    requestedAt: fact.observedAt,
  };
}

function eventForSourceFact(
  fact: CustomerSourceFact,
  routeName: unknown,
): CustomerExperienceEvent | null {
  if ("event" in fact) return fact.event;
  if (fact.type === "natural_context.cue") {
    return {
      type: fact.eventType,
      requestedAt: fact.occurredAt,
    };
  }
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

function eventTypeForJourneyFact(
  fact: CustomerEventJourneyFact | null,
): TransactionEventType | null {
  switch (fact) {
    case null:
    case "payment_requested":
      return null;
    case "payment_failure":
      return "payment.failed";
    case "dispense_started":
      return "dispensing.started";
    case "dispense_succeeded":
      return "dispense.succeeded";
    case "dispense_failure":
      return "dispense.failed";
    case "refund_in_progress":
      return "refund.pending";
    case "refund_resolved":
      return "refund.completed";
    case "manual_support_required":
      return "manual_handling.required";
  }
}

function eventTypeForPickupCue(
  cue: CustomerEventPickupCue | null,
): TransactionEventType | null {
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
  journeyFact: CustomerEventJourneyFact | null;
  pickupCue: CustomerEventPickupCue | null;
}): void {
  if (input.journeyFact === "payment_requested") {
    rememberTransactionEventHandled(input.orderKey, "payment.prompt");
  }

  const journeyEventType = eventTypeForJourneyFact(input.journeyFact);
  if (journeyEventType) {
    rememberTransactionEventHandled(input.orderKey, journeyEventType);
  }

  const pickupEventType = eventTypeForPickupCue(input.pickupCue);
  if (pickupEventType) {
    rememberTransactionEventHandled(input.orderKey, pickupEventType);
  }
}

function shouldEmitSystemHardwareFault(): boolean {
  const capabilityStore = useSaleCapabilityStore();
  const capability = capabilityStore.accepted;
  if (!capability || capability.canStartSale) {
    lastSystemHardwareFaultCapabilityKey = null;
    return false;
  }

  const codes = capability.blockers.map((reason) => reason.code);
  const hasHardwareBlocker = codes.some((code) =>
    ["LOWER_CONTROLLER_UNAVAILABLE", "HARDWARE_UNAVAILABLE"].includes(code),
  );
  if (!hasHardwareBlocker) return false;

  const capabilityKey = `${capability.generation}:${capability.revision}:${codes.join(",")}`;
  if (lastSystemHardwareFaultCapabilityKey === capabilityKey) return false;
  lastSystemHardwareFaultCapabilityKey = capabilityKey;
  return true;
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
    const capabilityStore = useSaleCapabilityStore();
    watch(
      () => capabilityStore.accepted,
      () => {
        if (!shouldEmitSystemHardwareFault()) return;
        emitCustomerEvent({
          type: "system.hardware_fault",
          requestedAt: new Date().toISOString(),
        });
      },
      { flush: "sync" },
    );

    watch(
      () => checkoutStore.customerCheckoutView.customerEventObservation,
      (observation) => {
        const orderKey = observation.orderCredential;
        if (!orderKey) return;

        const previousFact = lastTransactionByOrderKey.get(orderKey) ?? null;
        lastTransactionByOrderKey.set(orderKey, observation.journeyFact);
        if (observation.restored) {
          rememberRestoredObservationEvents({
            orderKey,
            journeyFact: observation.journeyFact,
            pickupCue: observation.pickupCue,
          });
          return;
        }

        if (observation.journeyFact === "payment_requested") {
          if (previousFact === "payment_requested") return;
          emitTransactionEventOnce({
            type: "payment.prompt",
            orderKey,
          });
          return;
        }

        if (observation.journeyFact === "dispense_started") {
          if (previousFact === "payment_requested") {
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

        const pickupEventType = eventTypeForPickupCue(observation.pickupCue);
        if (pickupEventType) {
          emitTransactionEventOnce({
            type: pickupEventType,
            orderKey,
          });
        }

        const journeyEventType = eventTypeForJourneyFact(
          observation.journeyFact,
        );
        if (journeyEventType) {
          emitTransactionEventOnce({
            type: journeyEventType,
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
  lastSystemHardwareFaultCapabilityKey = null;
}
