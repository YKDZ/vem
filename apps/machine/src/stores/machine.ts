import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { defineStore } from "pinia";

import type { HealthSnapshot, ConfigSummary } from "@/daemon/schemas";

import {
  machineConfigDefaults,
  type MachineConfig,
} from "@/config/machine-config";
import { daemonClient } from "@/daemon/client";
import { useAudioCueStore } from "@/stores/audio-cues";

type MachineState = {
  configSummary: ConfigSummary | null;
  effectiveRuntimeConfiguration: EffectiveMachineRuntimeConfiguration | null;
  configLoaded: boolean;
  health: HealthSnapshot | null;
  loading: boolean;
  error: string | null;
};

export const useMachineStore = defineStore("machine", {
  state: (): MachineState => ({
    configSummary: null,
    effectiveRuntimeConfiguration: null,
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
          maintenancePinConfigured: false,
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
        maintenancePinConfigured:
          configSummary?.maintenancePinConfigured ?? false,
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
    applyConfigSummary(summary: ConfigSummary): void {
      this.configSummary = summary;
      applyRuntimeAudioCueSettings(summary);
      this.configLoaded = true;
    },
    applyEffectiveRuntimeConfiguration(
      configuration: EffectiveMachineRuntimeConfiguration,
    ): void {
      this.effectiveRuntimeConfiguration = configuration;
    },
    async loadConfig(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.applyConfigSummary(await daemonClient.getConfig());
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async loadEffectiveRuntimeConfiguration(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.applyEffectiveRuntimeConfiguration(
          await daemonClient.getEffectiveRuntimeConfiguration(),
        );
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});

function applyRuntimeAudioCueSettings(configSummary: ConfigSummary): void {
  useAudioCueStore().applySettings(configSummary.public.audioCueSettings);
}
