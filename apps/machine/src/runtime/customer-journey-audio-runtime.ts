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
import { getCustomerInteractionSession } from "@/composables/customer-interaction-session";
import { getStableVisionPresenceSession } from "@/composables/stable-vision-presence-session";
import {
  createCustomerJourneyTransitionProjector,
  type CustomerJourneyFacts,
} from "@/customer-journey/transition-projector";
import { daemonClient } from "@/daemon/client";
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
    const session = getCustomerInteractionSession();
    const stableVisionSession = getStableVisionPresenceSession();
    let submittedStableVentEdgeId: string | null = null;

    watch(
      () =>
        customerJourneyFacts({
          checkoutStore,
          customerJourneyStore,
          session,
          stableVisionSession,
        }),
      (facts) => {
        void coordinator.accept(projector.project(facts));
      },
      { immediate: true, flush: "sync" },
    );
    watch(
      () => ({
        edge: stableVisionSession.state.value.edge,
        edgeId: stableVisionSession.state.value.edgeId,
      }),
      ({ edge, edgeId }) => {
        if (!edge || !edgeId) return;
        if (submittedStableVentEdgeId === edgeId) return;
        submittedStableVentEdgeId = edgeId;
        const ventSpeed = edge === "arrival" ? 2 : 0;
        // Presence experience must remain responsive when the daemon or lower
        // controller cannot accept this optional environmental intent.
        void daemonClient
          .submitAutomaticVentIntent({ edgeId, ventSpeed })
          .catch(() => undefined);
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
  session: ReturnType<typeof getCustomerInteractionSession>;
  stableVisionSession: ReturnType<typeof getStableVisionPresenceSession>;
}): CustomerJourneyFacts {
  const selectedItem = input.checkoutStore.selectedItem;
  const transaction = input.checkoutStore.transaction;
  const categoryEntry = input.customerJourneyStore.categoryEntry;
  const pickupReminder = transaction?.vending?.pickupReminder ?? null;
  const customerSession = input.session.state.value;
  const stableVision = input.stableVisionSession.state.value;

  return {
    touchscreen: {
      personPresent: customerSession.active,
      source: "local_interaction",
      lastInteractionAt: customerSession.lastInteractionAt,
    },
    vision:
      stableVision.edgeId !== null
        ? {
            personPresent: stableVision.present,
            occupancyState: stableVision.occupancyState,
            lastSeenAt: stableVision.lastSeenAt,
            departedAt: stableVision.departedAt,
            lastChangedAt: stableVision.present
              ? stableVision.lastSeenAt
              : stableVision.departedAt,
            edge: stableVision.edge,
            edgeId: stableVision.edgeId,
            restored: stableVision.restored,
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
