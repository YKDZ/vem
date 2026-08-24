import { defineStore } from "pinia";

import type { VisionProfileResultPayload } from "@/native/vision";

import {
  createImplicitRecommendationState,
  normalizeRecommendationSize,
  projectImplicitRecommendation,
  transitionImplicitRecommendation,
  type ImplicitRecommendationDiagnostic,
  type ImplicitRecommendationEvent,
  type RecommendationOccupancy,
} from "@/recommendation/implicit-recommendation-session";
import { installedMachineRuntimeTrace } from "@/router/transaction-route-authority";
import { useCatalogStore } from "@/stores/catalog";

export const useImplicitRecommendationStore = defineStore(
  "implicit-recommendation",
  {
    state: () => ({
      session: createImplicitRecommendationState(),
      liveProfileSequence: 0,
    }),
    getters: {
      projection: (state) =>
        projectImplicitRecommendation(
          state.session,
          useCatalogStore().availableItems,
        ),
    },
    actions: {
      observeStablePresence(input: {
        present: boolean;
        occupancy: RecommendationOccupancy;
        edgeId: string | null;
      }): void {
        this.applyEvent({
          type: "presence_observed",
          present: input.present,
          occupancy: input.occupancy,
          edgeId: input.edgeId,
          liveProfileSequence: this.liveProfileSequence,
        });
      },
      acceptLiveProfile(payload: VisionProfileResultPayload): void {
        this.liveProfileSequence += 1;
        this.applyEvent({
          type: "profile_received",
          sequence: this.liveProfileSequence,
          eventId: payload.eventId,
          usable: payload.quality.profileUsable,
          personPresent: payload.profile.personPresent,
          confidence: payload.profile.confidence,
          bodyType: payload.profile.bodyType,
          availableSizes: availableCanonicalSizes(),
        });
      },
      selectManualSize(catalogKey: string, size: string | null): void {
        this.applyEvent({ type: "manual_size_selected", catalogKey, size });
      },
      selectColor(catalogKey: string, color: string | null): void {
        this.applyEvent({ type: "color_selected", catalogKey, color });
      },
      acceptSuccessfulVend(transactionId: string): void {
        this.applyEvent({ type: "vend_succeeded", transactionId });
      },
      recordProjectedUnavailable(
        catalogKey: string,
        canonicalSize: "S" | "M" | "L",
      ): void {
        recordDiagnostics([
          {
            event: "projected_unavailable",
            sessionId: this.session.sessionId,
            catalogKey,
            canonicalSize,
          },
        ]);
      },
      resetRuntime(): void {
        this.liveProfileSequence = 0;
        this.applyEvent({ type: "runtime_reset" });
      },
      applyEvent(event: ImplicitRecommendationEvent): void {
        const transition = transitionImplicitRecommendation(
          this.session,
          event,
        );
        this.session = transition.state;
        recordDiagnostics(transition.diagnostics);
      },
    },
  },
);

function availableCanonicalSizes() {
  return [
    ...new Set(
      useCatalogStore().availableItems.flatMap((item) =>
        item.variantCandidates.flatMap((variant) => {
          if (
            variant.slotSalesState !== "sale_ready" ||
            variant.saleableStock <= 0
          ) {
            return [];
          }
          const size = normalizeRecommendationSize(variant.size);
          return size ? [size] : [];
        }),
      ),
    ),
  ];
}

function recordDiagnostics(
  diagnostics: readonly ImplicitRecommendationDiagnostic[],
): void {
  const trace = installedMachineRuntimeTrace();
  if (!trace) return;
  for (const diagnostic of diagnostics) {
    trace.record({
      type: "implicit_recommendation",
      event: diagnostic.event,
      sessionId: diagnostic.sessionId,
      catalogKey: diagnostic.catalogKey ?? null,
      profileEventId: diagnostic.profileEventId ?? null,
      canonicalSize: diagnostic.canonicalSize ?? null,
      latencyMs: diagnostic.event === "neutral_presented" ? 0 : null,
    });
  }
}
