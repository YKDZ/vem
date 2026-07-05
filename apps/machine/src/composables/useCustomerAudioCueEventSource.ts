import {
  effectScope,
  shallowRef,
  watch,
  type EffectScope,
  type Ref,
} from "vue";

import type { CustomerExperienceEvent } from "@/customer-events/events";

import { emitCustomerExperienceEvent } from "./useCustomerExperienceEvents";

export type CustomerAudioCueSourceFact = {
  event: CustomerExperienceEvent;
};

export type CustomerAudioCueEventSourceOptions = {
  sourceFact?: Readonly<Ref<CustomerAudioCueSourceFact | null>>;
};

const sourceFact = shallowRef<CustomerAudioCueSourceFact | null>(null);

let activeScope: EffectScope | null = null;
let activeCleanup: (() => void) | null = null;

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
        emitCustomerExperienceEvent(fact.event);
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
}
