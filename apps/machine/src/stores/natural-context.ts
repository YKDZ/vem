import { defineStore } from "pinia";

import type { NaturalContextSnapshot } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

export const useNaturalContextStore = defineStore("natural-context", {
  state: () => ({
    snapshot: null as NaturalContextSnapshot | null,
    loading: false,
    error: null as string | null,
  }),
  getters: {
    degraded: (state): boolean => state.snapshot?.degraded ?? false,
    operatorMessage: (state): string => {
      const snapshot = state.snapshot;
      if (!snapshot) return state.error ?? "Natural Context status unknown";
      const external = snapshot.externalEnvironment;
      if ("diagnostic" in external) {
        return external.diagnostic.message;
      }
      if (snapshot.degraded) {
        return "Natural Context inputs are incomplete";
      }
      return "Natural Context ready";
    },
  },
  actions: {
    applySnapshot(snapshot: NaturalContextSnapshot): void {
      this.snapshot = snapshot;
      this.error = null;
    },
    async refresh(): Promise<void> {
      this.loading = true;
      try {
        this.applySnapshot(await daemonClient.getNaturalContext());
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});
