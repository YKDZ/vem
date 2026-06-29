import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VisionStatus } from "@/daemon/schemas";
import type {
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
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: { present: personPresent, closeNow: false, close: false },
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
    expect(visionStore.presence).toEqual({
      personPresent: false,
      lastSeenAt: null,
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
    expect(visionStore.latestDiagnosticPayload).toEqual(disabledDiagnostic);
    expect(visionStore.presence.personPresent).toBe(false);
  });

  it("applies explicit presence status diagnostics without requiring a profile result", () => {
    const visionStore = useVisionStore();

    visionStore.applyPresenceStatus(presencePayload(true));
    expect(visionStore.latestDiagnosticPayload).toEqual({
      type: "vision.presence_status",
      payload: presencePayload(true),
    });
    expect(visionStore.presence).toEqual({
      personPresent: true,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
    });

    visionStore.applyStatus(
      visionStatus({
        type: "vision.presence_status",
        payload: presencePayload(false),
      }),
    );
    expect(visionStore.presence).toEqual({
      personPresent: false,
      lastSeenAt: "2026-06-29T10:00:00.000Z",
    });
  });
});
