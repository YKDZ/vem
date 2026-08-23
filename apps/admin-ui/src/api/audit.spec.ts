import { adminListAuditLogsContract } from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import { listAuditLogs } from "./audit";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("audit api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callAdminEndpointContract).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("uses the complete shared endpoint contract for audit listing", async () => {
    await listAuditLogs({
      action: "machines.planogram.publish",
      page: 2,
      pageSize: 50,
    });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListAuditLogsContract,
      {
        query: expect.objectContaining({
          action: "machines.planogram.publish",
          page: 2,
        }),
      },
    );
  });
});
