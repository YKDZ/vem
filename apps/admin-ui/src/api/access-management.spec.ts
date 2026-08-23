import {
  adminCreateAdminUserContract,
  adminCreateRoleContract,
  adminListAdminUsersContract,
  adminListPermissionCodesContract,
  adminListRolesContract,
  adminUpdateAdminUserContract,
  adminUpdateRoleContract,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  createAdminUser,
  listAdminUsers,
  updateAdminUser,
} from "./admin-users";
import { createRole, listPermissions, listRoles, updateRole } from "./roles";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("access management api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callAdminEndpointContract).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("uses complete shared endpoint contracts for admin user reads and writes", async () => {
    await listAdminUsers({ page: 1, pageSize: 20, status: "active" });
    await createAdminUser({
      username: "ops01",
      password: "StrongPassword123",
      displayName: "Ops User",
    });
    await updateAdminUser("550e8400-e29b-41d4-a716-446655440001", {
      mobile: null,
    });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListAdminUsersContract,
      { query: { page: 1, pageSize: 20, status: "active" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreateAdminUserContract,
      { body: expect.objectContaining({ username: "ops01" }) },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdateAdminUserContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440001" },
        body: { mobile: null },
      },
    );
  });

  it("uses complete shared endpoint contracts for role and permission workflows", async () => {
    await listRoles({ pageSize: 50 });
    await listPermissions();
    await createRole({
      code: "ops_manager",
      name: "Ops Manager",
      permissionCodes: ["adminUsers.read", "roles.write"],
    });
    await updateRole("550e8400-e29b-41d4-a716-446655440002", {
      permissionCodes: ["roles.write"],
    });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListRolesContract,
      { query: { pageSize: 50 } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListPermissionCodesContract,
      {},
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreateRoleContract,
      {
        body: expect.objectContaining({
          code: "ops_manager",
          permissionCodes: ["adminUsers.read", "roles.write"],
        }),
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdateRoleContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440002" },
        body: { permissionCodes: ["roles.write"] },
      },
    );
  });
});
