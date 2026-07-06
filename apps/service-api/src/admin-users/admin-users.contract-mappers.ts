import { adminUserRoles, adminUsers } from "@vem/db";
import {
  adminUserResponseSchema,
  type AdminCreateUserRequest,
  type AdminUpdateUserRequest,
  type AdminUserResponse,
} from "@vem/shared";

type AdminUserInsert = typeof adminUsers.$inferInsert;
type AdminUserRoleInsert = typeof adminUserRoles.$inferInsert;
type Patch<T> = { [K in keyof T]?: T[K] | undefined };
type AdminUserPatch = Patch<AdminUserInsert>;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;

type AdminUserResponseRow = Pick<
  typeof adminUsers.$inferSelect,
  | "id"
  | "username"
  | "displayName"
  | "mobile"
  | "email"
  | "status"
  | "lastLoginAt"
  | "createdAt"
  | "updatedAt"
>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  return value ? toIsoString(value) : null;
}

export function mapCreateAdminUserDtoToInsert(
  input: AdminCreateUserRequest,
  passwordHash: string,
): AdminUserInsert {
  const dto = {
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    mobile: input.mobile,
    email: input.email,
    status: input.status,
    roleIds: input.roleIds,
  } satisfies ContractFieldCoverage<AdminCreateUserRequest>;

  const insert = {
    username: dto.username,
    passwordHash,
    displayName: dto.displayName,
    mobile: dto.mobile ?? null,
    email: dto.email ?? null,
    status: dto.status,
  } satisfies AdminUserInsert;
  return insert;
}

export function mapUpdateAdminUserDtoToPatch(
  input: AdminUpdateUserRequest,
  passwordHash?: string,
): AdminUserPatch {
  const dto = {
    username: input.username,
    password: input.password,
    displayName: input.displayName,
    mobile: input.mobile,
    email: input.email,
    status: input.status,
    roleIds: input.roleIds,
  } satisfies ContractFieldCoverage<AdminUpdateUserRequest>;

  const patch = {
    username: dto.username,
    passwordHash,
    displayName: dto.displayName,
    mobile: dto.mobile,
    email: dto.email,
    status: dto.status,
    updatedAt: new Date(),
  } satisfies AdminUserPatch;
  return patch;
}

export function mapAdminUserRoleIdsToInsert(
  adminUserId: string,
  roleIds: string[],
): AdminUserRoleInsert[] {
  return roleIds.map((roleId) => ({
    adminUserId,
    roleId,
  }));
}

export function toAdminUserResponse(
  row: AdminUserResponseRow,
  roleIds: string[],
): AdminUserResponse {
  const response = {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    mobile: row.mobile,
    email: row.email,
    status: row.status,
    roles: roleIds,
    lastLoginAt: toIsoStringOrNull(row.lastLoginAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  } satisfies AdminUserResponse;
  return adminUserResponseSchema.parse(response);
}
