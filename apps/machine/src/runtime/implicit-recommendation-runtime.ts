import { getActivePinia, type Pinia } from "pinia";
import { watch, type WatchStopHandle } from "vue";

import { getStableVisionPresenceSession } from "@/composables/stable-vision-presence-session";
import { useCheckoutStore } from "@/stores/checkout";
import { useImplicitRecommendationStore } from "@/stores/implicit-recommendation";

export type ImplicitRecommendationRuntime = {
  close(): void;
};

const runtimes = new WeakMap<Pinia, ImplicitRecommendationRuntime>();

export function installImplicitRecommendationRuntime(
  pinia: Pinia = requireActivePinia(),
): ImplicitRecommendationRuntime {
  const existing = runtimes.get(pinia);
  if (existing) return existing;

  const recommendationStore = useImplicitRecommendationStore(pinia);
  const checkoutStore = useCheckoutStore(pinia);
  const stablePresence = getStableVisionPresenceSession(pinia);
  let lastSuccessfulVendId: string | null = null;
  let unavailableProjectionSessionId: string | null = null;
  const recordedUnavailableProjections = new Set<string>();

  const stops: WatchStopHandle[] = [
    watch(
      stablePresence.state,
      (presence) => {
        recommendationStore.observeStablePresence({
          present: presence.present,
          occupancy: presence.occupancyState,
          edgeId: presence.edgeId,
        });
      },
      { immediate: true, flush: "sync" },
    ),
    watch(
      () => ({
        orderNo: checkoutStore.transaction?.orderNo ?? null,
        commandId: checkoutStore.transaction?.vending?.commandId ?? null,
        vendingStatus: checkoutStore.transaction?.vending?.status ?? null,
      }),
      ({ orderNo, commandId, vendingStatus }) => {
        if (vendingStatus !== "succeeded") return;
        const vendId = commandId ?? orderNo;
        if (!vendId || vendId === lastSuccessfulVendId) return;
        lastSuccessfulVendId = vendId;
        recommendationStore.acceptSuccessfulVend(vendId);
      },
      { immediate: true, flush: "sync" },
    ),
    watch(
      () => recommendationStore.projection,
      (projection) => {
        if (projection.sessionId !== unavailableProjectionSessionId) {
          unavailableProjectionSessionId = projection.sessionId;
          recordedUnavailableProjections.clear();
        }
        if (!projection.sessionId) return;
        for (const [catalogKey, product] of Object.entries(
          projection.products,
        )) {
          if (!product.unavailableCanonicalSize) continue;
          const diagnosticKey = `${catalogKey}:${product.unavailableCanonicalSize}`;
          if (recordedUnavailableProjections.has(diagnosticKey)) continue;
          recordedUnavailableProjections.add(diagnosticKey);
          recommendationStore.recordProjectedUnavailable(
            catalogKey,
            product.unavailableCanonicalSize,
          );
        }
      },
      { immediate: true, flush: "sync" },
    ),
  ];

  const runtime: ImplicitRecommendationRuntime = {
    close() {
      if (runtimes.get(pinia) !== runtime) return;
      for (const stop of stops) stop();
      recommendationStore.resetRuntime();
      runtimes.delete(pinia);
    },
  };
  runtimes.set(pinia, runtime);
  return runtime;
}

function requireActivePinia(): Pinia {
  const pinia = getActivePinia();
  if (!pinia) {
    throw new Error("Implicit recommendation runtime requires active Pinia");
  }
  return pinia;
}
