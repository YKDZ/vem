import type { Pinia } from "pinia";

import { effectScope, watch } from "vue";

import {
  createAudioCoordinator,
  type AudioCoordinator,
} from "@/audio-coordinator/audio-coordinator";
import {
  mapCustomerJourneyAudioPresentation,
  type CustomerAudioPresentationContext,
} from "@/audio-coordinator/customer-audio-presentation";
import {
  createBrowserMachineAudioPlaybackDriver,
  createTauriNativeMachineAudioPlaybackDriver,
} from "@/audio-playback/machine-audio-playback";
import { getCustomerPresenceSession } from "@/composables/usePresenceInteraction";
import {
  createCustomerJourneyTransitionProjector,
  type CustomerJourneyFacts,
} from "@/customer-journey/transition-projector";
import { useCheckoutStore } from "@/stores/checkout";
import { useMachineStore } from "@/stores/machine";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useVisionStore } from "@/stores/vision";
import type { MachineRuntimeTrace } from "@/runtime/machine-runtime-trace";

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
  const coordinator = createAudioCoordinator({
    driver:
      createTauriNativeMachineAudioPlaybackDriver() ??
      createBrowserMachineAudioPlaybackDriver(),
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
    const visionStore = useVisionStore(pinia);
    const session = getCustomerPresenceSession();

    watch(
      () =>
        customerJourneyFacts({
          checkoutStore,
          visionStore,
          session,
        }),
      (facts) => {
        void coordinator.accept(projector.project(facts));
      },
      { immediate: true, flush: "sync" },
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
  visionStore: ReturnType<typeof useVisionStore>;
  session: ReturnType<typeof getCustomerPresenceSession>;
}): CustomerJourneyFacts {
  const selectedItem = input.checkoutStore.selectedItem;
  const transaction = input.checkoutStore.transaction;
  const pickupReminder = transaction?.vending?.pickupReminder ?? null;
  const presence = input.visionStore.presence;
  const customerSession = input.session.state.value;

  return {
    touchscreen: {
      personPresent: customerSession.personPresent,
      source: customerSession.source,
      lastInteractionAt: customerSession.lastInteractionAt,
    },
    vision: {
      personPresent: presence.personPresent,
      occupancyState: presence.occupancyState,
      lastSeenAt: presence.lastSeenAt,
      departedAt: presence.departedAt,
      lastChangedAt: presence.lastChangedAt,
      restored: presence.restoredFromRefresh,
    },
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
