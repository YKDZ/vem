import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VisionStatus } from "@/daemon/schemas";
import type { VisionProfileResultPayload } from "@/native/vision";

import { useVisionStore } from "./vision";

vi.mock("@/daemon/client", () => ({
  daemonClient: { getVisionStatus: vi.fn() },
}));

function status(
  latestDiagnosticPayload: unknown,
  overrides: Partial<VisionStatus> = {},
) {
  return {
    enabled: true,
    online: true,
    message: "vision ready",
    updatedAt: "2026-06-27T10:00:01.000Z",
    latestDiagnosticPayload,
    ...overrides,
  } as VisionStatus;
}

function ready(overrides: Record<string, unknown> = {}) {
  return {
    serverName: "vending-vision",
    serverVersion: "main",
    schemaVersion: "vem-vision-v2-contract-bundle/v1",
    bundleVersion: "1",
    contractDigest: "a".repeat(64),
    cameraReady: true,
    tryOnReady: true,
    visionBusinessReady: true,
    businessReadinessDiagnostic: "ready",
    capabilities: ["profile_push", "try_on"],
    ...overrides,
  };
}

function profile(personPresent = true): VisionProfileResultPayload {
  return {
    source: "front",
    eventId: `VISION-PROFILE-${personPresent ? "PRESENT" : "EMPTY"}`,
    detectedAt: "2026-06-27T10:00:00.000Z",
    occupancy: { state: personPresent ? "single" : "none", confidence: 0.88 },
    profile: { personPresent, confidence: 0.91, bodyType: "regular" },
    quality: { overall: "good", warnings: [], profileUsable: personPresent },
  };
}

describe("useVisionStore single-path readiness", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useRealTimers();
  });

  it("binds availability to the one ready capability rather than local flags", () => {
    const store = useVisionStore();
    store.applyVisionReady(ready());
    expect(store.tryOnReady).toBe(true);
    expect(store.tryOnCapability).toBe("available");

    store.applyVisionReady(ready({ capabilities: ["profile_push"] }));
    expect(store.tryOnReady).toBe(false);
    expect(store.tryOnCapability).toBe("degraded");

    store.applyVisionReady(ready({ visionBusinessReady: false }));
    expect(store.tryOnReady).toBe(false);
  });

  it("derives unavailable state from a V2 ready diagnostic and a try-on error", () => {
    const store = useVisionStore();
    store.applyStatus(status({ type: "vision.ready", payload: ready() }));
    expect(store.tryOnReady).toBe(true);

    store.applyStatus(
      status({
        type: "vision.error",
        payload: {
          code: "try_on_unavailable",
          message: "front camera unavailable",
          retryable: true,
        },
      }),
    );
    expect(store.isTryOnCapabilityDegraded).toBe(true);
    expect(store.tryOnReady).toBe(false);
  });

  it("clears readiness and customer-specific presence whenever Vision disconnects", () => {
    const store = useVisionStore();
    store.applyVisionReady(ready());
    store.applyLatestProfileResult(profile());
    expect(store.presence.personPresent).toBe(true);

    store.applyStatus(status(null, { online: false }));
    expect(store.tryOnReady).toBe(false);
    expect(store.visionBusinessReady).toBe(false);
    expect(store.presence.personPresent).toBe(false);
    expect(store.latestDiagnosticPayload).toBeNull();
  });
});

describe("useVisionStore presence behavior", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("keeps only the schema-sanitized diagnostic while projecting raw presence", () => {
    const store = useVisionStore();
    const unsanitizedProfile = {
      ...profile(),
      profile: {
        personPresent: true,
        heightCm: 172,
        bodyType: "regular",
        upperColor: "blue",
        confidence: 0.91,
        rawImageBase64: "not-retained",
        identity: { id: "customer-1" },
      },
    } as unknown as VisionProfileResultPayload;
    store.applyLatestProfileResult(unsanitizedProfile);
    expect(store.presence).toMatchObject({
      personPresent: true,
      occupancyState: "single",
    });
    expect(JSON.stringify(store.latestDiagnosticPayload)).not.toContain("raw");
    expect(JSON.stringify(store.latestDiagnosticPayload)).not.toContain(
      "identity",
    );

    store.applyPresenceStatus({
      source: "top",
      eventId: "VISION-PRESENCE-EMPTY",
      detectedAt: "2026-06-27T10:01:00.000Z",
      state: "empty",
      reason: "no_person",
      personPresent: false,
      occupancy: { state: "none", confidence: 0.9 },
      closeNow: false,
      close: false,
      closeTrigger: null,
      proximity: {},
    });
    expect(store.presence).toMatchObject({
      personPresent: false,
      occupancyState: "none",
    });
  });

  it("marks multiple people present but not usable for recommendation", () => {
    const store = useVisionStore();
    store.applyLatestProfileResult({
      ...profile(),
      occupancy: { state: "multiple", confidence: 0.92 },
      quality: {
        overall: "poor",
        warnings: ["multiple_people"],
        profileUsable: false,
        notUsableReason: "multiple_people",
      },
    });
    expect(store.isMultiplePeoplePresent).toBe(true);
  });
});
