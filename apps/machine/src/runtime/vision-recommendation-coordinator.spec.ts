import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

// @vitest-environment jsdom
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import type { VisionProfileResultPayload } from "@/native/vision";

import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

const { subscribeVisionProfilesMock } = vi.hoisted(() => ({
  subscribeVisionProfilesMock: vi.fn(),
}));

vi.mock("@/native/vision", () => ({
  subscribeVisionProfiles: subscribeVisionProfilesMock,
  isVisionTryOnCapabilityDegraded: () => false,
}));

import { installVisionRecommendationCoordinator } from "./vision-recommendation-coordinator";

function profilePayload(eventId: string): VisionProfileResultPayload {
  return {
    source: "front",
    eventId,
    detectedAt: "2026-07-22T10:20:30.000Z",
    profile: {
      personPresent: true,
      heightCm: 172,
      bodyType: "regular",
      confidence: 0.91,
    },
    quality: { overall: "good", warnings: [], profileUsable: true },
  };
}

function runtimeConfiguration(
  machineCode: string,
): EffectiveMachineRuntimeConfiguration {
  return {
    machine: { code: machineCode },
  } as EffectiveMachineRuntimeConfiguration;
}

describe("Vision recommendation coordinator", () => {
  afterEach(() => vi.clearAllMocks());

  it("owns one app-level subscription and retains its profile across view navigation", () => {
    const pinia = createPinia();
    const onProfile: Array<(payload: VisionProfileResultPayload) => void> = [];
    subscribeVisionProfilesMock.mockImplementation(
      (
        _connection: unknown,
        handlers: { onProfile: (payload: VisionProfileResultPayload) => void },
      ) => {
        onProfile.push(handlers.onProfile);
        return { close: vi.fn() };
      },
    );

    const machineStore = useMachineStore(pinia);
    machineStore.applyEffectiveRuntimeConfiguration(
      runtimeConfiguration("MACHINE-ACCEPTED-01"),
    );
    const first = installVisionRecommendationCoordinator(pinia);
    const second = installVisionRecommendationCoordinator(pinia);

    expect(subscribeVisionProfilesMock).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    onProfile[0](profilePayload("recorded-video-profile-001"));
    expect(useVisionStore(pinia).recommendationProfile).toMatchObject({
      heightCm: 172,
    });
    expect(useVisionStore(pinia).lastRecommendationResult?.eventId).toBe(
      "recorded-video-profile-001",
    );

    // Views mount and unmount independently from this application coordinator.
    expect(subscribeVisionProfilesMock).toHaveBeenCalledOnce();
    first.close();
  });

  it("waits for an accepted machine identity and replaces its sole subscription when it changes", async () => {
    const pinia = createPinia();
    const firstSubscription = { close: vi.fn() };
    const secondSubscription = { close: vi.fn() };
    subscribeVisionProfilesMock
      .mockReturnValueOnce(firstSubscription)
      .mockReturnValueOnce(secondSubscription);

    const coordinator = installVisionRecommendationCoordinator(pinia);
    expect(subscribeVisionProfilesMock).not.toHaveBeenCalled();

    const machineStore = useMachineStore(pinia);
    machineStore.applyEffectiveRuntimeConfiguration(
      runtimeConfiguration("MACHINE-ACCEPTED-01"),
    );
    await nextTick();
    expect(subscribeVisionProfilesMock).toHaveBeenCalledTimes(1);
    expect(subscribeVisionProfilesMock).toHaveBeenLastCalledWith(
      { machineCode: "MACHINE-ACCEPTED-01" },
      expect.any(Object),
    );

    machineStore.applyEffectiveRuntimeConfiguration(
      runtimeConfiguration("MACHINE-ACCEPTED-01"),
    );
    await nextTick();
    expect(firstSubscription.close).not.toHaveBeenCalled();
    expect(subscribeVisionProfilesMock).toHaveBeenCalledTimes(1);

    machineStore.applyEffectiveRuntimeConfiguration(
      runtimeConfiguration("MACHINE-ACCEPTED-02"),
    );
    await nextTick();
    expect(firstSubscription.close).toHaveBeenCalledOnce();
    expect(subscribeVisionProfilesMock).toHaveBeenCalledTimes(2);
    expect(subscribeVisionProfilesMock).toHaveBeenLastCalledWith(
      { machineCode: "MACHINE-ACCEPTED-02" },
      expect.any(Object),
    );

    coordinator.close();
    expect(secondSubscription.close).toHaveBeenCalledOnce();
  });
});
