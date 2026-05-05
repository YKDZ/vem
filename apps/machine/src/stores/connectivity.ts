import { defineStore } from "pinia";

import type { MachineConfig } from "@/config/machine-config";

import { getHealth, type HealthStatus } from "@/api/health";
import { createMachineApiClient } from "@/api/request";

export const useConnectivityStore = defineStore("connectivity", {
  state: () => ({
    backendOnline: false,
    backendMqttStatus: "disconnected" as HealthStatus["mqtt"],
    machineMqttConnected: false,
    lastCheckedAt: null as number | null,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    networkLabel: (state): string => {
      if (state.loading) return "检测中";
      if (!state.backendOnline) return "后端离线";
      if (state.backendMqttStatus !== "connected") return "后端 MQTT 未连接";
      if (!state.machineMqttConnected) return "机器 MQTT 未连接";
      return "在线";
    },
    isSaleNetworkReady: (state): boolean =>
      state.backendOnline &&
      state.backendMqttStatus === "connected" &&
      state.machineMqttConnected,
  },
  actions: {
    setMachineMqttConnected(connected: boolean): void {
      this.machineMqttConnected = connected;
    },
    async checkBackend(config: MachineConfig): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const client = createMachineApiClient(config.apiBaseUrl);
        const health = await getHealth(client);
        this.backendOnline = health.database === "ok";
        this.backendMqttStatus = health.mqtt;
        this.lastCheckedAt = Date.now();
      } catch (error) {
        this.backendOnline = false;
        this.backendMqttStatus = "disconnected";
        this.machineMqttConnected = false;
        this.lastCheckedAt = Date.now();
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
      }
    },
  },
});
