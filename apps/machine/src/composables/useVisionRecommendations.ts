import type { VisionProfile } from "@vem/shared";
import type { Ref } from "vue";

import { readonly, ref, onUnmounted } from "vue";

import type { ScoredItem } from "@/types/catalog";

import { subscribeVisionProfiles } from "@/native/vision";
import { computeRecommendations } from "@/recommendation/engine";
import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";

const PROFILE_EXPIRE_MS = 60_000;

export function useVisionRecommendations(): {
  recommendedItems: Readonly<Ref<readonly ScoredItem[]>>;
  currentProfile: Readonly<Ref<VisionProfile | null>>;
} {
  const machineStore = useMachineStore();
  const catalogStore = useCatalogStore();

  const currentProfile = ref<VisionProfile | null>(null);
  const recommendedItems = ref<readonly ScoredItem[]>([]);
  let expireTimer: ReturnType<typeof setTimeout> | null = null;

  function clearState(): void {
    currentProfile.value = null;
    recommendedItems.value = [];
    if (expireTimer !== null) {
      clearTimeout(expireTimer);
      expireTimer = null;
    }
  }

  function handleProfile(payload: { profile: VisionProfile }): void {
    const profile = payload.profile;

    // personPresent=false → treat as no profile
    if (!profile.personPresent) {
      clearState();
      return;
    }

    // Low confidence → ignore this update
    if (profile.confidence !== undefined && profile.confidence < 0.5) {
      return;
    }

    // Update profile and reset timer
    currentProfile.value = profile;

    if (expireTimer !== null) {
      clearTimeout(expireTimer);
    }
    expireTimer = setTimeout(() => {
      clearState();
    }, PROFILE_EXPIRE_MS);

    // Compute recommendations
    recommendedItems.value = computeRecommendations(
      profile,
      catalogStore.availableItems,
    );
  }

  const config = machineStore.config;

  // If vision is not enabled, skip subscription
  if (!config.visionEnabled) {
    return {
      recommendedItems: readonly(recommendedItems),
      currentProfile: readonly(currentProfile),
    };
  }

  const subscription = subscribeVisionProfiles(config, {
    onProfile: handleProfile,
  });

  // Clean up on unmount
  onUnmounted(() => {
    subscription.close();
    clearState();
  });

  return {
    recommendedItems: readonly(recommendedItems),
    currentProfile: readonly(currentProfile),
  };
}
