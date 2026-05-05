import { defineStore } from "pinia";

import { requestMachineToken } from "@/api/machine-auth";
import {
  setMachineAuthToken,
  clearMachineAuthToken,
} from "@/api/machine-auth-session";
import {
  machineConfigDefaults,
  type MachineConfig,
} from "@/config/machine-config";
import {
  hardwareSelfCheck,
  type HardwareSelfCheckResult,
} from "@/native/hardware";
import { getMachineConfig, saveMachineConfig } from "@/native/local-config";

export const useMachineStore = defineStore("machine", {
  state: () => ({
    config: machineConfigDefaults,
    configLoaded: false,
    authTokenReady: false,
    hardware: null as HardwareSelfCheckResult | null,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    machineCode: (state): string | null => state.config.machineCode,
    hasDeploymentConfig: (state): boolean =>
      Boolean(state.config.machineCode && state.config.machineSecret),
    hardwareReady: (state): boolean => state.hardware?.status === "ok",
    canSell(): boolean {
      return (
        this.hasDeploymentConfig && this.authTokenReady && this.hardwareReady
      );
    },
  },
  actions: {
    async loadConfig(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.config = await getMachineConfig();
        this.configLoaded = true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
      }
    },
    async saveConfig(config: MachineConfig): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.config = await saveMachineConfig(config);
        this.configLoaded = true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
    async runHardwareSelfCheck(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        this.hardware = await hardwareSelfCheck();
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.hardware = null;
      } finally {
        this.loading = false;
      }
    },
    async authenticate(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const token = await requestMachineToken(this.config);
        setMachineAuthToken(token.accessToken, token.expiresInSeconds);
        this.authTokenReady = true;
      } catch (error) {
        clearMachineAuthToken();
        this.authTokenReady = false;
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});
