import type { CustomerExperienceEvent } from "@/customer-events/events";

import { onCustomerEvent } from "@/composables/useCustomerEvents";

import { createMachineAudioCuePlaybackAdapter } from "./browser-playback";

type CustomerAudioCueConsumer = {
  handleCustomerEvent(event: CustomerExperienceEvent): Promise<boolean>;
};

type CustomerAudioCueConsumerOptions = {
  consumer?: CustomerAudioCueConsumer;
};

let activeCleanup: (() => void) | null = null;

export function installCustomerAudioCueConsumer(
  options: CustomerAudioCueConsumerOptions = {},
): () => void {
  if (activeCleanup) return activeCleanup;

  const consumer = options.consumer ?? createMachineAudioCuePlaybackAdapter();
  const unsubscribe = onCustomerEvent((event) => {
    void consumer.handleCustomerEvent(event);
  });
  activeCleanup = () => {
    unsubscribe();
    activeCleanup = null;
  };
  return activeCleanup;
}

export function resetCustomerAudioCueConsumerForTests(): void {
  activeCleanup?.();
  activeCleanup = null;
}
