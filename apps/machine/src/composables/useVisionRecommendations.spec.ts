// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick } from "vue";

import type { VisionProfileResultPayload } from "@/native/vision";

const { subscribeVisionProfilesMock } = vi.hoisted(() => ({
  subscribeVisionProfilesMock: vi.fn(),
}));

vi.mock("@/native/vision", () => ({
  subscribeVisionProfiles: subscribeVisionProfilesMock,
}));

import { useVisionRecommendations } from "./useVisionRecommendations";

describe("useVisionRecommendations", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    setActivePinia(createPinia());
    host = document.createElement("div");
    document.body.appendChild(host);
    subscribeVisionProfilesMock.mockReset();
    subscribeVisionProfilesMock.mockReturnValue({ close: vi.fn() });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps only the non-identifying recommendation signal in runtime state", async () => {
    const captured: Partial<ReturnType<typeof useVisionRecommendations>> = {};
    let onProfile:
      | ((payload: VisionProfileResultPayload) => void | Promise<void>)
      | null = null;
    subscribeVisionProfilesMock.mockImplementation(
      (
        _config: unknown,
        handlers: {
          onProfile: (
            payload: VisionProfileResultPayload,
          ) => void | Promise<void>;
        },
      ) => {
        onProfile = handlers.onProfile;
        return { close: vi.fn() };
      },
    );
    const App = defineComponent({
      setup() {
        const recommendations = useVisionRecommendations();
        captured.currentProfile = recommendations.currentProfile;
        captured.lastVisionResult = recommendations.lastVisionResult;
        return () => null;
      },
    });

    createApp(App).use(createPinia()).mount(host);
    await nextTick();
    expect(onProfile).toBeTruthy();
    const emitProfile = onProfile as unknown as (
      payload: VisionProfileResultPayload,
    ) => void | Promise<void>;
    await Promise.resolve(
      emitProfile({
        eventId: "vision-event-001",
        detectedAt: "2026-06-12T10:20:30.000Z",
        profile: {
          personPresent: true,
          heightCm: 172,
          shoulderWidthCm: 43,
          ageRange: "25-34",
          gender: "male",
          bodyType: "regular",
          upperColor: "blue",
          confidence: 0.91,
          rawImageBase64: "data:image/jpeg;base64,raw",
          faceEmbedding: [0.1, 0.2],
          identity: { id: "customer-1" },
        },
        quality: {
          overall: "good",
          warnings: ["light glare"],
        },
      } as VisionProfileResultPayload),
    );
    await nextTick();

    const currentProfile = captured.currentProfile;
    const lastVisionResult = captured.lastVisionResult;
    expect(currentProfile).toBeTruthy();
    expect(lastVisionResult).toBeTruthy();
    expect(JSON.stringify(currentProfile?.value)).toBe(
      JSON.stringify({
        personPresent: true,
        heightCm: 172,
        bodyType: "regular",
        upperColor: "blue",
        confidence: 0.91,
      }),
    );
    const serializedResult = JSON.stringify(lastVisionResult?.value);
    expect(serializedResult).not.toContain("raw");
    expect(serializedResult).not.toContain("ageRange");
    expect(serializedResult).not.toContain("gender");
    expect(serializedResult).not.toContain("identity");
    expect(serializedResult).not.toContain("faceEmbedding");
  });

  it("clears stale recommendation state when the subscription reports an error", async () => {
    const captured: Partial<ReturnType<typeof useVisionRecommendations>> = {};
    let onProfile:
      | ((payload: VisionProfileResultPayload) => void | Promise<void>)
      | null = null;
    let onError: ((error: Error) => void) | null = null;
    subscribeVisionProfilesMock.mockImplementation(
      (
        _config: unknown,
        handlers: {
          onProfile: (
            payload: VisionProfileResultPayload,
          ) => void | Promise<void>;
          onError: (error: Error) => void;
        },
      ) => {
        onProfile = handlers.onProfile;
        onError = handlers.onError;
        return { close: vi.fn() };
      },
    );
    const App = defineComponent({
      setup() {
        const recommendations = useVisionRecommendations();
        captured.currentProfile = recommendations.currentProfile;
        captured.lastVisionResult = recommendations.lastVisionResult;
        return () => null;
      },
    });

    createApp(App).use(createPinia()).mount(host);
    await nextTick();
    expect(onProfile).toBeTruthy();
    expect(onError).toBeTruthy();
    const emitProfile = onProfile as unknown as (
      payload: VisionProfileResultPayload,
    ) => void | Promise<void>;
    await Promise.resolve(
      emitProfile({
        eventId: "vision-event-001",
        detectedAt: "2026-06-12T10:20:30.000Z",
        profile: {
          personPresent: true,
          heightCm: 172,
          bodyType: "regular",
          confidence: 0.91,
        },
        quality: {
          overall: "good",
          warnings: [],
        },
      }),
    );
    await nextTick();
    expect(captured.currentProfile?.value).toEqual(
      expect.objectContaining({ personPresent: true }),
    );

    const emitError = onError as unknown as (error: Error) => void;
    emitError(new Error("vision camera_unavailable: camera unavailable"));
    await nextTick();

    expect(captured.currentProfile?.value).toBeNull();
    expect(captured.lastVisionResult?.value).toBeNull();
  });
});
