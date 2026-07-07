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

export type AirConditionerMode =
  | "strong_cooling"
  | "weak_cooling"
  | "off"
  | "weak_heating";

export function determineAirConditionerMode(
  temperatureCelsius: number,
): AirConditionerMode {
  if (temperatureCelsius >= 28) return "strong_cooling";
  if (temperatureCelsius >= 20) return "weak_cooling";
  if (temperatureCelsius >= 10) return "off";
  return "weak_heating";
}

export function getAirConditionerControlForMode(
  mode: AirConditionerMode,
): EnvironmentControlInput {
  switch (mode) {
    case "strong_cooling":
      return {
        airConditionerOn: true,
        targetTemperatureCelsius: 18,
        ventSpeed: 3,
      };
    case "weak_cooling":
      return {
        airConditionerOn: true,
        targetTemperatureCelsius: 24,
        ventSpeed: 1,
      };
    case "off":
      return {
        airConditionerOn: false,
      };
    case "weak_heating":
      return {
        airConditionerOn: true,
        targetTemperatureCelsius: 28,
        ventSpeed: 1,
      };
  }
}

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
    async controlAirConditionerBasedOnTemperature(
      temperatureCelsius: number,
    ): Promise<EnvironmentControlResult> {
      const mode = determineAirConditionerMode(temperatureCelsius);
      const controlInput = getAirConditionerControlForMode(mode);
      return this.controlAirConditioner(controlInput);
    },
  },
});
