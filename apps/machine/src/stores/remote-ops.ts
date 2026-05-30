import { defineStore } from "pinia";

import { daemonClient } from "@/daemon/client";

export const useRemoteOpsStore = defineStore("remote-ops", {
  state: () => ({
    pending: 0,
    lastError: null as string | null,
    lastPolledAt: null as string | null,
    processing: null as string | null,
    loading: false,
  }),
  actions: {
    applyStatus(status: {
      pending: number;
      lastError: string | null;
      lastPolledAt: string | null;
      processing: string | null;
    }): void {
      this.pending = status.pending;
      this.lastError = status.lastError;
      this.lastPolledAt = status.lastPolledAt;
      this.processing = status.processing;
    },
    async refresh(): Promise<void> {
      this.loading = true;
      try {
        this.applyStatus(await daemonClient.getRemoteOpsStatus());
      } finally {
        this.loading = false;
      }
    },
    async downloadExport(): Promise<Response> {
      return daemonClient.downloadLogExport();
    },
  },
});
