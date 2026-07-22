import type { Ref } from "vue";

import { storeToRefs } from "pinia";
import type { VisionProfile } from "@vem/shared";

import type { VisionProfileResultPayload } from "@/native/vision";
import { useVisionStore } from "@/stores/vision";

export function useVisionRecommendations(): {
  currentProfile: Readonly<Ref<VisionProfile | null>>;
  lastVisionResult: Readonly<Ref<VisionProfileResultPayload | null>>;
} {
  const visionStore = useVisionStore();
  const { recommendationProfile, lastRecommendationResult } =
    storeToRefs(visionStore);

  return {
    currentProfile: recommendationProfile,
    lastVisionResult: lastRecommendationResult,
  };
}
