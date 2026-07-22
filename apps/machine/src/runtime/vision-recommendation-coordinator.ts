import type { Pinia } from "pinia";

import {
  isVisionTryOnCapabilityDegraded,
  subscribeVisionProfiles,
  type VisionPersonDepartedPayload,
  type VisionPresenceStatusPayload,
  type VisionProfileResultPayload,
} from "@/native/vision";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

export type VisionRecommendationCoordinator = {
  close: () => void;
};

const coordinators = new WeakMap<Pinia, VisionRecommendationCoordinator>();

export function installVisionRecommendationCoordinator(
  pinia: Pinia,
): VisionRecommendationCoordinator {
  const existing = coordinators.get(pinia);
  if (existing) return existing;

  const machineStore = useMachineStore(pinia);
  const visionStore = useVisionStore(pinia);
  const subscription = subscribeVisionProfiles(
    { machineCode: machineStore.machineCode },
    {
      onReady: (payload) => visionStore.applyVisionReady(payload),
      onPresenceStatus: (payload: VisionPresenceStatusPayload) =>
        visionStore.applyPresenceStatus(payload),
      onPersonDeparted: (payload: VisionPersonDepartedPayload) =>
        visionStore.applyPersonDeparted(payload),
      onProfile: (payload: VisionProfileResultPayload) =>
        visionStore.applyRecommendationProfileResult(payload),
      onError: (error) => {
        if (isVisionTryOnCapabilityDegraded(error)) {
          visionStore.markTryOnCapabilityDegraded();
        }
        visionStore.clearRecommendationForVisionFailure();
      },
    },
  );
  const coordinator: VisionRecommendationCoordinator = {
    close: () => {
      if (coordinators.get(pinia) !== coordinator) return;
      subscription.close();
      coordinators.delete(pinia);
    },
  };
  coordinators.set(pinia, coordinator);
  return coordinator;
}
