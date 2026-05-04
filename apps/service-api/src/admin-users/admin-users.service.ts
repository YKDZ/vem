import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  adminUserRoles,
  adminUsers,
  and,
  count,
  desc,
  eq,
  isNull,
  sql,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import {
  adminUserQuerySchema,
  createAdminUserSchema,
  pageQuerySchema,
  updateAdminUserSchema,
} from "@vem/shared";
import { z } from "zod";

import { AuditService } from "../audit/audit.service";
import { PasswordService } from "../auth/password.service";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type AdminUserQuery = z.infer<typeof adminUserQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;
type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly passwordService: PasswordService,
    private readonly auditService: AuditService,
  ) {}

  async list(query: AdminUserQuery) {
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

    return toPageResult(items, query, Number(totalRow.total));
  }

  async create(operatorAdminId: string, input: CreateAdminUserInput) {
    const passwordHash = await this.passwordService.hashPassword(
      input.password,
    );

    const created = await this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(adminUsers)
        .values({
          username: input.username,
          passwordHash,
          displayName: input.displayName,
          mobile: input.mobile ?? null,
          email: input.email ?? null,
          status: input.status,
        })
        .returning();

      if (input.roleIds.length > 0) {
        await tx.insert(adminUserRoles).values(
          input.roleIds.map((roleId) => ({
            adminUserId: user.id,
            roleId,
          })),
        );
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

    return created;
  }

  async update(
    operatorAdminId: string,
    id: string,
    input: UpdateAdminUserInput,
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

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (input.username !== undefined) updateData.username = input.username;
    if (input.displayName !== undefined)
      updateData.displayName = input.displayName;
    if (input.mobile !== undefined) updateData.mobile = input.mobile;
    if (input.email !== undefined) updateData.email = input.email;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.password) {
      updateData.passwordHash = await this.passwordService.hashPassword(
        input.password,
      );
    }

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
          await tx.insert(adminUserRoles).values(
            input.roleIds.map((roleId) => ({
              adminUserId: id,
              roleId,
            })),
          );
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

    return updated;
  }
}
