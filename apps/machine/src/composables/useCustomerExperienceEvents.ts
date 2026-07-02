import { onUnmounted } from "vue";

import type { CustomerExperienceEvent } from "@/customer-events/events";

export type CustomerExperienceEventHandler = (
  event: CustomerExperienceEvent,
) => void;

const listeners = new Set<CustomerExperienceEventHandler>();

export function emitCustomerExperienceEvent(
  event: CustomerExperienceEvent,
): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

export function onCustomerExperienceEvent(
  listener: CustomerExperienceEventHandler,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCustomerExperienceEvents(): {
  emit: typeof emitCustomerExperienceEvent;
  on: typeof onCustomerExperienceEvent;
} {
  const cleanups: Array<() => void> = [];

  onUnmounted(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  return {
    emit: emitCustomerExperienceEvent,
    on(listener) {
      const cleanup = onCustomerExperienceEvent(listener);
      cleanups.push(cleanup);
      return cleanup;
    },
  };
}
