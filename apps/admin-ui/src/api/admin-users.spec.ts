import {
  adminCreateAdminUserContract,
  adminListAdminUsersContract,
  adminUpdateAdminUserContract,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  createAdminUser,
  listAdminUsers,
  updateAdminUser,
} from "./admin-users";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("admin users api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callAdminEndpointContract).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("uses complete shared endpoint contracts for list, create, and update", async () => {
    const adminUserId = "550e8400-e29b-41d4-a716-446655440000";

    await listAdminUsers({ status: "active", page: 2 });
    await createAdminUser({
      username: "operator-1",
      password: "LocalTestbedPassword!",
      displayName: "现场操作员",
    });
    await updateAdminUser(adminUserId, { displayName: "新的操作员" });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListAdminUsersContract,
      { query: expect.objectContaining({ status: "active", page: 2 }) },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreateAdminUserContract,
      { body: expect.objectContaining({ username: "operator-1" }) },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdateAdminUserContract,
      {
        pathParams: { id: adminUserId },
        body: { displayName: "新的操作员" },
      },
    );
  });
});
