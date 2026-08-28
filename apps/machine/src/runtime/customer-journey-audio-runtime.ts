import type { EnvironmentControlActionKind } from "@vem/shared";
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

const ENVIRONMENT_ACTION_SUBMIT_RETRY_DELAY_MS = 250;
const ENVIRONMENT_ACTION_SUBMIT_MAX_ATTEMPTS = 3;

export type CustomerJourneyAudioRuntime = {
  acceptPickupProgress(input: {
    eventId: string;
    orderNo: string;
    stage:
      | "outlet_opened"
      | "pickup_waiting"
      | "pickup_completed"
      | "pickup_timeout_warning"
      | "reset_completed";
    warningNo: number | null;
    reportedAt: string;
  }): Promise<void>;
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
  let disposed = false;
  let environmentActionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let latestStableEnvironmentEdgeId: string | null = null;
  // The daemon deduplicates environment actions by action id forever. A plain
  // per-load edge id (presence-1:arrival) would collide with every historical
  // admission after any UI restart, silently swallowing the stable-presence
  // vent policy. Bind each runtime session to one fresh nonce instead; the
  // daemon still deduplicates transport retries of the same edge within this
  // session.
  const environmentActionSessionNonce =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `env-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
    let submittedStableEnvironmentEdgeId: string | null = null;

    const submitStableEnvironmentAction = (
      edgeId: string,
      action: EnvironmentControlActionKind,
      attempt: number,
    ): void => {
      void daemonClient
        .submitEnvironmentControlAction({
          actionId: `${environmentActionSessionNonce}:${edgeId}`,
          source: "stable_presence",
          action,
        })
        .catch(() => {
          if (
            disposed ||
            latestStableEnvironmentEdgeId !== edgeId ||
            attempt + 1 >= ENVIRONMENT_ACTION_SUBMIT_MAX_ATTEMPTS
          ) {
            return;
          }
          environmentActionRetryTimer = setTimeout(() => {
            environmentActionRetryTimer = null;
            if (latestStableEnvironmentEdgeId === edgeId) {
              submitStableEnvironmentAction(edgeId, action, attempt + 1);
            }
          }, ENVIRONMENT_ACTION_SUBMIT_RETRY_DELAY_MS);
        });
    };

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
        if (submittedStableEnvironmentEdgeId === edgeId) return;
        submittedStableEnvironmentEdgeId = edgeId;
        latestStableEnvironmentEdgeId = edgeId;
        if (environmentActionRetryTimer !== null) {
          clearTimeout(environmentActionRetryTimer);
          environmentActionRetryTimer = null;
        }
        const action: EnvironmentControlActionKind =
          edge === "arrival"
            ? { type: "restore_base_vent_speed" }
            : { type: "temporarily_stop_vent" };
        // The daemon deduplicates this stable edge as a domain action. A
        // transport retry never becomes another customer-presence fact.
        submitStableEnvironmentAction(edgeId, action, 0);
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
    async acceptPickupProgress(input): Promise<void> {
      if (disposed) return;
      await coordinator.accept(projector.project({ pickupProgress: [input] }));
    },
    async requestTestPlayback(sourceUrl, volume) {
      return await coordinator.requestTestPlayback(sourceUrl, volume);
    },
    trace: () => coordinator.trace(),
    async dispose(): Promise<void> {
      disposed = true;
      if (environmentActionRetryTimer !== null) {
        clearTimeout(environmentActionRetryTimer);
        environmentActionRetryTimer = null;
      }
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
