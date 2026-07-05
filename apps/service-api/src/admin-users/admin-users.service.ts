import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  adminUserRoles,
  adminUsers,
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import {
  type AdminCreateUserRequest,
  type AdminUpdateUserRequest,
  type AdminUserListQuery,
  adminUserPageResponseSchema,
} from "@vem/shared";

import { AuditService } from "../audit/audit.service";
import { PasswordService } from "../auth/password.service";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  mapAdminUserRoleIdsToInsert,
  mapCreateAdminUserDtoToInsert,
  mapUpdateAdminUserDtoToPatch,
  toAdminUserResponse,
} from "./admin-users.contract-mappers";

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly passwordService: PasswordService,
    private readonly auditService: AuditService,
  ) {}

  async list(query: AdminUserListQuery) {
    const filters: SQL[] = [isNull(adminUsers.deletedAt)];
    if (query.username)
      filters.push(
        sql`${adminUsers.username} ilike ${"%" + query.username + "%"}`,
      );
    if (query.status) filters.push(eq(adminUsers.status, query.status));
    const whereClause = and(...filters);

    const items = await this.db
      .select({
        id: adminUsers.id,
        username: adminUsers.username,
        displayName: adminUsers.displayName,
        mobile: adminUsers.mobile,
        email: adminUsers.email,
        status: adminUsers.status,
        lastLoginAt: adminUsers.lastLoginAt,
        createdAt: adminUsers.createdAt,
        updatedAt: adminUsers.updatedAt,
      })
      .from(adminUsers)
      .where(whereClause)
      .orderBy(desc(adminUsers.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(adminUsers)
      .where(whereClause);

    const roleIdsByUserId = await this.getRoleIdsByUserIds(
      items.map((item) => item.id),
    );

    return adminUserPageResponseSchema.parse(
      toPageResult(
        items.map((item) =>
          toAdminUserResponse(item, roleIdsByUserId.get(item.id) ?? []),
        ),
        query,
        Number(totalRow.total),
      ),
    );
  }

  async create(operatorAdminId: string, input: AdminCreateUserRequest) {
    const passwordHash = await this.passwordService.hashPassword(
      input.password,
    );

    const created = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(adminUsers)
        .values(mapCreateAdminUserDtoToInsert(input, passwordHash))
        .returning();

      if (input.roleIds.length > 0) {
        await tx
          .insert(adminUserRoles)
          .values(mapAdminUserRoleIdsToInsert(user.id, input.roleIds));
      }

      return user;
    });

    const afterJson: Record<string, unknown> = {
      id: created.id,
      username: created.username,
      displayName: created.displayName,
      status: created.status,
      roleIds: input.roleIds,
    };

    await this.auditService.record({
      adminUserId: operatorAdminId,
      action: "admin_users.create",
      resourceType: "admin_user",
      resourceId: created.id,
      afterJson,
    });

    return toAdminUserResponse(created, input.roleIds);
  }

  async update(
    operatorAdminId: string,
    id: string,
    input: AdminUpdateUserRequest,
  ) {
    const [existing] = await this.db
      .select()
      .from(adminUsers)
      .where(and(eq(adminUsers.id, id), isNull(adminUsers.deletedAt)));

    if (!existing) {
      throw new NotFoundException("Admin user not found");
    }

    const beforeJson: Record<string, unknown> = {
      id: existing.id,
      username: existing.username,
      displayName: existing.displayName,
      status: existing.status,
    };

    const passwordHash =
      input.password === undefined
        ? undefined
        : await this.passwordService.hashPassword(input.password);
    const updateData = mapUpdateAdminUserDtoToPatch(input, passwordHash);

    const updated = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .update(adminUsers)
        .set(updateData)
        .where(and(eq(adminUsers.id, id), isNull(adminUsers.deletedAt)))
        .returning();

      if (input.roleIds !== undefined) {
        await tx
          .delete(adminUserRoles)
          .where(eq(adminUserRoles.adminUserId, id));

        if (input.roleIds.length > 0) {
          await tx
            .insert(adminUserRoles)
            .values(mapAdminUserRoleIdsToInsert(id, input.roleIds));
        }
      }

      return user;
    });

    const afterJson: Record<string, unknown> = {
      id: updated.id,
      username: updated.username,
      displayName: updated.displayName,
      status: updated.status,
      roleIds: input.roleIds,
    };

    await this.auditService.record({
      adminUserId: operatorAdminId,
      action: "admin_users.update",
      resourceType: "admin_user",
      resourceId: id,
      beforeJson,
      afterJson,
    });

    const roleIds =
      input.roleIds ??
      (await this.getRoleIdsByUserIds([updated.id])).get(updated.id) ??
      [];
    return toAdminUserResponse(updated, roleIds);
  }

  private async getRoleIdsByUserIds(
    adminUserIds: string[],
  ): Promise<Map<string, string[]>> {
    if (adminUserIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        adminUserId: adminUserRoles.adminUserId,
        roleId: adminUserRoles.roleId,
      })
      .from(adminUserRoles)
      .where(inArray(adminUserRoles.adminUserId, adminUserIds));

    const roleIdsByUserId = new Map<string, string[]>();
    for (const row of rows) {
      const roleIds = roleIdsByUserId.get(row.adminUserId) ?? [];
      roleIds.push(row.roleId);
      roleIdsByUserId.set(row.adminUserId, roleIds);
    }
    return roleIdsByUserId;
  }
}
