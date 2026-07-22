import type { VisionProfile } from "@vem/shared";
import type { Ref } from "vue";

import { storeToRefs } from "pinia";
import { onUnmounted } from "vue";

import {
  isVisionTryOnCapabilityDegraded,
  subscribeVisionProfiles,
  type VisionPersonDepartedPayload,
  type VisionPresenceStatusPayload,
  type VisionProfileResultPayload,
} from "@/native/vision";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

export function useVisionRecommendations(): {
  currentProfile: Readonly<Ref<VisionProfile | null>>;
  lastVisionResult: Readonly<Ref<VisionProfileResultPayload | null>>;
} {
  const machineStore = useMachineStore();
  const visionStore = useVisionStore();
  const { recommendationProfile, lastRecommendationResult } =
    storeToRefs(visionStore);

  const subscription = subscribeVisionProfiles(
    { machineCode: machineStore.machineCode },
    {
      onReady: (payload) => {
        visionStore.applyVisionReady(payload);
      },
      onPresenceStatus: (payload: VisionPresenceStatusPayload) => {
        visionStore.applyPresenceStatus(payload);
      },
      onPersonDeparted: (payload: VisionPersonDepartedPayload) => {
        visionStore.applyPersonDeparted(payload);
      },
      onProfile: (payload: VisionProfileResultPayload) => {
        visionStore.applyRecommendationProfileResult(payload);
      },
      onError: (error) => {
        if (isVisionTryOnCapabilityDegraded(error)) {
          visionStore.markTryOnCapabilityDegraded();
        }
        visionStore.clearRecommendationForVisionFailure();
      },
    },
  );

  // Clean up on unmount
  onUnmounted(() => {
    subscription.close();
  });

  return {
    currentProfile: recommendationProfile,
    lastVisionResult: lastRecommendationResult,
  };
}
