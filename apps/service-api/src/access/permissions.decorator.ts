import type { PermissionCode } from "@vem/shared";

import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSIONS_KEY = "requiredPermissions";
export const ANY_REQUIRED_PERMISSIONS_KEY = "anyRequiredPermissions";
export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
export const RequireAnyPermission = (...permissions: PermissionCode[]) =>
  SetMetadata(ANY_REQUIRED_PERMISSIONS_KEY, permissions);
