import type { PermissionCode } from "@vem/shared";

import "vue-router";

export {};

declare module "vue-router" {
  interface RouteMeta {
    title?: string;
    requiresAuth?: boolean;
    requiredPermissions?: PermissionCode[];
    hiddenInMenu?: boolean;
  }
}
