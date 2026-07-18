// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick } from "vue";

import type {
  VisionPersonDepartedPayload,
  VisionPresenceStatusPayload,
  VisionProfileResultPayload,
} from "@/native/vision";

import { useVisionStore } from "@/stores/vision";

const { subscribeVisionProfilesMock } = vi.hoisted(() => ({
  subscribeVisionProfilesMock: vi.fn(),
}));

vi.mock("@/native/vision", () => ({
  subscribeVisionProfiles: subscribeVisionProfilesMock,
  isVisionTryOnCapabilityDegraded: (error: unknown) =>
    error instanceof Error &&
    error.message.startsWith("vision try_on_unavailable:"),
}));

import { useVisionRecommendations } from "./useVisionRecommendations";

function profilePayload(
  eventId: string,
  confidence = 0.91,
): VisionProfileResultPayload {
  return {
    eventId,
    detectedAt: "2026-06-12T10:20:30.000Z",
    profile: {
      personPresent: true,
      heightCm: 172,
      bodyType: "regular",
      confidence,
    },
    quality: {
      overall: "good",
      warnings: [],
    },
  };
}

describe("useVisionRecommendations", () => {
  let host: HTMLDivElement;
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
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

    createApp(App).use(pinia).mount(host);
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
          ageRange: "adult",
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

  it("does not use multiple-person profile results for recommendations", async () => {
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
        return () => null;
      },
    });

    createApp(App).use(pinia).mount(host);
    await nextTick();
    const emitProfile = onProfile as unknown as (
      payload: VisionProfileResultPayload,
    ) => void | Promise<void>;

    await Promise.resolve(
      emitProfile({
        ...profilePayload("VISION-MULTIPLE-001"),
        occupancy: { state: "multiple", confidence: 0.93 },
        quality: {
          overall: "poor",
          warnings: ["multiple_people"],
          profileUsable: false,
          notUsableReason: "multiple_people",
        },
      }),
    );
    await nextTick();

    expect(captured.currentProfile?.value).toBeNull();
    expect(useVisionStore().isMultiplePeoplePresent).toBe(true);
    expect(useVisionStore().canUseLatestProfileForRecommendation).toBe(false);
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

    createApp(App).use(pinia).mount(host);
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
    expect(useVisionStore().latestDiagnosticPayload).toBeNull();
  });

  it("publishes explicit presence events without fabricating recommendation profiles", async () => {
    const captured: Partial<ReturnType<typeof useVisionRecommendations>> = {};
    let onPresenceStatus:
      | ((payload: VisionPresenceStatusPayload) => void | Promise<void>)
      | null = null;
    subscribeVisionProfilesMock.mockImplementation(
      (
        _config: unknown,
        handlers: {
          onPresenceStatus?: (
            payload: VisionPresenceStatusPayload,
          ) => void | Promise<void>;
        },
      ) => {
        onPresenceStatus = handlers.onPresenceStatus ?? null;
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

    createApp(App).use(pinia).mount(host);
    await nextTick();
    expect(onPresenceStatus).toBeTruthy();
    const emitPresenceStatus = onPresenceStatus as unknown as (
      payload: VisionPresenceStatusPayload,
    ) => void | Promise<void>;

    await Promise.resolve(
      emitPresenceStatus({
        eventId: "VISION-PRESENCE-EVENT-001",
        state: "approach",
        reason: "person_present_but_not_close",
        detectedAt: "2026-06-29T10:00:00.000Z",
        personPresent: true,
        closeNow: false,
        close: false,
        closeTrigger: null,
        proximity: { present: true, closeNow: false, close: false },
      }),
    );
    await nextTick();

    expect(captured.currentProfile?.value).toBeNull();
    expect(captured.lastVisionResult?.value).toBeNull();
    expect(useVisionStore().presence).toMatchObject({
      personPresent: true,
      occupancyState: "unknown",
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: null,
    });
  });

  it("clears recommendation profile when vision reports departure", async () => {
    const captured: Partial<ReturnType<typeof useVisionRecommendations>> = {};
    let onProfile:
      | ((payload: VisionProfileResultPayload) => void | Promise<void>)
      | null = null;
    let onPersonDeparted:
      | ((payload: VisionPersonDepartedPayload) => void | Promise<void>)
      | null = null;
    subscribeVisionProfilesMock.mockImplementation(
      (
        _config: unknown,
        handlers: {
          onProfile: (
            payload: VisionProfileResultPayload,
          ) => void | Promise<void>;
          onPersonDeparted?: (
            payload: VisionPersonDepartedPayload,
          ) => void | Promise<void>;
        },
      ) => {
        onProfile = handlers.onProfile;
        onPersonDeparted = handlers.onPersonDeparted ?? null;
        return { close: vi.fn() };
      },
    );
    const App = defineComponent({
      setup() {
        const recommendations = useVisionRecommendations();
        captured.currentProfile = recommendations.currentProfile;
        return () => null;
      },
    });

    createApp(App).use(pinia).mount(host);
    await nextTick();
    const emitProfile = onProfile as unknown as (
      payload: VisionProfileResultPayload,
    ) => void | Promise<void>;
    const emitPersonDeparted = onPersonDeparted as unknown as (
      payload: VisionPersonDepartedPayload,
    ) => void | Promise<void>;

    await Promise.resolve(emitProfile(profilePayload("VISION-PRESENT-001")));
    await nextTick();
    expect(captured.currentProfile?.value?.personPresent).toBe(true);

    await Promise.resolve(
      emitPersonDeparted({
        eventId: "VISION-DEPARTURE-001",
        detectedAt: "2026-06-29T10:05:00.000Z",
        lastSeenAt: "2026-06-29T10:04:55.000Z",
        reason: "left_frame",
      }),
    );
    await nextTick();

    expect(captured.currentProfile?.value).toBeNull();
    expect(useVisionStore().presence).toMatchObject({
      personPresent: false,
      occupancyState: "none",
      lastSeenAt: "2026-06-29T10:04:55.000Z",
      departedAt: "2026-06-29T10:05:00.000Z",
    });
  });

  it("publishes only the latest real profile result to the maintenance diagnostic store", async () => {
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
        useVisionRecommendations();
        return () => null;
      },
    });

    createApp(App).use(pinia).mount(host);
    await nextTick();
    expect(onProfile).toBeTruthy();
    const emitProfile = onProfile as unknown as (
      payload: VisionProfileResultPayload,
    ) => void | Promise<void>;

    await Promise.resolve(emitProfile(profilePayload("VISION-OLD-001", 0.7)));
    await Promise.resolve(emitProfile(profilePayload("VISION-LATEST-002")));
    await nextTick();

    const diagnosticPayload = JSON.stringify(
      useVisionStore().latestDiagnosticPayload,
    );
    expect(diagnosticPayload).toContain("VISION-LATEST-002");
    expect(diagnosticPayload).not.toContain("VISION-OLD-001");
  });

  it("subscribes through the daemon-owned runtime vision connection", async () => {
    useVisionStore().applyLatestProfileResult(
      profilePayload("VISION-STALE-DISABLED"),
    );
    const App = defineComponent({
      setup() {
        useVisionRecommendations();
        return () => null;
      },
    });

    createApp(App).use(pinia).mount(host);
    await nextTick();

    expect(subscribeVisionProfilesMock).toHaveBeenCalledTimes(1);
  });
});
