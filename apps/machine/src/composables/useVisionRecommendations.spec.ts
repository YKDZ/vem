// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useVisionStore } from "@/stores/vision";

import { useVisionRecommendations } from "./useVisionRecommendations";

describe("useVisionRecommendations", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("only exposes the application-owned Vision store state", () => {
    const visionStore = useVisionStore();
    visionStore.applyRecommendationProfileResult({
      source: "front",
      eventId: "recorded-video-profile-001",
      detectedAt: "2026-07-22T10:20:30.000Z",
      profile: {
        personPresent: true,
        heightCm: 172,
        bodyType: "regular",
        confidence: 0.91,
      },
      quality: { overall: "good", warnings: [], profileUsable: true },
    });

    const recommendations = useVisionRecommendations();

    expect(recommendations.currentProfile.value?.heightCm).toBe(172);
    expect(recommendations.lastVisionResult.value?.eventId).toBe(
      "recorded-video-profile-001",
    );
  });
});
