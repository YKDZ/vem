import {
  adminGetDashboardCustomerProfileContract,
  adminGetDashboardSalesTrendContract,
  adminGetDashboardSummaryContract,
  adminGetDashboardTopProductsContract,
  adminListAuditLogsContract,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import { listAuditLogs } from "./audit";
import {
  getCustomerProfile,
  getDashboardSummary,
  getSalesTrend,
  getTopProducts,
} from "./dashboard";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("admin read api contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetDashboardSummaryContract,
      {},
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetDashboardSalesTrendContract,
      { query: { from: "2026-07-01T00:00:00.000Z" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetDashboardTopProductsContract,
      { query: { to: "2026-07-05T00:00:00.000Z" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetDashboardCustomerProfileContract,
      {},
    );
  });
});
