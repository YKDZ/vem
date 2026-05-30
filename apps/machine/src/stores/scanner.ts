import { defineStore } from "pinia";

import type { ScannerStatus } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

export const useScannerStore = defineStore("scanner", {
  state: () => ({
    online: false,
    adapter: "unknown",
    message: "等待 daemon 状态",
    updatedAt: null as string | null,
    lastMaskedCode: null as string | null,
    lastScannedAtMs: null as number | null,
  }),
  actions: {
    applyStatus(status: ScannerStatus): void {
      this.online = status.online;
      this.adapter = status.adapter;
      this.message = status.message;
      this.updatedAt = status.updatedAt;
    },
    applyScan(maskedCode: string, scannedAtMs: number): void {
      this.lastMaskedCode = maskedCode;
      this.lastScannedAtMs = scannedAtMs;
      this.message = "已接收到付款码";
    },
    async refresh(): Promise<void> {
      this.applyStatus(await daemonClient.getScannerStatus());
    },
  },
});
