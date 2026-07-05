import type { RoleStatus } from "@vem/shared";
import type { z } from "zod";

import { createRoleSchema, updateRoleSchema } from "@vem/shared";

export type RoleFormModel = {
  code: string;
  name: string;
  description: string;
  status: RoleStatus;
  permissionCodes: string[];
};

function nullableText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toCreateRoleContract(
  form: RoleFormModel,
): z.output<typeof createRoleSchema> {
  return createRoleSchema.parse({
    code: form.code,
    name: form.name,
    description: nullableText(form.description),
    status: form.status,
    permissionCodes: form.permissionCodes,
  });
}

export function toUpdateRoleContract(
  form: RoleFormModel,
): z.output<typeof updateRoleSchema> {
  return updateRoleSchema.parse({
    code: form.code,
    name: form.name,
    description: nullableText(form.description),
    status: form.status,
    permissionCodes: form.permissionCodes,
  });
}
