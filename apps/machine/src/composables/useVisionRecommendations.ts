import type { VisionProfile } from "@vem/shared";
import type { Ref } from "vue";

import { computed, readonly, ref, onUnmounted, watch } from "vue";

import type { ScoredItem } from "@/types/catalog";

import {
  subscribeVisionProfiles,
  type VisionProfileResultPayload,
} from "@/native/vision";
import { computeRecommendations } from "@/recommendation/engine";
import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";

const PROFILE_EXPIRE_MS = 60_000;

export function useVisionRecommendations(): {
  recommendedItems: Readonly<Ref<readonly ScoredItem[]>>;
  currentProfile: Readonly<Ref<VisionProfile | null>>;
  lastVisionResult: Readonly<Ref<VisionProfileResultPayload | null>>;
} {
  const machineStore = useMachineStore();
  const catalogStore = useCatalogStore();

  const currentProfile = ref<VisionProfile | null>(null);
  const lastVisionResult = ref<VisionProfileResultPayload | null>(null);
  const recommendedItems = ref<readonly ScoredItem[]>([]);
  const availableItems = computed(() => catalogStore.availableItems);
  let expireTimer: ReturnType<typeof setTimeout> | null = null;

  function clearState(): void {
    currentProfile.value = null;
    lastVisionResult.value = null;
    recommendedItems.value = [];
    if (expireTimer !== null) {
      clearTimeout(expireTimer);
      expireTimer = null;
    }
  }

  function clearRecommendations(): void {
    currentProfile.value = null;
    recommendedItems.value = [];
  }

  function restartExpireTimer(): void {
    if (expireTimer !== null) {
      clearTimeout(expireTimer);
    }
    expireTimer = setTimeout(() => {
      clearState();
    }, PROFILE_EXPIRE_MS);
  }

  function recomputeRecommendations(): void {
    const profile = currentProfile.value;
    if (!profile) {
      recommendedItems.value = [];
      return;
    }
    recommendedItems.value = computeRecommendations(
      profile,
      availableItems.value,
    );
  }

  function handleProfile(payload: VisionProfileResultPayload): void {
    const profile = payload.profile;
    lastVisionResult.value = payload;
    restartExpireTimer();

    if (!profile.personPresent) {
      clearRecommendations();
      return;
    }

    if (profile.confidence !== undefined && profile.confidence < 0.5) {
      clearRecommendations();
      return;
    }

    currentProfile.value = profile;

    recomputeRecommendations();
  }

  const config = machineStore.config;

  // If vision is not enabled, skip subscription
  if (!config.visionEnabled) {
    return {
      recommendedItems: readonly(recommendedItems),
      currentProfile: readonly(currentProfile),
      lastVisionResult,
    };
  }

  const stopCatalogWatch = watch(availableItems, () => {
    recomputeRecommendations();
  });

  const subscription = subscribeVisionProfiles(config, {
    onProfile: handleProfile,
    onError: (error) => {
      console.warn("vision recommendation subscription failed", error);
    },
  });

  // Clean up on unmount
  onUnmounted(() => {
    subscription.close();
    stopCatalogWatch();
    clearState();
  });

  return {
    recommendedItems: readonly(recommendedItems),
    currentProfile: readonly(currentProfile),
    lastVisionResult,
  };
}
