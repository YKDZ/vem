import type { AudioCueCategory } from "@/stores/audio-cues";

export type PresenceEventType =
  | "presence.detected"
  | "presence.welcome.day"
  | "presence.welcome.night"
  | "interaction.awakened"
  | "privacy.crowd_detected"
  | "idle.assistance_prompt"
  | "idle.sleep"
  | "departure.bad_weather"
  | "departure.bad_air"
  | "departure.bad_forecast"
  | "departure.normal_weather";

export type TransactionEventType =
  | "product.selected"
  | "product.intro.socks"
  | "product.intro.underwear"
  | "product.intro.tshirt"
  | "payment.prompt"
  | "payment.succeeded"
  | "payment.failed"
  | "dispensing.started"
  | "dispense.outlet_opened"
  | "dispense.succeeded"
  | "dispense.failed"
  | "pickup.waiting"
  | "pickup.warning"
  | "pickup.urgent"
  | "pickup.completed"
  | "refund.pending"
  | "refund.completed"
  | "manual_handling.required"
  | "system.hardware_fault";

export type CustomerExperienceEvent =
  | {
      type: PresenceEventType;
      requestedAt?: string;
      nowMs?: number;
    }
  | {
      type: TransactionEventType;
      orderKey?: string | null;
      requestedAt?: string;
      nowMs?: number;
    };

export type CustomerExperienceEventDescriptor = {
  category: AudioCueCategory;
  eventKey: CustomerExperienceEvent["type"];
  orderKey: string | null;
  requestedAt?: string;
  nowMs: number;
  minimumIntervalMs?: number;
  priority: number;
  staleAfterMs: number | null;
};

const PRESENCE_MINIMUM_INTERVAL_MS = 10_000;
const PRESENCE_STALE_AFTER_MS = 2_000;

export const CUSTOMER_EXPERIENCE_EVENT_PRIORITIES: Record<
  CustomerExperienceEvent["type"],
  number
> = {
  "presence.detected": 5,
  "presence.welcome.day": 8,
  "presence.welcome.night": 8,
  "interaction.awakened": 30,
  "product.selected": 35,
  "product.intro.socks": 32,
  "product.intro.underwear": 32,
  "product.intro.tshirt": 32,
  "payment.prompt": 35,
  "payment.succeeded": 40,
  "payment.failed": 90,
  "dispensing.started": 40,
  "dispense.outlet_opened": 40,
  "dispense.succeeded": 40,
  "pickup.waiting": 40,
  "pickup.warning": 40,
  "pickup.urgent": 40,
  "pickup.completed": 40,
  "idle.assistance_prompt": 45,
  "idle.sleep": 45,
  "departure.bad_weather": 60,
  "departure.bad_air": 61,
  "departure.bad_forecast": 62,
  "departure.normal_weather": 63,
  "refund.pending": 70,
  "refund.completed": 70,
  "privacy.crowd_detected": 80,
  "dispense.failed": 90,
  "system.hardware_fault": 95,
  "manual_handling.required": 100,
};

export function describeCustomerExperienceEvent(
  event: CustomerExperienceEvent,
): CustomerExperienceEventDescriptor {
  const nowMs = event.nowMs ?? Date.now();
  const category = categoryForCustomerExperienceEvent(event.type);
  return {
    category,
    eventKey: event.type,
    orderKey: "orderKey" in event ? (event.orderKey ?? null) : null,
    requestedAt: event.requestedAt,
    nowMs,
    minimumIntervalMs:
      category === "presence" ? PRESENCE_MINIMUM_INTERVAL_MS : undefined,
    priority: CUSTOMER_EXPERIENCE_EVENT_PRIORITIES[event.type],
    staleAfterMs: category === "presence" ? PRESENCE_STALE_AFTER_MS : null,
  };
}

export function categoryForCustomerExperienceEvent(
  type: CustomerExperienceEvent["type"],
): AudioCueCategory {
  switch (type) {
    case "presence.detected":
    case "presence.welcome.day":
    case "presence.welcome.night":
    case "interaction.awakened":
    case "privacy.crowd_detected":
    case "idle.assistance_prompt":
    case "idle.sleep":
    case "departure.bad_weather":
    case "departure.bad_air":
    case "departure.bad_forecast":
    case "departure.normal_weather":
      return "presence";
    case "product.selected":
    case "product.intro.socks":
    case "product.intro.underwear":
    case "product.intro.tshirt":
    case "payment.prompt":
    case "payment.succeeded":
    case "payment.failed":
    case "dispensing.started":
    case "dispense.outlet_opened":
    case "dispense.succeeded":
    case "dispense.failed":
    case "pickup.waiting":
    case "pickup.warning":
    case "pickup.urgent":
    case "pickup.completed":
    case "refund.pending":
    case "refund.completed":
    case "manual_handling.required":
    case "system.hardware_fault":
      return "transaction";
  }
}

export function requiresOrderMemory(
  event: CustomerExperienceEventDescriptor,
): event is CustomerExperienceEventDescriptor & { orderKey: string } {
  return event.category === "transaction" && Boolean(event.orderKey);
}
