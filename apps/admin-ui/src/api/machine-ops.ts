import type { z } from "zod";

import {
  adminListMachineOpsContract,
  adminMachineOpsListQuerySchema,
  adminRequestMachineLogExportContract,
  type AdminMachineRemoteOpResponse,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type MachineOp = AdminMachineRemoteOpResponse;

export async function listMachineOps(
  query?: z.input<typeof adminMachineOpsListQuerySchema>,
): Promise<MachineOp[]> {
  return await callAdminEndpointContract(adminListMachineOpsContract, {
    query: query ?? {},
  });
}

export async function requestLogExport(machineId: string): Promise<MachineOp> {
  return await callAdminEndpointContract(adminRequestMachineLogExportContract, {
    pathParams: { machineId },
    body: {},
  });
}
