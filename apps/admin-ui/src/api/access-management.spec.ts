import { describe, expect, it, vi } from "vitest";

import { getContract, patchContract, postContract } from "@/api/request";

import {
  createAdminUser,
  listAdminUsers,
  updateAdminUser,
} from "./admin-users";
import { createRole, listPermissions, listRoles, updateRole } from "./roles";

vi.mock("@/api/request", () => ({
  getContract: vi
    .fn()
    .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
  patchContract: vi.fn().mockResolvedValue({}),
  postContract: vi.fn().mockResolvedValue({}),
}));

describe("access management api", () => {
  it("uses schema-bound helpers for admin user reads and writes", async () => {
    await listAdminUsers({ page: 1, pageSize: 20, status: "active" });
    await createAdminUser({
      username: "ops01",
      password: "StrongPassword123",
      displayName: "Ops User",
    });
    await updateAdminUser("550e8400-e29b-41d4-a716-446655440001", {
      mobile: null,
    });

    expect(getContract).toHaveBeenCalledWith(
      "/admin-users",
      expect.any(Object),
      expect.any(Object),
      { page: 1, pageSize: 20, status: "active" },
    );
    expect(postContract).toHaveBeenCalledWith(
      "/admin-users",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ username: "ops01" }),
    );
    expect(patchContract).toHaveBeenCalledWith(
      "/admin-users/550e8400-e29b-41d4-a716-446655440001",
      expect.any(Object),
      expect.any(Object),
      { mobile: null },
    );
  });

  it("uses schema-bound helpers for role and permission workflows", async () => {
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

    expect(getContract).toHaveBeenCalledWith(
      "/roles",
      expect.any(Object),
      expect.any(Object),
      { pageSize: 50 },
    );
    expect(getContract).toHaveBeenCalledWith(
      "/permissions",
      expect.any(Object),
      expect.any(Object),
      {},
    );
    expect(postContract).toHaveBeenCalledWith(
      "/roles",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        permissionCodes: ["adminUsers.read", "roles.write"],
      }),
    );
    expect(patchContract).toHaveBeenCalledWith(
      "/roles/550e8400-e29b-41d4-a716-446655440002",
      expect.any(Object),
      expect.any(Object),
      { permissionCodes: ["roles.write"] },
    );
  });
});
