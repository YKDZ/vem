import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  permissions,
  rolePermissions,
  roles,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import {
  createRoleSchema,
  pageQuerySchema,
  permissionCodes,
  roleQuerySchema,
  updateRoleSchema,
} from "@vem/shared";
import { z } from "zod";

import { AuditService } from "../audit/audit.service";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type RoleQuery = z.infer<typeof roleQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type CreateRoleInput = z.infer<typeof createRoleSchema>;
type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
  ) {}

  async list(query: RoleQuery) {
    const filters: SQL[] = [isNull(roles.deletedAt)];
    if (query.status) filters.push(eq(roles.status, query.status));
    const whereClause = and(...filters);

    const items = await this.db
      .select()
      .from(roles)
      .where(whereClause)
      .orderBy(desc(roles.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(roles)
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async create(operatorAdminId: string, input: CreateRoleInput) {
    if (input.code === "super_admin") {
      throw new BadRequestException("Cannot create role with code super_admin");
    }

    const created = await this.db.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          status: input.status,
        })
        .returning();

      if (input.permissionCodes.length > 0) {
        const permRows = await tx
          .select({ id: permissions.id, code: permissions.code })
          .from(permissions)
          .where(inArray(permissions.code, input.permissionCodes));

        if (permRows.length > 0) {
          await tx.insert(rolePermissions).values(
            permRows.map((p) => ({
              roleId: role.id,
              permissionId: p.id,
            })),
          );
        }
      }

      return role;
    });

    await this.auditService.record({
      adminUserId: operatorAdminId,
      action: "roles.create",
      resourceType: "role",
      resourceId: created.id,
      afterJson: {
        roleId: created.id,
        code: created.code,
        permissionCodes: input.permissionCodes,
      },
    });

    return created;
  }

  async update(operatorAdminId: string, id: string, input: UpdateRoleInput) {
    const [existing] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), isNull(roles.deletedAt)));

    if (!existing) {
      throw new NotFoundException("Role not found");
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (existing.isBuiltin) {
      // built-in roles: only permissionCodes and status can be changed
      if (input.status !== undefined) updateData.status = input.status;
    } else {
      if (input.code !== undefined) updateData.code = input.code;
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined)
        updateData.description = input.description;
      if (input.status !== undefined) updateData.status = input.status;
    }

    const updated = await this.db.transaction(async (tx) => {
      const [role] = await tx
        .update(roles)
        .set(updateData)
        .where(and(eq(roles.id, id), isNull(roles.deletedAt)))
        .returning();

      if (input.permissionCodes !== undefined) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));

        if (input.permissionCodes.length > 0) {
          const permRows = await tx
            .select({ id: permissions.id })
            .from(permissions)
            .where(inArray(permissions.code, input.permissionCodes));

          if (permRows.length > 0) {
            await tx.insert(rolePermissions).values(
              permRows.map((p) => ({
                roleId: id,
                permissionId: p.id,
              })),
            );
          }
        }
      }

      return role;
    });

    await this.auditService.record({
      adminUserId: operatorAdminId,
      action: "roles.update",
      resourceType: "role",
      resourceId: id,
      afterJson: {
        roleId: updated.id,
        code: updated.code,
        permissionCodes: input.permissionCodes,
      },
    });

    return updated;
  }

  getPermissionCodes() {
    return permissionCodes;
  }
}
