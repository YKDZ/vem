import { adminGetCurrentAdminContract, type PermissionCode } from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type CurrentAdmin = {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  permissions: PermissionCode[];
};

export async function meApi(): Promise<CurrentAdmin> {
  return await callAdminEndpointContract(adminGetCurrentAdminContract, {});
}
