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
let lastTransactionByOrderKey = new Map<string, string | null>();
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

  const sourceFactKey = `${event.orderKey}:${event.type}`;
  if (emittedTransactionSourceFacts.has(sourceFactKey)) return;
  emittedTransactionSourceFacts.add(sourceFactKey);
  emitCustomerEvent(event);
}

function eventTypeForTerminalTransaction(
  nextAction: string | null,
): CustomerExperienceEvent["type"] | null {
  switch (nextAction) {
    case null:
      return null;
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

function eventTypeForPickupReminder(
  reminder:
    | {
        stage?: string | null;
        level?: string | null;
        warningNo?: number | null;
      }
    | null
    | undefined,
): CustomerExperienceEvent["type"] | null {
  if (!reminder?.stage) return null;
  switch (reminder.stage) {
    case "outlet_opened":
      return "dispense.outlet_opened";
    case "pickup_waiting":
      return "pickup.waiting";
    case "pickup_timeout_warning":
      return reminder.level === "urgent" || (reminder.warningNo ?? 0) >= 2
        ? "pickup.urgent"
        : "pickup.warning";
    default:
      return null;
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
          const pickupReminderEventType = eventTypeForPickupReminder(
            transaction.pickupReminder,
          );
          if (pickupReminderEventType) {
            emitTransactionEventOnce({
              type: pickupReminderEventType,
              orderKey: transaction.orderKey,
            });
          }
          return;
        }

        const terminalEventType = eventTypeForTerminalTransaction(
          transaction.nextAction,
        );
        if (transaction.nextAction === "success") {
          emitTransactionEventOnce({
            type: "pickup.completed",
            orderKey: transaction.orderKey,
          });
          emitTransactionEventOnce({
            type: "dispense.succeeded",
            orderKey: transaction.orderKey,
          });
          return;
        }
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
