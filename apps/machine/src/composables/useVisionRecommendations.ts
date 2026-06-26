import type { VisionProfile } from "@vem/shared";
import type { Ref } from "vue";

import { readonly, ref, onUnmounted } from "vue";

import {
  subscribeVisionProfiles,
  type VisionProfileResultPayload,
} from "@/native/vision";
import { useMachineStore } from "@/stores/machine";

const PROFILE_EXPIRE_MS = 60_000;

export function useVisionRecommendations(): {
  currentProfile: Readonly<Ref<VisionProfile | null>>;
  lastVisionResult: Readonly<Ref<VisionProfileResultPayload | null>>;
} {
  const machineStore = useMachineStore();

  const currentProfile = ref<VisionProfile | null>(null);
  const lastVisionResult = ref<VisionProfileResultPayload | null>(null);
  let expireTimer: ReturnType<typeof setTimeout> | null = null;

  function clearState(): void {
    currentProfile.value = null;
    lastVisionResult.value = null;
    if (expireTimer !== null) {
      clearTimeout(expireTimer);
      expireTimer = null;
    }
  }

  function clearCurrentProfile(): void {
    currentProfile.value = null;
  }

  function restartExpireTimer(): void {
    if (expireTimer !== null) {
      clearTimeout(expireTimer);
    }
    expireTimer = setTimeout(() => {
      clearState();
    }, PROFILE_EXPIRE_MS);
  }

  function recommendationProfile(profile: VisionProfile): VisionProfile {
    return {
      personPresent: profile.personPresent,
      heightCm: profile.heightCm ?? undefined,
      bodyType: profile.bodyType,
      upperColor: profile.upperColor,
      confidence: profile.confidence,
    };
  }

  function recommendationResult(
    payload: VisionProfileResultPayload,
  ): VisionProfileResultPayload {
    return {
      eventId: payload.eventId,
      detectedAt: payload.detectedAt,
      profile: recommendationProfile(payload.profile),
      quality: {
        overall: payload.quality.overall,
        warnings: [],
      },
    };
  }

  function handleProfile(payload: VisionProfileResultPayload): void {
    const profile = recommendationProfile(payload.profile);
    lastVisionResult.value = recommendationResult(payload);
    restartExpireTimer();

    if (!profile.personPresent) {
      clearCurrentProfile();
      return;
    }

    if (profile.confidence !== undefined && profile.confidence < 0.5) {
      clearCurrentProfile();
      return;
    }

    currentProfile.value = profile;
  }

  const config = machineStore.config;

  // If vision is not enabled, skip subscription
  if (!config.visionEnabled) {
    return {
      currentProfile: readonly(currentProfile),
      lastVisionResult,
    };
  }

  const subscription = subscribeVisionProfiles(config, {
    onProfile: handleProfile,
    onError: (error) => {
      console.warn("vision profile subscription failed", error);
      clearState();
    },
  });

  // Clean up on unmount
  onUnmounted(() => {
    subscription.close();
    clearState();
  });

  return {
    currentProfile: readonly(currentProfile),
    lastVisionResult,
  };
}
