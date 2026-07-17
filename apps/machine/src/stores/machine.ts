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
  audioPreferences: EffectiveMachineRuntimeConfiguration["experience"]["audio"];
};

export const useMachineStore = defineStore("machine", {
  state: (): MachineState => ({
    effectiveRuntimeConfiguration: null,
    configLoaded: false,
    health: null,
    loading: false,
    error: null,
    audioPreferences: {
      volume: 0.7,
      cuesEnabled: false,
      presenceCuesEnabled: false,
      transactionCuesEnabled: false,
    },
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
    customerAudio: (state) => state.audioPreferences,
  },
  actions: {
    applyHealth(snapshot: HealthSnapshot): void {
      this.health = snapshot;
    },
    applyEffectiveRuntimeConfiguration(
      configuration: EffectiveMachineRuntimeConfiguration,
    ): void {
      this.effectiveRuntimeConfiguration = configuration;
      this.applyCustomerAudioPreferences(configuration.experience.audio);
      this.configLoaded = true;
    },
    applyCustomerAudioPreferences(
      preferences: EffectiveMachineRuntimeConfiguration["experience"]["audio"],
    ): void {
      this.audioPreferences = preferences;
      useAudioCueStore().applySettings({
        enabled: preferences.cuesEnabled,
        categories: {
          presence: preferences.presenceCuesEnabled,
          transaction: preferences.transactionCuesEnabled,
        },
      });
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
