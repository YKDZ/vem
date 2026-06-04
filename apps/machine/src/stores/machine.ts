import { defineStore } from "pinia";

import type { HealthSnapshot, ConfigSummary } from "@/daemon/schemas";

import {
  machineConfigDefaults,
  type MachineConfig,
} from "@/config/machine-config";
import { daemonClient } from "@/daemon/client";

type MachineState = {
  configSummary: ConfigSummary | null;
  configLoaded: boolean;
  health: HealthSnapshot | null;
  loading: boolean;
  error: string | null;
};

export const useMachineStore = defineStore("machine", {
  state: (): MachineState => ({
    configSummary: null,
    configLoaded: false,
    health: null,
    loading: false,
    error: null,
  }),
  getters: {
    config: (state): MachineConfig => {
      const publicConfig = state.configSummary?.public;
      const configSummary = state.configSummary;
      if (!publicConfig) {
        return {
          ...machineConfigDefaults,
          machineSecret: null,
          machineSecretConfigured: false,
          mqttSigningSecret: null,
          mqttSigningSecretConfigured: false,
          mqttPassword: null,
          mqttPasswordConfigured: false,
        };
      }
      return {
        ...machineConfigDefaults,
        ...publicConfig,
        machineSecret: null,
        machineSecretConfigured:
          configSummary?.machineSecretConfigured ?? false,
        mqttSigningSecret: null,
        mqttSigningSecretConfigured:
          configSummary?.mqttSigningSecretConfigured ?? false,
        mqttPassword: null,
        mqttPasswordConfigured: configSummary?.mqttPasswordConfigured ?? false,
      };
    },
    machineCode: (state): string | null =>
      state.configSummary?.public.machineCode ?? null,
    hardwareReady: (state): boolean => state.health?.hardwareOnline ?? false,
    canSell: (state): boolean =>
      state.health?.hardwareOnline === true &&
      (state.health.status === "healthy" || state.health.status === "degraded"),
    hasDeploymentConfig: (state): boolean =>
      Boolean(
        state.health?.configConfigured &&
        state.configSummary?.public.machineCode,
      ),
  },
  actions: {
    applyHealth(snapshot: HealthSnapshot): void {
      this.health = snapshot;
    },
    async loadConfig(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.configSummary = await daemonClient.getConfig();
        this.configLoaded = true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async saveConfig(config: MachineConfig): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.configSummary = await daemonClient.saveConfig({
          public: {
            machineCode: config.machineCode,
            apiBaseUrl: config.apiBaseUrl,
            mqttUrl: config.mqttUrl,
            mqttUsername: config.mqttUsername,
            hardwareAdapter: config.hardwareAdapter,
            serialPortPath: config.serialPortPath,
            lowerControllerUsbIdentity: config.lowerControllerUsbIdentity,
            scannerAdapter: config.scannerAdapter,
            scannerSerialPortPath: config.scannerSerialPortPath,
            scannerBaudRate: config.scannerBaudRate,
            scannerFrameSuffix: config.scannerFrameSuffix,
            visionEnabled: config.visionEnabled,
            visionWsUrl: config.visionWsUrl,
            visionAutoStart: config.visionAutoStart,
            visionProcessCommand: config.visionProcessCommand,
            visionProcessArgs: config.visionProcessArgs,
            visionRequestTimeoutMs: config.visionRequestTimeoutMs,
            kioskMode: config.kioskMode,
          },
          secrets: {
            machineSecret: config.machineSecret,
            mqttSigningSecret: config.mqttSigningSecret,
            mqttPassword: config.mqttPassword,
          },
        });
        this.configLoaded = true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});
