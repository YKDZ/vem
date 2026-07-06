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
  sql,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import {
  adminRolePageResponseSchema,
  permissionCodes,
  type AdminCreateRoleRequest,
  type AdminRoleListQuery,
  type AdminUpdateRoleRequest,
  type PermissionCode,
} from "@vem/shared";

import { AuditService } from "../audit/audit.service";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  mapCreateRoleDtoToInsert,
  mapRolePermissionCodesToInsert,
  mapUpdateRoleDtoToPatch,
  toPermissionCodeListResponse,
  toRoleResponse,
} from "./roles.contract-mappers";

function toPersistedPermissionCodes(
  requestedCodes: PermissionCode[],
  permissionRows: Array<{ code: PermissionCode }>,
): PermissionCode[] {
  const availableCodes = new Set(permissionRows.map((row) => row.code));
  const persistedCodes: PermissionCode[] = [];

  for (const code of requestedCodes) {
    if (availableCodes.has(code) && !persistedCodes.includes(code)) {
      persistedCodes.push(code);
    }
  }

  return persistedCodes;
}

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
  ) {}

  async list(query: AdminRoleListQuery) {
    const filters: SQL[] = [isNull(roles.deletedAt)];
    if (query.keyword) {
      filters.push(
        sql`(${roles.code} ilike ${"%" + query.keyword + "%"} or ${roles.name} ilike ${"%" + query.keyword + "%"})`,
      );
    }
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

    const permissionCodesByRoleId = await this.getPermissionCodesByRoleIds(
      items.map((item) => item.id),
    );

    return adminRolePageResponseSchema.parse(
      toPageResult(
        items.map((item) =>
          toRoleResponse(item, permissionCodesByRoleId.get(item.id) ?? []),
        ),
        query,
        Number(totalRow.total),
      ),
    );
  }

  async create(operatorAdminId: string, input: AdminCreateRoleRequest) {
    if (input.code === "super_admin") {
      throw new BadRequestException("Cannot create role with code super_admin");
    }

    let persistedPermissionCodes: PermissionCode[] = [];
    const created = await this.db.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values(mapCreateRoleDtoToInsert(input))
        .returning();

      if (input.permissionCodes.length > 0) {
        const permRows = await tx
          .select({ id: permissions.id, code: permissions.code })
          .from(permissions)
          .where(inArray(permissions.code, input.permissionCodes));

        persistedPermissionCodes = toPersistedPermissionCodes(
          input.permissionCodes,
          permRows,
        );

        if (permRows.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(mapRolePermissionCodesToInsert(role.id, permRows));
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
        permissionCodes: persistedPermissionCodes,
      },
    });

    return toRoleResponse(created, persistedPermissionCodes);
  }

  async update(
    operatorAdminId: string,
    id: string,
    input: AdminUpdateRoleRequest,
  ) {
    const [existing] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), isNull(roles.deletedAt)));

    if (!existing) {
      throw new NotFoundException("Role not found");
    }

    const requestedPatch = mapUpdateRoleDtoToPatch(input);

    let updateData = requestedPatch;
    if (existing.isBuiltin) {
      // built-in roles: only permissionCodes and status can be changed
      updateData = {
        status: requestedPatch.status,
        updatedAt: requestedPatch.updatedAt,
      };
    }

    let persistedPermissionCodes: PermissionCode[] | undefined;
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
            .select({ id: permissions.id, code: permissions.code })
            .from(permissions)
            .where(inArray(permissions.code, input.permissionCodes));

          persistedPermissionCodes = toPersistedPermissionCodes(
            input.permissionCodes,
            permRows,
          );

          if (permRows.length > 0) {
            await tx
              .insert(rolePermissions)
              .values(mapRolePermissionCodesToInsert(id, permRows));
          }
        } else {
          persistedPermissionCodes = [];
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
        permissionCodes: persistedPermissionCodes,
      },
    });

    const responsePermissionCodes =
      persistedPermissionCodes ??
      (await this.getPermissionCodesByRoleIds([updated.id])).get(updated.id) ??
      [];
    return toRoleResponse(updated, responsePermissionCodes);
  }

  getPermissionCodes() {
    return toPermissionCodeListResponse([...permissionCodes]);
  }

  private async getPermissionCodesByRoleIds(
    roleIds: string[],
  ): Promise<Map<string, PermissionCode[]>> {
    if (roleIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        roleId: rolePermissions.roleId,
        permissionCode: permissions.code,
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(inArray(rolePermissions.roleId, roleIds));

    const permissionCodesByRoleId = new Map<string, PermissionCode[]>();
    for (const row of rows) {
      const codes = permissionCodesByRoleId.get(row.roleId) ?? [];
      codes.push(row.permissionCode);
      permissionCodesByRoleId.set(row.roleId, codes);
    }
    return permissionCodesByRoleId;
  }
}
