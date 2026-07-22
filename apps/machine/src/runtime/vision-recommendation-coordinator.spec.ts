// @vitest-environment jsdom
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VisionProfileResultPayload } from "@/native/vision";
import { useVisionStore } from "@/stores/vision";

const { subscribeVisionProfilesMock } = vi.hoisted(() => ({
  subscribeVisionProfilesMock: vi.fn(),
}));

vi.mock("@/native/vision", () => ({
  subscribeVisionProfiles: subscribeVisionProfilesMock,
  isVisionTryOnCapabilityDegraded: () => false,
}));

import {
  installVisionRecommendationCoordinator,
} from "./vision-recommendation-coordinator";

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

describe("Vision recommendation coordinator", () => {
  afterEach(() => vi.clearAllMocks());

  it("owns one app-level subscription and retains its profile across view navigation", () => {
    const pinia = createPinia();
    const onProfile: Array<(payload: VisionProfileResultPayload) => void> = [];
    subscribeVisionProfilesMock.mockImplementation(
      (_connection: unknown, handlers: { onProfile: (payload: VisionProfileResultPayload) => void }) => {
        onProfile.push(handlers.onProfile);
        return { close: vi.fn() };
      },
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
});
