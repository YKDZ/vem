import {
  type VisionPresenceOccupancyState,
  type VisionProfileNotUsableReason,
  visionErrorPayloadSchema,
  visionPresenceStatusPayloadSchema,
  visionPersonDepartedPayloadSchema,
  visionProfileResultPayloadSchema,
  visionReadyPayloadSchema,
} from "@vem/shared";
import { defineStore } from "pinia";

import type { VisionStatus } from "@/daemon/schemas";
import type {
  VisionPresenceStatusPayload,
  VisionPersonDepartedPayload,
  VisionProfileResultPayload,
} from "@/native/vision";

import { daemonClient } from "@/daemon/client";

type VisionDiagnosticPayload = {
  type: "vision.profile_result";
  payload: VisionProfileResultPayload;
};

type VisionPresenceStatusDiagnosticPayload = {
  type: "vision.presence_status";
  payload: VisionPresenceStatusPayload;
};

type VisionPersonDepartedDiagnosticPayload = {
  type: "vision.person_departed";
  payload: VisionPersonDepartedPayload;
};

type VisionTryOnCapability = "unknown" | "available" | "degraded";

type VisionPresenceState = {
  personPresent: boolean;
  occupancyState: VisionPresenceOccupancyState;
  occupancyConfidence: number | null;
  profileUsable: boolean;
  profileNotUsableReason: VisionProfileNotUsableReason | null;
  lastSeenAt: string | null;
  departedAt: string | null;
  lastChangedAt: string | null;
  source: "profile_result" | "presence_status" | "person_departed" | null;
  restoredFromRefresh: boolean;
};

const PROFILE_CONFIDENCE_THRESHOLD = 0.5;

const EMPTY_PRESENCE: VisionPresenceState = {
  personPresent: false,
  occupancyState: "none",
  occupancyConfidence: null,
  profileUsable: false,
  profileNotUsableReason: null,
  lastSeenAt: null,
  departedAt: null,
  lastChangedAt: null,
  source: null,
  restoredFromRefresh: false,
};

export const useVisionStore = defineStore("vision", {
  state: () => ({
    enabled: false,
    online: false,
    message: "等待 daemon 状态",
    updatedAt: null as string | null,
    latestDiagnosticPayload: null as unknown,
    tryOnCapability: "unknown" as VisionTryOnCapability,
    presence: { ...EMPTY_PRESENCE } as VisionPresenceState,
  }),
  getters: {
    isSinglePersonPresent: (state): boolean =>
      state.presence.personPresent &&
      state.presence.occupancyState === "single",
    isMultiplePeoplePresent: (state): boolean =>
      state.presence.personPresent &&
      state.presence.occupancyState === "multiple",
    canUseLatestProfileForRecommendation: (state): boolean =>
      state.presence.personPresent &&
      state.presence.profileUsable &&
      state.presence.occupancyState !== "multiple",
    isTryOnCapabilityDegraded: (state): boolean =>
      state.tryOnCapability === "degraded",
  },
  actions: {
    applyStatus(
      status: VisionStatus,
      options: { restoredFromRefresh?: boolean } = {},
    ): void {
      this.enabled = status.enabled;
      this.online = status.online;
      this.message = status.message;
      this.updatedAt = status.updatedAt ?? new Date().toISOString();
      if (status.latestDiagnosticPayload !== undefined) {
        this.latestDiagnosticPayload = status.latestDiagnosticPayload;
        this.applyTryOnCapabilityFromDiagnostic(this.latestDiagnosticPayload);
        this.applyPresenceFromDiagnostic(this.latestDiagnosticPayload, options);
        return;
      }
      if (!status.enabled) {
        this.tryOnCapability = "degraded";
      }
      if (!status.enabled || !status.online) {
        this.clearLatestDiagnosticPayload();
      }
    },
    applyLatestProfileResult(payload: VisionProfileResultPayload): void {
      this.latestDiagnosticPayload = {
        type: "vision.profile_result",
        payload: visionProfileResultPayloadSchema.parse(payload),
      } satisfies VisionDiagnosticPayload;
      this.enabled = true;
      this.online = true;
      this.updatedAt = new Date().toISOString();
      this.applyPresenceFromProfileResult(payload);
    },
    applyPresenceStatus(payload: VisionPresenceStatusPayload): void {
      const parsed = visionPresenceStatusPayloadSchema.parse(payload);
      this.latestDiagnosticPayload = {
        type: "vision.presence_status",
        payload: parsed,
      } satisfies VisionPresenceStatusDiagnosticPayload;
      this.enabled = true;
      this.online = true;
      this.updatedAt = new Date().toISOString();
      this.applyPresenceFromPresenceStatus(parsed);
    },
    applyPersonDeparted(payload: VisionPersonDepartedPayload): void {
      const parsed = visionPersonDepartedPayloadSchema.parse(payload);
      this.latestDiagnosticPayload = {
        type: "vision.person_departed",
        payload: parsed,
      } satisfies VisionPersonDepartedDiagnosticPayload;
      this.enabled = true;
      this.online = true;
      this.updatedAt = new Date().toISOString();
      this.applyPresenceFromPersonDeparted(parsed);
    },
    applyVisionReady(payload: unknown): void {
      const result = visionReadyPayloadSchema.safeParse(payload);
      if (!result.success) return;
      this.tryOnCapability =
        result.data.cameraReady &&
        result.data.capabilities.includes("try_on_session")
          ? "available"
          : "degraded";
    },
    markTryOnCapabilityDegraded(): void {
      this.tryOnCapability = "degraded";
    },
    clearLatestDiagnosticPayload(): void {
      this.latestDiagnosticPayload = null;
      this.presence = { ...EMPTY_PRESENCE };
    },
    applyTryOnCapabilityFromDiagnostic(value: unknown): void {
      if (isVisionReadyDiagnostic(value)) {
        this.applyVisionReady(value.payload);
        return;
      }
      if (isVisionTryOnUnavailableDiagnostic(value)) {
        this.markTryOnCapabilityDegraded();
      }
    },
    applyPresenceFromDiagnostic(
      value: unknown,
      options: { restoredFromRefresh?: boolean } = {},
    ): void {
      const profileDiagnostic = parseProfileResultDiagnostic(value);
      if (profileDiagnostic) {
        this.applyPresenceFromProfileResult(profileDiagnostic.payload);
        this.presence.restoredFromRefresh =
          options.restoredFromRefresh === true;
        return;
      }
      const presenceDiagnostic = parsePresenceStatusDiagnostic(value);
      if (presenceDiagnostic) {
        this.applyPresenceFromPresenceStatus(presenceDiagnostic.payload);
        this.presence.restoredFromRefresh =
          options.restoredFromRefresh === true;
        return;
      }
      const departureDiagnostic = parsePersonDepartedDiagnostic(value);
      if (departureDiagnostic) {
        this.applyPresenceFromPersonDeparted(departureDiagnostic.payload);
        this.presence.restoredFromRefresh =
          options.restoredFromRefresh === true;
        return;
      }
      this.presence = { ...EMPTY_PRESENCE };
    },
    applyPresenceFromProfileResult(payload: VisionProfileResultPayload): void {
      const personPresent = payload.profile.personPresent;
      const occupancy = normalizeOccupancy(payload.occupancy, personPresent);
      const profileUsable = profileResultUsable(payload, occupancy.state);
      this.presence = {
        personPresent,
        occupancyState: occupancy.state,
        occupancyConfidence: occupancy.confidence,
        profileUsable,
        profileNotUsableReason:
          payload.quality.notUsableReason ??
          (profileUsable
            ? null
            : profileNotUsableReason(payload, occupancy.state)),
        lastSeenAt: personPresent
          ? payload.detectedAt
          : this.presence.lastSeenAt,
        departedAt: personPresent ? null : this.presence.departedAt,
        lastChangedAt: payload.detectedAt,
        source: "profile_result",
        restoredFromRefresh: false,
      };
    },
    applyPresenceFromPresenceStatus(
      payload: VisionPresenceStatusPayload,
    ): void {
      const personPresent = payload.personPresent;
      const occupancy = normalizeOccupancy(payload.occupancy, personPresent);
      this.presence = {
        personPresent,
        occupancyState: occupancy.state,
        occupancyConfidence: occupancy.confidence,
        profileUsable: presenceStatusProfileUsable(
          this.presence.profileUsable,
          personPresent,
          occupancy.state,
        ),
        profileNotUsableReason: presenceStatusProfileNotUsableReason(
          this.presence.profileNotUsableReason,
          personPresent,
          occupancy.state,
        ),
        lastSeenAt: personPresent
          ? payload.detectedAt
          : this.presence.lastSeenAt,
        departedAt: personPresent ? null : this.presence.departedAt,
        lastChangedAt: payload.detectedAt,
        source: "presence_status",
        restoredFromRefresh: false,
      };
    },
    applyPresenceFromPersonDeparted(
      payload: VisionPersonDepartedPayload,
    ): void {
      this.presence = {
        personPresent: false,
        occupancyState: "none",
        occupancyConfidence: null,
        profileUsable: false,
        profileNotUsableReason: null,
        lastSeenAt: payload.lastSeenAt ?? this.presence.lastSeenAt,
        departedAt: payload.detectedAt,
        lastChangedAt: payload.detectedAt,
        source: "person_departed",
        restoredFromRefresh: false,
      };
    },
    async refresh(): Promise<void> {
      this.applyStatus(await daemonClient.getVisionStatus(), {
        restoredFromRefresh: true,
      });
    },
  },
});

function normalizeOccupancy(
  occupancy: VisionPresenceStatusPayload["occupancy"] | undefined,
  personPresent: boolean,
): { state: VisionPresenceOccupancyState; confidence: number | null } {
  if (occupancy) {
    return {
      state: occupancy.state,
      confidence: occupancy.confidence ?? null,
    };
  }
  return {
    state: personPresent ? "unknown" : "none",
    confidence: null,
  };
}

function profileResultUsable(
  payload: VisionProfileResultPayload,
  occupancyState: VisionPresenceOccupancyState,
): boolean {
  if (!payload.profile.personPresent) return false;
  if (occupancyState === "multiple") return false;
  if (
    payload.profile.confidence !== undefined &&
    payload.profile.confidence < PROFILE_CONFIDENCE_THRESHOLD
  ) {
    return false;
  }
  if (payload.quality.profileUsable === false) return false;
  return true;
}

function profileNotUsableReason(
  payload: VisionProfileResultPayload,
  occupancyState: VisionPresenceOccupancyState,
): VisionProfileNotUsableReason | null {
  if (occupancyState === "multiple") return "multiple_people";
  if (!payload.profile.personPresent) return "no_person";
  if (
    payload.profile.confidence !== undefined &&
    payload.profile.confidence < PROFILE_CONFIDENCE_THRESHOLD
  ) {
    return "low_confidence";
  }
  if (payload.quality.profileUsable === false) return "unknown";
  return null;
}

function presenceStatusProfileUsable(
  current: boolean,
  personPresent: boolean,
  occupancyState: VisionPresenceOccupancyState,
): boolean {
  if (!personPresent) return false;
  if (occupancyState === "multiple") return false;
  return current;
}

function presenceStatusProfileNotUsableReason(
  current: VisionProfileNotUsableReason | null,
  personPresent: boolean,
  occupancyState: VisionPresenceOccupancyState,
): VisionProfileNotUsableReason | null {
  if (!personPresent) return null;
  if (occupancyState === "multiple") return "multiple_people";
  return current === "multiple_people" ? null : current;
}

function parseProfileResultDiagnostic(
  value: unknown,
): VisionDiagnosticPayload | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "vision.profile_result" &&
    "payload" in value
  ) {
    const result = visionProfileResultPayloadSchema.safeParse(value.payload);
    if (result.success) {
      return {
        type: "vision.profile_result",
        payload: result.data,
      };
    }
  }
  return null;
}

function isVisionReadyDiagnostic(
  value: unknown,
): value is { type: "vision.ready"; payload: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "vision.ready" &&
    "payload" in value
  );
}

function isVisionTryOnUnavailableDiagnostic(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "vision.error" ||
    !("payload" in value)
  ) {
    return false;
  }
  const result = visionErrorPayloadSchema.safeParse(value.payload);
  return result.success && result.data.code === "try_on_unavailable";
}

function parsePresenceStatusDiagnostic(
  value: unknown,
): VisionPresenceStatusDiagnosticPayload | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "vision.presence_status" &&
    "payload" in value
  ) {
    const result = visionPresenceStatusPayloadSchema.safeParse(value.payload);
    if (result.success) {
      return {
        type: "vision.presence_status",
        payload: result.data,
      };
    }
  }
  return null;
}

function parsePersonDepartedDiagnostic(
  value: unknown,
): VisionPersonDepartedDiagnosticPayload | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "vision.person_departed" &&
    "payload" in value
  ) {
    const result = visionPersonDepartedPayloadSchema.safeParse(value.payload);
    if (result.success) {
      return {
        type: "vision.person_departed",
        payload: result.data,
      };
    }
  }
  return null;
}
