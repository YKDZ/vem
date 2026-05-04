import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  adminUserRoles,
  adminUsers,
  eq,
  isNull,
  permissions,
  rolePermissions,
  roles,
  type DrizzleClient,
} from "@vem/db";

import type { AuthenticatedAdmin } from "../common/request-user";

import { DRIZZLE_CLIENT } from "../database/database.constants";

@Injectable()
export class AccessService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async getAuthenticatedAdmin(
    adminUserId: string,
  ): Promise<AuthenticatedAdmin> {
    const [user] = await this.db
      .select()
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.id, adminUserId),
          eq(adminUsers.status, "active"),
          isNull(adminUsers.deletedAt),
        ),
      );
    if (!user) {
      throw new NotFoundException("Admin user not found");
    }

    const rows = await this.db
      .select({ roleCode: roles.code, permissionCode: permissions.code })
      .from(adminUserRoles)
      .innerJoin(roles, eq(adminUserRoles.roleId, roles.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(
        and(
          eq(adminUserRoles.adminUserId, user.id),
          eq(roles.status, "active"),
          isNull(roles.deletedAt),
        ),
      );

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      roles: [...new Set(rows.map((row) => String(row.roleCode)))],
      permissions: [...new Set(rows.map((row) => row.permissionCode))],
    };
  }
}
