import { defineStore } from "pinia";

import type { SyncStatus } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

export const useMqttStore = defineStore("mqtt", {
  state: () => ({
    sync: null as SyncStatus | null,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    status: (state): string => {
      if (!state.sync) return "unknown";
      if (state.sync.mqttConnected) return "connected";
      if (state.sync.mqttRunning) return "connecting";
      return "disconnected";
    },
    connected: (state): boolean => state.sync?.mqttConnected ?? false,
    lastCommandNo: (state): string | null => state.sync?.lastCommandNo ?? null,
    outboxSize: (state): number => state.sync?.outboxSize ?? 0,
    outboxUsageRatio: (state): number => state.sync?.outboxUsage ?? 0,
    outboxWarning: (state): string | null =>
      (state.sync?.outboxUsage ?? 0) >= 0.9
        ? `daemon outbox 已使用 ${state.sync?.outboxSize ?? 0}/${state.sync?.outboxMax ?? 0}`
        : null,
    lastHeartbeatAt: (state): string | null =>
      state.sync?.lastHeartbeatAt ?? null,
    lastError: (state): string | null => state.sync?.lastError ?? state.error,
  },
  actions: {
    applySync(snapshot: SyncStatus): void {
      this.sync = snapshot;
      this.error = null;
    },
    applyMqttEvent(input: {
      connected: boolean;
      updatedAt: string;
      lastError: string | null;
    }): void {
      if (!this.sync) return;
      this.sync = {
        ...this.sync,
        mqttConnected: input.connected,
        lastError: input.lastError,
        lastHeartbeatAt: this.sync.lastHeartbeatAt ?? input.updatedAt,
      };
    },
    async refresh(): Promise<void> {
      this.loading = true;
      try {
        this.applySync(await daemonClient.getSyncStatus());
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});
