import { rolePermissions, roles } from "@vem/db";
import {
  adminPermissionCodeListResponseSchema,
  adminRoleResponseSchema,
  type AdminCreateRoleRequest,
  type AdminRoleResponse,
  type AdminUpdateRoleRequest,
  type PermissionCode,
} from "@vem/shared";

type RoleInsert = typeof roles.$inferInsert;
type RolePermissionInsert = typeof rolePermissions.$inferInsert;
type Patch<T> = { [K in keyof T]?: T[K] | undefined };
type RolePatch = Patch<RoleInsert>;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;

type RoleResponseRow = Pick<
  typeof roles.$inferSelect,
  | "id"
  | "code"
  | "name"
  | "description"
  | "isBuiltin"
  | "status"
  | "createdAt"
  | "updatedAt"
>;

type PermissionLookupRow = {
  id: string;
  code: PermissionCode;
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function mapCreateRoleDtoToInsert(
  input: AdminCreateRoleRequest,
): RoleInsert {
  const dto = {
    code: input.code,
    name: input.name,
    description: input.description,
    status: input.status,
    permissionCodes: input.permissionCodes,
  } satisfies ContractFieldCoverage<AdminCreateRoleRequest>;

  const insert = {
    code: dto.code,
    name: dto.name,
    description: dto.description ?? null,
    status: dto.status,
  } satisfies RoleInsert;
  return insert;
}

export function mapUpdateRoleDtoToPatch(
  input: AdminUpdateRoleRequest,
): RolePatch {
  const dto = {
    code: input.code,
    name: input.name,
    description: input.description,
    status: input.status,
    permissionCodes: input.permissionCodes,
  } satisfies ContractFieldCoverage<AdminUpdateRoleRequest>;

  const patch = {
    code: dto.code,
    name: dto.name,
    description: dto.description,
    status: dto.status,
    updatedAt: new Date(),
  } satisfies RolePatch;
  return patch;
}

export function mapRolePermissionCodesToInsert(
  roleId: string,
  permissionRows: PermissionLookupRow[],
): RolePermissionInsert[] {
  return permissionRows.map((permission) => ({
    roleId,
    permissionId: permission.id,
  }));
}

export function toRoleResponse(
  row: RoleResponseRow,
  permissionCodes: PermissionCode[],
): AdminRoleResponse {
  const response = {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isBuiltin: row.isBuiltin,
    status: row.status,
    permissionCodes,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  } satisfies AdminRoleResponse;
  return adminRoleResponseSchema.parse(response);
}

export function toPermissionCodeListResponse(
  codes: string[],
): PermissionCode[] {
  return adminPermissionCodeListResponseSchema.parse(codes);
}
