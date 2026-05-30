import { defineStore } from "pinia";

import type { VisionStatus } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

export const useVisionStore = defineStore("vision", {
  state: () => ({
    enabled: false,
    online: false,
    message: "等待 daemon 状态",
    updatedAt: null as string | null,
  }),
  actions: {
    applyStatus(status: VisionStatus): void {
      this.enabled = status.enabled;
      this.online = status.online;
      this.message = status.message;
      this.updatedAt = status.updatedAt ?? new Date().toISOString();
    },
    async refresh(): Promise<void> {
      this.applyStatus(await daemonClient.getVisionStatus());
    },
  },
});
