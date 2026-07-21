import type { Pinia } from "pinia";

import { effectScope, watch } from "vue";

import type { MachineRuntimeTrace } from "@/runtime/machine-runtime-trace";

import {
  createCustomerJourneyAudioCoordinator,
  type AudioCoordinator,
} from "@/audio-coordinator/audio-coordinator";
import {
  mapCustomerJourneyAudioPresentation,
  type CustomerAudioPresentationContext,
} from "@/audio-coordinator/customer-audio-presentation";
import { getCustomerPresenceSession } from "@/composables/usePresenceInteraction";
import {
  createCustomerJourneyTransitionProjector,
  type CustomerJourneyFacts,
} from "@/customer-journey/transition-projector";
import { useCheckoutStore } from "@/stores/checkout";
import { useCustomerJourneyStore } from "@/stores/customer-journey";
import { useMachineStore } from "@/stores/machine";
import { useNaturalContextStore } from "@/stores/natural-context";

export type CustomerJourneyAudioRuntime = {
  requestTestPlayback(
    sourceUrl: string,
    volume: number,
  ): Promise<string | null>;
  trace: AudioCoordinator["trace"];
  dispose(): Promise<void>;
};

export function createCustomerJourneyAudioRuntime(
  pinia: Pinia,
  trace?: MachineRuntimeTrace,
): CustomerJourneyAudioRuntime {
  const scope = effectScope();
  const projector = createCustomerJourneyTransitionProjector();
  const coordinator = createCustomerJourneyAudioCoordinator({
    preferences: () => useMachineStore(pinia).customerAudio,
    mapTransition: (transition) =>
      mapCustomerJourneyAudioPresentation(
        transition,
        presentationContext(useNaturalContextStore(pinia)),
      ),
    trace,
  });

  scope.run(() => {
    const checkoutStore = useCheckoutStore(pinia);
    const customerJourneyStore = useCustomerJourneyStore(pinia);
    const session = getCustomerPresenceSession();

    watch(
      () =>
        customerJourneyFacts({
          checkoutStore,
          customerJourneyStore,
          session,
        }),
      (facts) => {
        void coordinator.accept(projector.project(facts));
      },
      { immediate: true, flush: "sync" },
    );
    watch(
      () => useMachineStore(pinia).customerAudio,
      () => {
        void coordinator.refreshPreferences();
      },
    );
  });

  return {
    async requestTestPlayback(sourceUrl, volume) {
      return await coordinator.requestTestPlayback(sourceUrl, volume);
    },
    trace: () => coordinator.trace(),
    async dispose(): Promise<void> {
      scope.stop();
      await coordinator.dispose();
    },
  };
}

function customerJourneyFacts(input: {
  checkoutStore: ReturnType<typeof useCheckoutStore>;
  customerJourneyStore: ReturnType<typeof useCustomerJourneyStore>;
  session: ReturnType<typeof getCustomerPresenceSession>;
}): CustomerJourneyFacts {
  const selectedItem = input.checkoutStore.selectedItem;
  const transaction = input.checkoutStore.transaction;
  const categoryEntry = input.customerJourneyStore.categoryEntry;
  const pickupReminder = transaction?.vending?.pickupReminder ?? null;
  const customerSession = input.session.state.value;

  return {
    touchscreen: {
      personPresent: customerSession.personPresent,
      source: customerSession.source,
      lastInteractionAt: customerSession.lastInteractionAt,
    },
    vision:
      customerSession.source === "vision"
        ? {
            personPresent: customerSession.personPresent,
            occupancyState: customerSession.occupancyState,
            lastSeenAt: customerSession.lastSeenAt,
            departedAt: customerSession.departedAt,
            lastChangedAt: customerSession.personPresent
              ? customerSession.lastSeenAt
              : customerSession.departedAt,
          }
        : null,
    categoryEntry: categoryEntry
      ? {
          entryId: categoryEntry.entryId,
          category: categoryEntry.category,
          enteredAt: categoryEntry.enteredAt,
        }
      : null,
    selectedProduct:
      selectedItem && input.checkoutStore.checkoutAttemptIdempotencyKey
        ? {
            selectionId: input.checkoutStore.checkoutAttemptIdempotencyKey,
            productId: selectedItem.catalogKey,
            category: selectedItem.categoryName,
            selectedAt: null,
          }
        : null,
    transaction: transaction
      ? {
          orderNo: transaction.orderNo,
          nextAction: transaction.nextAction,
          updatedAt: transaction.updatedAt,
          vending: transaction.vending
            ? {
                status: transaction.vending.status,
                pickupReminder: pickupReminder
                  ? {
                      stage: pickupReminder.stage,
                      level: pickupReminder.level,
                      warningNo: pickupReminder.warningNo,
                      reportedAt: pickupReminder.reportedAt,
                    }
                  : null,
              }
            : null,
          restored: input.checkoutStore.lastTransactionRestored,
        }
      : null,
  };
}

function presentationContext(
  naturalContextStore: ReturnType<typeof useNaturalContextStore>,
): CustomerAudioPresentationContext {
  return {
    primaryFestival: naturalContextStore.primaryFestival,
    solarTerm: naturalContextStore.solarTerm,
    temperatureCelsius: naturalContextStore.temperatureCelsius,
    weatherConditionClasses: naturalContextStore.weatherConditionClasses,
  };
}
