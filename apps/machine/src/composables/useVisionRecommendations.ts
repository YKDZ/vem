import type { VisionProfile } from "@vem/shared";
import type { Ref } from "vue";

import { readonly, ref, onUnmounted } from "vue";

import {
  isVisionTryOnCapabilityDegraded,
  subscribeVisionProfiles,
  type VisionPersonDepartedPayload,
  type VisionPresenceStatusPayload,
  type VisionProfileResultPayload,
} from "@/native/vision";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

const PROFILE_EXPIRE_MS = 60_000;

export function useVisionRecommendations(): {
  currentProfile: Readonly<Ref<VisionProfile | null>>;
  lastVisionResult: Readonly<Ref<VisionProfileResultPayload | null>>;
} {
  const machineStore = useMachineStore();
  const visionStore = useVisionStore();

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
      source: payload.source,
      eventId: payload.eventId,
      detectedAt: payload.detectedAt,
      profile: recommendationProfile(payload.profile),
      quality: {
        overall: payload.quality.overall,
        warnings: [],
        profileUsable: payload.quality.profileUsable,
        notUsableReason: payload.quality.notUsableReason,
      },
    };
  }

  function handleProfile(payload: VisionProfileResultPayload): void {
    visionStore.applyLatestProfileResult(payload);
    const profile = recommendationProfile(payload.profile);
    lastVisionResult.value = recommendationResult(payload);
    restartExpireTimer();

    if (!profile.personPresent) {
      clearCurrentProfile();
      return;
    }

    if (!visionStore.canUseLatestProfileForRecommendation) {
      clearCurrentProfile();
      return;
    }

    if (profile.confidence !== undefined && profile.confidence < 0.5) {
      clearCurrentProfile();
      return;
    }

    currentProfile.value = profile;
  }

  function handlePresence(payload: VisionPresenceStatusPayload): void {
    visionStore.applyPresenceStatus(payload);
    if (!payload.personPresent) {
      clearCurrentProfile();
    }
  }

  function handlePersonDeparted(payload: VisionPersonDepartedPayload): void {
    visionStore.applyPersonDeparted(payload);
    clearCurrentProfile();
  }

  const subscription = subscribeVisionProfiles(
    { machineCode: machineStore.machineCode },
    {
      onReady: (payload) => {
        visionStore.applyVisionReady(payload);
      },
      onPresenceStatus: handlePresence,
      onPersonDeparted: handlePersonDeparted,
      onProfile: handleProfile,
      onError: (error) => {
        if (isVisionTryOnCapabilityDegraded(error)) {
          visionStore.markTryOnCapabilityDegraded();
        }
        clearState();
        visionStore.clearLatestDiagnosticPayload();
      },
    },
  );

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
