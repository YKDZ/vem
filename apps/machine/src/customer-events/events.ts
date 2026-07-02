import type { AudioCueCategory } from "@/stores/audio-cues";

export type CustomerExperienceEvent =
  | {
      type:
        | "presence.detected"
        | "presence.welcome.day"
        | "presence.welcome.night"
        | "presence.easter_egg"
        | "interaction.awakened"
        | "privacy.crowd_detected"
        | "idle.assistance_prompt"
        | "idle.sleep";
      requestedAt?: string;
      nowMs?: number;
    }
  | {
      type:
        | "product.selected"
        | "payment.prompt"
        | "payment.succeeded"
        | "dispensing.started"
        | "dispense.succeeded"
        | "dispense.failed"
        | "pickup.completed"
        | "refund.pending"
        | "refund.completed"
        | "manual_handling.required"
        | "system.hardware_fault";
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
  "presence.easter_egg": 5,
  "presence.detected": 10,
  "presence.welcome.day": 20,
  "presence.welcome.night": 20,
  "interaction.awakened": 30,
  "product.selected": 35,
  "payment.prompt": 35,
  "payment.succeeded": 40,
  "dispensing.started": 40,
  "dispense.succeeded": 40,
  "pickup.completed": 40,
  "idle.assistance_prompt": 45,
  "idle.sleep": 45,
  "refund.pending": 50,
  "refund.completed": 50,
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
    case "product.selected":
    case "payment.prompt":
    case "payment.succeeded":
    case "dispensing.started":
    case "dispense.succeeded":
    case "dispense.failed":
    case "pickup.completed":
    case "refund.pending":
    case "refund.completed":
    case "manual_handling.required":
    case "system.hardware_fault":
      return "transaction";
    default:
      return "presence";
  }
}

export function requiresOrderMemory(
  event: CustomerExperienceEventDescriptor,
): event is CustomerExperienceEventDescriptor & { orderKey: string } {
  return event.category === "transaction" && Boolean(event.orderKey);
}
