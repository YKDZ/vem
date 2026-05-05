import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";

import { getHealth, type HealthStatus } from "@/api/health";
import { createMachineApiClient } from "@/api/request";

export const useConnectivityStore = defineStore("connectivity", {
  state: () => ({
    backendOnline: false,
    mqttStatus: "disconnected" as HealthStatus["mqtt"],
    lastCheckedAt: null as number | null,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    networkLabel: (state): string => {
      if (state.loading) return "检测中";
      if (!state.backendOnline) return "后端离线";
      return state.mqttStatus === "connected" ? "在线" : "MQTT 未连接";
    },
    isSaleNetworkReady: (state): boolean =>
      state.backendOnline && state.mqttStatus === "connected",
  },
  actions: {
    async checkBackend(config: MachineConfig): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const health = await getHealth(client);
        this.backendOnline = health.database === "ok";
        this.mqttStatus = health.mqtt;
        this.lastCheckedAt = Date.now();
      } catch (error) {
        this.backendOnline = false;
        this.mqttStatus = "disconnected";
        this.lastCheckedAt = Date.now();
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
      }
    },
  },
});
