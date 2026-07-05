import type { AdminUserStatus } from "@vem/shared";
import type { z } from "zod";

import { createAdminUserSchema, updateAdminUserSchema } from "@vem/shared";

export type AdminUserFormModel = {
  username: string;
  password: string;
  displayName: string;
  mobile: string;
  email: string;
  status: AdminUserStatus;
  roleIds: string[];
};

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toCreateAdminUserContract(
  form: AdminUserFormModel,
): z.output<typeof createAdminUserSchema> {
  return createAdminUserSchema.parse({
    username: form.username,
    password: form.password,
    displayName: form.displayName,
    mobile: nullableText(form.mobile),
    email: nullableText(form.email),
    status: form.status,
    roleIds: form.roleIds,
  });
}

export function toUpdateAdminUserContract(
  form: AdminUserFormModel,
): z.output<typeof updateAdminUserSchema> {
  return updateAdminUserSchema.parse({
    username: form.username,
    displayName: form.displayName,
    mobile: nullableText(form.mobile),
    email: nullableText(form.email),
    status: form.status,
    roleIds: form.roleIds,
    ...(form.password ? { password: form.password } : {}),
  });
}
