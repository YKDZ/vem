import { permissionCodeSchema } from "@vem/shared";
import { describe, expect, it } from "vitest";

import { routes } from "./routes";

describe("Admin Identity permission gates", () => {
  it("uses shared Permission Code values for identity routes and actions", () => {
    const adminUsersRoute = routes
      .flatMap((route) => route.children ?? [])
      .find((route) => route.name === "admin-users");
    const rolesRoute = routes
      .flatMap((route) => route.children ?? [])
      .find((route) => route.name === "roles");
    const maintenanceAccessRoute = routes
      .flatMap((route) => route.children ?? [])
      .find((route) => route.name === "maintenance-access");

    expect(adminUsersRoute?.meta?.requiredPermissions).toEqual([
      permissionCodeSchema.parse("adminUsers.read"),
    ]);
    expect(rolesRoute?.meta?.requiredPermissions).toEqual([
      permissionCodeSchema.parse("roles.write"),
    ]);
    expect(maintenanceAccessRoute?.meta?.requiredPermissions).toEqual([
      permissionCodeSchema.parse("maintenanceAccess.read"),
    ]);

    expect(permissionCodeSchema.parse("adminUsers.write")).toBe(
      "adminUsers.write",
    );
    expect(permissionCodeSchema.parse("maintenanceAccess.write")).toBe(
      "maintenanceAccess.write",
    );
  });
});
