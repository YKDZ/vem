import type { z } from "zod";

import {
  adminMachineContractNoBodySchema,
  adminMachineOpsListQuerySchema,
  adminMachineRemoteOpListResponseSchema,
  adminMachineRemoteOpResponseSchema,
  type AdminMachineRemoteOpResponse,
} from "@vem/shared";

import { getContract, postContract } from "./request";

export type MachineOp = AdminMachineRemoteOpResponse;

export async function listMachineOps(
  query?: z.input<typeof adminMachineOpsListQuerySchema>,
): Promise<MachineOp[]> {
  return await getContract(
    "/machine-ops",
    adminMachineOpsListQuerySchema,
    adminMachineRemoteOpListResponseSchema,
    query ?? {},
  );
}

export async function requestLogExport(machineId: string): Promise<MachineOp> {
  return await postContract(
    `/machine-ops/machines/${machineId}/export-logs`,
    adminMachineContractNoBodySchema,
    adminMachineRemoteOpResponseSchema,
    {},
  );
}
