import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import { defineStore } from "pinia";

import type { HealthSnapshot } from "@/daemon/schemas";
import { daemonClient } from "@/daemon/client";
import { useAudioCueStore } from "@/stores/audio-cues";

type MachineState = {
  effectiveRuntimeConfiguration: EffectiveMachineRuntimeConfiguration | null;
  configLoaded: boolean;
  health: HealthSnapshot | null;
  loading: boolean;
  error: string | null;
};

const defaultAudioPreferences: EffectiveMachineRuntimeConfiguration["experience"]["audio"] =
  {
    volume: 0.7,
    cuesEnabled: false,
    presenceCuesEnabled: false,
    transactionCuesEnabled: false,
  };

export const useMachineStore = defineStore("machine", {
  state: (): MachineState => ({
    effectiveRuntimeConfiguration: null,
    configLoaded: false,
    health: null,
    loading: false,
    error: null,
  }),
  getters: {
    machineCode: (state): string | null =>
      state.effectiveRuntimeConfiguration?.machine?.code ?? null,
    platformApiBaseUrl: (state): string | null =>
      state.effectiveRuntimeConfiguration?.platform?.apiBaseUrl ?? null,
    hardwareReady: (state): boolean => state.health?.hardwareOnline ?? false,
    canSell: (state): boolean =>
      state.health?.hardwareOnline === true &&
      (state.health.status === "healthy" || state.health.status === "degraded"),
    hasDeploymentConfig: (state): boolean =>
      Boolean(
        state.health?.configConfigured &&
        state.effectiveRuntimeConfiguration?.machine?.code,
      ),
    customerAudio: (state) =>
      state.effectiveRuntimeConfiguration?.experience.audio ??
      defaultAudioPreferences,
  },
  actions: {
    applyHealth(snapshot: HealthSnapshot): void {
      this.health = snapshot;
    },
    applyEffectiveRuntimeConfiguration(
      configuration: EffectiveMachineRuntimeConfiguration,
    ): void {
      this.effectiveRuntimeConfiguration = configuration;
      useAudioCueStore().applySettings({
        enabled: configuration.experience.audio.cuesEnabled,
        categories: {
          presence: configuration.experience.audio.presenceCuesEnabled,
          transaction: configuration.experience.audio.transactionCuesEnabled,
        },
      });
      this.configLoaded = true;
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
