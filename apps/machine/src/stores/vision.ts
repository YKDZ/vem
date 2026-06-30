import {
  visionPresenceStatusPayloadSchema,
  visionPersonDepartedPayloadSchema,
  visionProfileResultPayloadSchema,
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

type VisionPresenceState = {
  personPresent: boolean;
  lastSeenAt: string | null;
  departedAt: string | null;
};

export const useVisionStore = defineStore("vision", {
  state: () => ({
    enabled: false,
    online: false,
    message: "等待 daemon 状态",
    updatedAt: null as string | null,
    latestDiagnosticPayload: null as unknown,
    presence: {
      personPresent: false,
      lastSeenAt: null,
      departedAt: null,
    } as VisionPresenceState,
  }),
  actions: {
    applyStatus(status: VisionStatus): void {
      this.enabled = status.enabled;
      this.online = status.online;
      this.message = status.message;
      this.updatedAt = status.updatedAt ?? new Date().toISOString();
      if (status.latestDiagnosticPayload !== undefined) {
        this.latestDiagnosticPayload = status.latestDiagnosticPayload;
        this.applyPresenceFromDiagnostic(this.latestDiagnosticPayload);
        return;
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
    clearLatestDiagnosticPayload(): void {
      this.latestDiagnosticPayload = null;
      this.presence = {
        personPresent: false,
        lastSeenAt: null,
        departedAt: null,
      };
    },
    applyPresenceFromDiagnostic(value: unknown): void {
      const profileDiagnostic = parseProfileResultDiagnostic(value);
      if (profileDiagnostic) {
        this.applyPresenceFromProfileResult(profileDiagnostic.payload);
        return;
      }
      const presenceDiagnostic = parsePresenceStatusDiagnostic(value);
      if (presenceDiagnostic) {
        this.applyPresenceFromPresenceStatus(presenceDiagnostic.payload);
        return;
      }
      const departureDiagnostic = parsePersonDepartedDiagnostic(value);
      if (departureDiagnostic) {
        this.applyPresenceFromPersonDeparted(departureDiagnostic.payload);
        return;
      }
      this.presence = {
        personPresent: false,
        lastSeenAt: null,
        departedAt: null,
      };
    },
    applyPresenceFromProfileResult(payload: VisionProfileResultPayload): void {
      const personPresent = payload.profile.personPresent;
      this.presence = {
        personPresent,
        lastSeenAt: personPresent
          ? payload.detectedAt
          : this.presence.lastSeenAt,
        departedAt: personPresent ? null : this.presence.departedAt,
      };
    },
    applyPresenceFromPresenceStatus(
      payload: VisionPresenceStatusPayload,
    ): void {
      const personPresent = payload.personPresent;
      this.presence = {
        personPresent,
        lastSeenAt: personPresent
          ? payload.detectedAt
          : this.presence.lastSeenAt,
        departedAt: personPresent ? null : this.presence.departedAt,
      };
    },
    applyPresenceFromPersonDeparted(
      payload: VisionPersonDepartedPayload,
    ): void {
      this.presence = {
        personPresent: false,
        lastSeenAt: payload.lastSeenAt ?? this.presence.lastSeenAt,
        departedAt: payload.detectedAt,
      };
    },
    async refresh(): Promise<void> {
      this.applyStatus(await daemonClient.getVisionStatus());
    },
  },
});

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
