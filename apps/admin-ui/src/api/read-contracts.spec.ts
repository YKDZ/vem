import { adminListAuditLogsContract } from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract, getContract } from "@/api/request";

import { listAuditLogs } from "./audit";
import {
  getCustomerProfile,
  getDashboardSummary,
  getSalesTrend,
  getTopProducts,
} from "./dashboard";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
  getContract: vi.fn().mockResolvedValue({}),
}));

describe("admin read api contracts", () => {
  it("parses audit log page responses through the shared contract", async () => {
    await listAuditLogs({ resourceType: "order", page: 2 });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListAuditLogsContract,
      { query: { resourceType: "order", page: 2 } },
    );
  });

  it("parses dashboard read responses through shared contracts", async () => {
    await getDashboardSummary();
    await getSalesTrend({ from: "2026-07-01T00:00:00.000Z" });
    await getTopProducts({ to: "2026-07-05T00:00:00.000Z" });
    await getCustomerProfile();

    expect(getContract).toHaveBeenCalledWith(
      "/dashboard/summary",
      expect.any(Object),
      expect.any(Object),
      {},
    );
    expect(getContract).toHaveBeenCalledWith(
      "/dashboard/sales-trend",
      expect.any(Object),
      expect.any(Object),
      { from: "2026-07-01T00:00:00.000Z" },
    );
    expect(getContract).toHaveBeenCalledWith(
      "/dashboard/top-products",
      expect.any(Object),
      expect.any(Object),
      { to: "2026-07-05T00:00:00.000Z" },
    );
    expect(getContract).toHaveBeenCalledWith(
      "/dashboard/customer-profile",
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });
});
