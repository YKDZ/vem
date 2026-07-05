import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";

import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { permissionCodeSchema, type PermissionCode } from "@vem/shared";
import { describe, expect, it } from "vitest";

import { AdminUsersController } from "../admin-users/admin-users.controller";
import { RolesController } from "../roles/roles.controller";
import {
  ANY_REQUIRED_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from "./permissions.decorator";
import { PermissionsGuard } from "./permissions.guard";

describe("access management permission guards", () => {
  it("uses shared Permission Code values on identity and role controller actions", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        AdminUsersController.prototype.list,
      ),
    ).toEqual([permissionCodeSchema.parse("adminUsers.read")]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        AdminUsersController.prototype.create,
      ),
    ).toEqual([permissionCodeSchema.parse("adminUsers.write")]);
    expect(
      Reflect.getMetadata(
        ANY_REQUIRED_PERMISSIONS_KEY,
        RolesController.prototype.list,
      ),
    ).toEqual([
      permissionCodeSchema.parse("roles.write"),
      permissionCodeSchema.parse("adminUsers.write"),
    ]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        RolesController.prototype.getPermissions,
      ),
    ).toEqual([permissionCodeSchema.parse("roles.write")]);
  });

  it("allows role listing when the admin has one accepted role-list permission", () => {
    const reflector = new Reflector();
    const guard = new PermissionsGuard(reflector);

    expect(
      guard.canActivate(
        createPermissionContext(RolesController.prototype.list, [
          "adminUsers.write",
        ]),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        createPermissionContext(RolesController.prototype.list, [
          "adminUsers.read",
        ]),
      ),
    ).toThrow(ForbiddenException);
  });
});

function createPermissionContext(
  handler: ReturnType<ExecutionContext["getHandler"]>,
  permissions: PermissionCode[],
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => RolesController,
    switchToHttp: () => ({
      getRequest: () => ({
        user: {
          permissions,
        },
      }),
    }),
  } as unknown as ExecutionContext;
}
