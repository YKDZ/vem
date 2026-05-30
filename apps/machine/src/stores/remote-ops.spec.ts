import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getRemoteOpsStatusMock, downloadLogExportMock } = vi.hoisted(() => ({
  getRemoteOpsStatusMock: vi.fn(),
  downloadLogExportMock: vi.fn(),
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getRemoteOpsStatus: getRemoteOpsStatusMock,
    downloadLogExport: downloadLogExportMock,
  },
}));

import { useRemoteOpsStore } from "./remote-ops";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

describe("useRemoteOpsStore", () => {
  it("loads remote ops status from daemon", async () => {
    getRemoteOpsStatusMock.mockResolvedValue({
      lastPolledAt: "2026-01-01T00:00:00Z",
      pending: 2,
      lastError: null,
      processing: null,
    });

    const store = useRemoteOpsStore();
    await store.refresh();

    expect(store.pending).toBe(2);
    expect(store.lastPolledAt).toBe("2026-01-01T00:00:00Z");
  });

  it("proxies log export download through daemon", async () => {
    const response = new Response("zip");
    downloadLogExportMock.mockResolvedValue(response);

    const store = useRemoteOpsStore();
    const result = await store.downloadExport();

    expect(result).toBe(response);
  });
});
