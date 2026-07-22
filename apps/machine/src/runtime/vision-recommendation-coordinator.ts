import type { Pinia } from "pinia";

import { watch, type WatchStopHandle } from "vue";

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
  let subscription: ReturnType<typeof subscribeVisionProfiles> | null = null;
  let subscribedMachineCode: string | null = null;
  let subscriptionGeneration = 0;

  const connect = (machineCode: string): void => {
    const generation = ++subscriptionGeneration;
    const isCurrentSubscription = (): boolean =>
      generation === subscriptionGeneration &&
      machineStore.machineCode === machineCode;
    subscription = subscribeVisionProfiles(
      { machineCode },
      {
        onReady: (payload) => {
          if (!isCurrentSubscription()) return;
          visionStore.applyVisionReady(payload);
        },
        onPresenceStatus: (payload: VisionPresenceStatusPayload) => {
          if (!isCurrentSubscription()) return;
          visionStore.applyPresenceStatus(payload);
        },
        onPersonDeparted: (payload: VisionPersonDepartedPayload) => {
          if (!isCurrentSubscription()) return;
          visionStore.applyPersonDeparted(payload);
        },
        onProfile: (payload: VisionProfileResultPayload) => {
          if (!isCurrentSubscription()) return;
          visionStore.applyRecommendationProfileResult(payload);
        },
        onError: (error) => {
          if (!isCurrentSubscription()) return;
          if (isVisionTryOnCapabilityDegraded(error)) {
            visionStore.markTryOnCapabilityDegraded();
          }
          visionStore.clearRecommendationForVisionFailure();
        },
      },
    );
    subscribedMachineCode = machineCode;
  };

  const stopMachineCodeWatch: WatchStopHandle = watch(
    () => machineStore.machineCode,
    (machineCode) => {
      if (machineCode === subscribedMachineCode) return;
      subscriptionGeneration += 1;
      subscription?.close();
      subscription = null;
      subscribedMachineCode = null;
      visionStore.clearLatestDiagnosticPayload();
      if (machineCode) connect(machineCode);
    },
    { immediate: true, flush: "sync" },
  );
  const coordinator: VisionRecommendationCoordinator = {
    close: () => {
      if (coordinators.get(pinia) !== coordinator) return;
      stopMachineCodeWatch();
      subscriptionGeneration += 1;
      subscription?.close();
      subscription = null;
      coordinators.delete(pinia);
    },
  };
  coordinators.set(pinia, coordinator);
  return coordinator;
}
