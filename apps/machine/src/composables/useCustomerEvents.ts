import { onUnmounted } from "vue";

import type { CustomerExperienceEvent } from "@/customer-events/events";

export type CustomerEventHandler = (event: CustomerExperienceEvent) => void;

const listeners = new Set<CustomerEventHandler>();

export function emitCustomerEvent(event: CustomerExperienceEvent): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

export function onCustomerEvent(listener: CustomerEventHandler): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCustomerEvents(): {
  emit: typeof emitCustomerEvent;
  on: typeof onCustomerEvent;
} {
  const cleanups: Array<() => void> = [];

  onUnmounted(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  return {
    emit: emitCustomerEvent,
    on(listener) {
      const cleanup = onCustomerEvent(listener);
      cleanups.push(cleanup);
      return cleanup;
    },
  };
}
