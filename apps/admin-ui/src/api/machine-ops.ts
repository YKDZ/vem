import { get, post } from "./request";

export type MachineOp = {
  id: string;
  machineId: string | null;
  type: string;
  status: string;
  requestedAt: string;
  requestedByAdminUserId: string | null;
  acceptedAt?: string | null;
  finishedAt?: string | null;
  failedReason?: string | null;
};

export async function listMachineOps(
  query?: Record<string, unknown>,
): Promise<MachineOp[]> {
  return await get<MachineOp[]>("/machine-ops", { params: query });
}

export async function requestLogExport(machineId: string): Promise<MachineOp> {
  return await post<MachineOp>(
    `/machine-ops/machines/${machineId}/export-logs`,
  );
}
