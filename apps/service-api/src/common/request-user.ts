import type { PermissionCode } from "@vem/shared";

export type AuthenticatedAdmin = {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  permissions: PermissionCode[];
};
