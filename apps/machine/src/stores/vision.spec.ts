import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VisionStatus } from "@/daemon/schemas";
import type {
  VisionPersonDepartedPayload,
  VisionPresenceStatusPayload,
  VisionProfileResultPayload,
} from "@/native/vision";

import { useVisionStore } from "./vision";

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getVisionStatus: vi.fn(),
  },
}));

function profilePayload(): VisionProfileResultPayload {
  return {
    eventId: "VISION-PRESENCE-001",
    detectedAt: "2026-06-27T10:00:00.000Z",
    occupancy: { state: "single", confidence: 0.88 },
    profile: { personPresent: true, confidence: 0.91 },
    quality: { overall: "good", warnings: [] },
  };
}

function presencePayload(personPresent = true): VisionPresenceStatusPayload {
  return {
    eventId: `VISION-PRESENCE-${personPresent ? "present" : "empty"}`,
    state: personPresent ? "approach" : "empty",
    reason: personPresent ? "person_present_but_not_close" : "no_person",
    detectedAt: "2026-06-29T10:00:00.000Z",
    personPresent,
    occupancy: {
      state: personPresent ? "single" : "none",
      confidence: 0.86,
    },
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: { present: personPresent, closeNow: false, close: false },
  };
}

function departurePayload(): VisionPersonDepartedPayload {
  return {
    eventId: "VISION-DEPARTURE-001",
    detectedAt: "2026-06-29T10:05:00.000Z",
    lastSeenAt: "2026-06-29T10:04:55.000Z",
    reason: "left_frame",
    absenceDurationMs: 1000,
  };
}

function visionStatus(
  latestDiagnosticPayload: unknown,
  overrides: Partial<VisionStatus> = {},
): VisionStatus {
  return {
    enabled: true,
    online: true,
    message: "vision ready",
    updatedAt: "2026-06-27T10:00:01.000Z",
    latestDiagnosticPayload,
    ...overrides,
  };
}

describe("useVisionStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("clears stale presence when daemon status no longer carries a profile result", () => {
    const visionStore = useVisionStore();
    visionStore.applyLatestProfileResult(profilePayload());
    expect(visionStore.presence.personPresent).toBe(true);

    visionStore.applyStatus(visionStatus(null));
    expect(visionStore.latestDiagnosticPayload).toBeNull();
    expect(visionStore.presence).toMatchObject({
      personPresent: false,
      occupancyState: "none",
      lastSeenAt: null,
      departedAt: null,
    });

    const errorDiagnostic = {
      type: "vision.error",
      payload: {
        code: "camera_unavailable",
        message: "camera unavailable",
        recoverable: true,
      },
    };
    visionStore.applyLatestProfileResult(profilePayload());
    visionStore.applyStatus(visionStatus(errorDiagnostic));
    expect(visionStore.latestDiagnosticPayload).toEqual(errorDiagnostic);
    expect(visionStore.presence.personPresent).toBe(false);

    const disabledDiagnostic = {
      type: "vision.disabled",
      payload: { reason: "disabled by config" },
    };
    visionStore.applyLatestProfileResult(profilePayload());
    visionStore.applyStatus(
      visionStatus(disabledDiagnostic, {
        enabled: false,
        online: false,
        message: "vision disabled",
      }),
    );
    expect(visionStore.latestDiagnosticPayload).toBeNull();
    expect(visionStore.presence.personPresent).toBe(false);
  });

  it("applies explicit presence status diagnostics without requiring a profile result", () => {
    const visionStore = useVisionStore();

    visionStore.applyPresenceStatus(presencePayload(true));
    expect(visionStore.latestDiagnosticPayload).toEqual({
      type: "vision.presence_status",
      payload: presencePayload(true),
    });
    expect(visionStore.presence).toMatchObject({
      personPresent: true,
      occupancyState: "single",
      occupancyConfidence: 0.86,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: null,
      source: "presence_status",
    });
    expect(visionStore.isSinglePersonPresent).toBe(true);

    visionStore.applyStatus(
      visionStatus({
        type: "vision.presence_status",
        payload: presencePayload(false),
      }),
    );
    expect(visionStore.presence).toMatchObject({
      personPresent: false,
      occupancyState: "none",
      lastSeenAt: "2026-06-29T10:00:00.000Z",
      departedAt: null,
    });
  });

  it("applies explicit person departed diagnostics", () => {
    const visionStore = useVisionStore();

    visionStore.applyPresenceStatus(presencePayload(true));
    visionStore.applyPersonDeparted(departurePayload());

    expect(visionStore.latestDiagnosticPayload).toEqual({
      type: "vision.person_departed",
      payload: departurePayload(),
    });
    expect(visionStore.presence).toMatchObject({
      personPresent: false,
      occupancyState: "none",
      profileUsable: false,
      lastSeenAt: "2026-06-29T10:04:55.000Z",
      departedAt: "2026-06-29T10:05:00.000Z",
      source: "person_departed",
    });
  });

  it("exposes multiple-person occupancy as present but profile-unusable", () => {
    const visionStore = useVisionStore();

    visionStore.applyLatestProfileResult({
      ...profilePayload(),
      occupancy: { state: "multiple", confidence: 0.92 },
      quality: {
        overall: "poor",
        warnings: ["multiple_people"],
        profileUsable: false,
        notUsableReason: "multiple_people",
      },
    });

    expect(visionStore.presence).toMatchObject({
      personPresent: true,
      occupancyState: "multiple",
      occupancyConfidence: 0.92,
      profileUsable: false,
      profileNotUsableReason: "multiple_people",
    });
    expect(visionStore.isMultiplePeoplePresent).toBe(true);
    expect(visionStore.canUseLatestProfileForRecommendation).toBe(false);
  });

  it("keeps old presence messages compatible by mapping present occupancy to unknown", () => {
    const visionStore = useVisionStore();
    const legacyPayload = {
      ...presencePayload(true),
      occupancy: undefined,
    };

    visionStore.applyPresenceStatus(legacyPayload);

    expect(visionStore.presence).toMatchObject({
      personPresent: true,
      occupancyState: "unknown",
      occupancyConfidence: null,
    });
  });

  it("degrades try-on only when its ready capability or error reports it unavailable", () => {
    const visionStore = useVisionStore();

    visionStore.applyStatus(
      visionStatus({
        type: "vision.ready",
        payload: {
          serverName: "vending-vision",
          serverVersion: "main",
          cameraReady: true,
          modelReady: false,
          capabilities: ["profile_push", "try_on_session"],
        },
      }),
    );
    expect(visionStore.isTryOnCapabilityDegraded).toBe(false);

    visionStore.applyStatus(
      visionStatus(
        {
          type: "vision.error",
          payload: {
            code: "model_not_ready",
            message: "profile model warming up",
            retryable: true,
          },
        },
        { online: false },
      ),
    );
    expect(visionStore.isTryOnCapabilityDegraded).toBe(false);

    visionStore.applyStatus(
      visionStatus({
        type: "vision.error",
        payload: {
          code: "try_on_unavailable",
          message: "front camera unavailable",
          retryable: true,
        },
      }),
    );
    expect(visionStore.isTryOnCapabilityDegraded).toBe(true);
  });

  it("clears available or unknown try-on state whenever Vision becomes disabled", () => {
    const visionStore = useVisionStore();
    visionStore.applyVisionReady({
      serverName: "vending-vision",
      serverVersion: "main",
      cameraReady: true,
      modelReady: true,
      capabilities: ["profile_push", "try_on_session"],
    });
    visionStore.applyPresenceStatus(presencePayload(true));

    visionStore.applyStatus(
      visionStatus(null, {
        enabled: false,
        online: false,
        message: "vision disabled",
      }),
    );

    expect(visionStore.tryOnCapability).toBe("degraded");
    expect(visionStore.latestDiagnosticPayload).toBeNull();
    expect(visionStore.presence.personPresent).toBe(false);

    visionStore.$reset();
    visionStore.applyStatus(
      visionStatus(
        {
          type: "vision.ready",
          payload: {
            serverName: "vending-vision",
            serverVersion: "main",
            cameraReady: true,
            modelReady: true,
            capabilities: ["profile_push", "try_on_session"],
          },
        },
        {
          enabled: false,
          online: false,
          message: "vision disabled",
        },
      ),
    );

    expect(visionStore.tryOnCapability).toBe("degraded");
    expect(visionStore.latestDiagnosticPayload).toBeNull();
  });
});
