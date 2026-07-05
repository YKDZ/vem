import { describe, expect, it } from "vitest";

import {
  mapCreateRoleDtoToInsert,
  mapRolePermissionCodesToInsert,
  mapUpdateRoleDtoToPatch,
  toPermissionCodeListResponse,
  toRoleResponse,
} from "./roles.contract-mappers";

describe("roles contract mappers", () => {
  it("maps role DTOs into explicit role database writes", () => {
    expect(
      mapCreateRoleDtoToInsert({
        code: "ops_manager",
        name: "Ops Manager",
        description: undefined,
        status: "active",
        permissionCodes: ["adminUsers.read"],
      }),
    ).toEqual({
      code: "ops_manager",
      name: "Ops Manager",
      description: null,
      status: "active",
    });

    const patch = mapUpdateRoleDtoToPatch({
      name: "Ops Lead",
      description: null,
      permissionCodes: ["roles.write"],
    });
    expect(patch).toMatchObject({ name: "Ops Lead", description: null });
    expect(patch).not.toHaveProperty("permissionCodes");
    expect(patch.updatedAt).toBeInstanceOf(Date);
  });

  it("maps role permission assignments through shared Permission Code values", () => {
    expect(
      mapRolePermissionCodesToInsert("550e8400-e29b-41d4-a716-446655440001", [
        { id: "550e8400-e29b-41d4-a716-446655440010", code: "adminUsers.read" },
        { id: "550e8400-e29b-41d4-a716-446655440011", code: "roles.write" },
      ]),
    ).toEqual([
      {
        roleId: "550e8400-e29b-41d4-a716-446655440001",
        permissionId: "550e8400-e29b-41d4-a716-446655440010",
      },
      {
        roleId: "550e8400-e29b-41d4-a716-446655440001",
        permissionId: "550e8400-e29b-41d4-a716-446655440011",
      },
    ]);
  });

  it("assembles role and permission responses through strict shared schemas", () => {
    expect(
      toRoleResponse(
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          code: "ops_manager",
          name: "Ops Manager",
          description: null,
          isBuiltin: false,
          status: "active",
          createdAt: new Date("2026-07-05T00:00:00.000Z"),
          updatedAt: new Date("2026-07-05T00:10:00.000Z"),
        },
        ["adminUsers.read", "roles.write"],
      ),
    ).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440001",
      code: "ops_manager",
      name: "Ops Manager",
      description: null,
      isBuiltin: false,
      status: "active",
      permissionCodes: ["adminUsers.read", "roles.write"],
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:10:00.000Z",
    });

    expect(toPermissionCodeListResponse(["roles.write"])).toEqual([
      "roles.write",
    ]);
    expect(() => toPermissionCodeListResponse(["not.a.permission"])).toThrow();
  });
});
