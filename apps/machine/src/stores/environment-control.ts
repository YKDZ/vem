import { machineEnvironmentControlRequestSchema } from "@vem/shared";
import { defineStore } from "pinia";

import type { EnvironmentControlResult } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

export type EnvironmentControlInput = {
  airConditionerOn?: boolean;
  targetTemperatureCelsius?: number;
  ventSpeed?: number;
  timeoutSeconds?: number;
};

export const useEnvironmentControlStore = defineStore("environment-control", {
  state: () => ({
    loading: false,
    error: null as string | null,
    latestResult: null as EnvironmentControlResult | null,
  }),
  getters: {
    airConditionerOn: (state): boolean | null =>
      state.latestResult?.airConditionerOn ?? null,
    targetTemperatureCelsius: (state): number | null =>
      state.latestResult?.targetTemperatureCelsius ?? null,
    ventSpeed: (state): number | null => state.latestResult?.ventSpeed ?? null,
    latestControlSucceeded: (state): boolean | null =>
      state.latestResult?.success ?? null,
  },
  actions: {
    async controlAirConditioner(
      input: EnvironmentControlInput,
    ): Promise<EnvironmentControlResult> {
      const request = machineEnvironmentControlRequestSchema.parse({
        airConditionerOn: input.airConditionerOn,
        targetTemperatureCelsius: input.targetTemperatureCelsius,
        ventSpeed: input.ventSpeed,
      });
      const timeoutSeconds = input.timeoutSeconds ?? 5;

      this.loading = true;
      this.error = null;
      try {
        const result = await daemonClient.controlEnvironment({
          ...request,
          timeoutSeconds,
        });
        this.latestResult = result;
        if (!result.success) {
          this.error = result.message ?? "environment control failed";
        }
        return result;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});
