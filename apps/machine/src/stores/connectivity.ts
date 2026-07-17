import { defineStore } from "pinia";

import type {
  HealthSnapshot,
  ReadySnapshot,
  UnknownDaemonEvent,
} from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

export type UnknownDaemonEventDiagnostic = {
  type: string;
  eventId: string;
  updatedAt: string;
  recordedAt: string;
  metadata: unknown;
  diagnostics: unknown;
  diagnostic: unknown;
};

type ConnectivityState = {
  health: HealthSnapshot | null;
  ready: ReadySnapshot | null;
  latestUnknownEventDiagnostic: UnknownDaemonEventDiagnostic | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  lastCheckedAt: string | null;
};

export const useConnectivityStore = defineStore("connectivity", {
  state: (): ConnectivityState => ({
    health: null,
    ready: null,
    latestUnknownEventDiagnostic: null,
    loading: false,
    stale: false,
    error: null,
    lastCheckedAt: null,
  }),
  getters: {
    networkLabel: (state): string => {
      if (state.loading) return "检测中";
      if (!state.health) return "未连接";
      if (!state.health.backendOnline) return "后端离线";
      if (!state.health.mqttConnected) return "MQTT 未就绪";
      return "在线";
    },
  },
  actions: {
    applyHealth(snapshot: HealthSnapshot): void {
      this.health = snapshot;
      this.lastCheckedAt = snapshot.updatedAt;
      this.error = null;
      this.stale = false;
    },
    applyReady(snapshot: ReadySnapshot): void {
      this.ready = snapshot;
      this.error = null;
      this.stale = false;
    },
    async refresh(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const [health, ready] = await Promise.all([
          daemonClient.getHealth(),
          daemonClient.getReady(),
        ]);
        this.applyHealth(health);
        this.applyReady(ready);
      } catch (error) {
        this.stale = true;
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    markStale(error?: unknown): void {
      this.stale = true;
      this.error =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "daemon events disconnected";
    },
    recordUnknownEvent(event: UnknownDaemonEvent): void {
      const eventRecord = event as Record<string, unknown>;
      this.latestUnknownEventDiagnostic = {
        type: event.type,
        eventId: event.eventId,
        updatedAt: event.updatedAt,
        recordedAt: new Date().toISOString(),
        metadata: eventRecord.metadata ?? null,
        diagnostics: eventRecord.diagnostics ?? null,
        diagnostic: eventRecord.diagnostic ?? null,
      };
    },
  },
});
