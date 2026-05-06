import { defineStore } from "pinia";

import {
  completeLogExport,
  failRemoteOp,
  listPendingRemoteOps,
  type RemoteOp,
} from "@/api/remote-ops";
import { exportLocalLogsZip } from "@/native/local-logs";

type RemoteOpsState = {
  pendingOps: RemoteOp[];
  lastError: string | null;
  lastPolledAt: string | null;
  processing: boolean;
};

let pollTimer: number | null = null;
let apiBaseUrl: string | null = null;

export const useRemoteOpsStore = defineStore("remote-ops", {
  state: (): RemoteOpsState => ({
    pendingOps: [],
    lastError: null,
    lastPolledAt: null,
    processing: false,
  }),
  actions: {
    start(baseUrl: string): void {
      apiBaseUrl = baseUrl;
      if (!pollTimer) {
        // Poll every 60 seconds
        pollTimer = window.setInterval(() => {
          void this.poll();
        }, 60_000);
        // Poll immediately
        void this.poll();
      }
    },
    stop(): void {
      if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      apiBaseUrl = null;
    },
    async poll(): Promise<void> {
      if (!apiBaseUrl) return;
      try {
        const ops = await listPendingRemoteOps(apiBaseUrl);
        this.pendingOps = ops;
        this.lastPolledAt = new Date().toISOString();
        this.lastError = null;

        // Process pending ops (only first export_logs since processing is sequential)
        const exportOp = ops.find(
          (op) => op.type === "export_logs" && !this.processing,
        );
        if (exportOp) {
          await this.processLogExport(exportOp);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    },
    async processLogExport(op: RemoteOp): Promise<void> {
      if (!apiBaseUrl) return;
      this.processing = true;
      try {
        const zipBytes = await exportLocalLogsZip();
        if (!zipBytes) {
          await failRemoteOp(
            apiBaseUrl,
            op.id,
            "Log export not supported in browser environment",
          );
          return;
        }
        // Convert Uint8Array to base64
        const base64 = btoa(
          Array.from(zipBytes)
            .map((b) => String.fromCharCode(b))
            .join(""),
        );
        const fileName = `machine-events-${new Date().toISOString().slice(0, 10)}.zip`;
        await completeLogExport(apiBaseUrl, op.id, {
          fileName,
          contentType: "application/zip",
          base64,
          sizeBytes: zipBytes.length,
        });
        // Remove from pending list
        this.pendingOps = this.pendingOps.filter((o) => o.id !== op.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await failRemoteOp(apiBaseUrl, op.id, reason).catch(
          (_err: unknown) => {
            /* ignore fail-reporting errors */
          },
        );
        this.lastError = reason;
      } finally {
        this.processing = false;
      }
    },
  },
});
