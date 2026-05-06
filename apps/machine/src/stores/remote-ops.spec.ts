import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the api/remote-ops module
vi.mock("@/api/remote-ops", () => ({
  listPendingRemoteOps: vi.fn(),
  completeLogExport: vi.fn(),
  failRemoteOp: vi.fn(),
}));

// Mock the native/local-logs module
vi.mock("@/native/local-logs", () => ({
  exportLocalLogsZip: vi.fn(),
}));

import * as remoteOpsApi from "@/api/remote-ops";
import * as localLogs from "@/native/local-logs";
import { useRemoteOpsStore } from "./remote-ops";

// Node environment doesn't have `window` — stub the timer APIs
const timerIds = { current: 0 };
vi.stubGlobal("window", {
  setInterval: vi.fn(() => { timerIds.current += 1; return timerIds.current; }),
  clearInterval: vi.fn(),
});

describe("useRemoteOpsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // Default: list returns empty so start()'s immediate poll doesn't overwrite pendingOps
    vi.mocked(remoteOpsApi.listPendingRemoteOps).mockResolvedValue([]);
    vi.mocked(remoteOpsApi.failRemoteOp).mockResolvedValue(undefined);
    vi.mocked(remoteOpsApi.completeLogExport).mockResolvedValue(undefined);
  });

  describe("processLogExport", () => {
    it("encodes zip bytes as base64 and completes the op", async () => {
      vi.mocked(remoteOpsApi.completeLogExport).mockResolvedValue(undefined);
      const bytes = new Uint8Array([65, 66, 67]); // "ABC"
      vi.mocked(localLogs.exportLocalLogsZip).mockResolvedValue(bytes);

      const store = useRemoteOpsStore();
      store.start("http://localhost:9000");

      const op = {
        id: "op-003",
        type: "export_logs",
        status: "pending",
        requestedAt: new Date().toISOString(),
      };

      // Manually add op to pendingOps so removal can be verified
      store.pendingOps = [op];

      await store.processLogExport(op);

      expect(remoteOpsApi.completeLogExport).toHaveBeenCalledWith(
        "http://localhost:9000",
        "op-003",
        expect.objectContaining({
          base64: btoa("ABC"),
          contentType: "application/zip",
          sizeBytes: 3,
        }),
      );
      // Op is removed from pending list after success
      expect(store.pendingOps).not.toContainEqual(
        expect.objectContaining({ id: "op-003" }),
      );
      store.stop();
    });

    it("calls failRemoteOp when exportLocalLogsZip returns null (browser env)", async () => {
      vi.mocked(localLogs.exportLocalLogsZip).mockResolvedValue(null);
      vi.mocked(remoteOpsApi.failRemoteOp).mockResolvedValue(undefined);

      const store = useRemoteOpsStore();
      store.start("http://localhost:9000");

      const op = {
        id: "op-002",
        type: "export_logs",
        status: "pending",
        requestedAt: new Date().toISOString(),
      };

      await store.processLogExport(op);

      expect(remoteOpsApi.failRemoteOp).toHaveBeenCalledWith(
        "http://localhost:9000",
        "op-002",
        expect.stringContaining("browser"),
      );
      expect(remoteOpsApi.completeLogExport).not.toHaveBeenCalled();
      store.stop();
    });
  });

  describe("poll", () => {
    it("lists pending ops and processes export_logs op when found", async () => {
      const op = {
        id: "op-001",
        type: "export_logs",
        status: "pending",
        requestedAt: new Date().toISOString(),
      };
      vi.mocked(remoteOpsApi.listPendingRemoteOps).mockResolvedValue([op]);
      vi.mocked(localLogs.exportLocalLogsZip).mockResolvedValue(
        new Uint8Array([0x50, 0x4b]),
      );
      vi.mocked(remoteOpsApi.completeLogExport).mockResolvedValue(undefined);

      const store = useRemoteOpsStore();
      store.start("http://localhost:3000");
      await store.poll();

      expect(remoteOpsApi.listPendingRemoteOps).toHaveBeenCalledWith(
        "http://localhost:3000",
      );
      expect(remoteOpsApi.completeLogExport).toHaveBeenCalledOnce();
      store.stop();
    });

    it("records lastError when api throws", async () => {
      vi.mocked(remoteOpsApi.listPendingRemoteOps).mockRejectedValue(
        new Error("network error"),
      );

      const store = useRemoteOpsStore();
      store.start("http://localhost:3000");
      await store.poll();

      expect(store.lastError).toBe("network error");
      store.stop();
    });
  });
});
