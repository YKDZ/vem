import { get, post } from "./request";

export type MachineOp = {
  id: string;
  machineId: string | null;
  type: string;
  status: string;
  requestedAt: string;
  requestedByAdminUserId: string | null;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listMachineOps(
  query?: Record<string, unknown>,
): Promise<PageResult<MachineOp>> {
  return await get<PageResult<MachineOp>>("/machine-ops", { params: query });
}

export async function requestLogExport(machineId: string): Promise<MachineOp> {
  return await post<MachineOp>(
    `/machine-ops/machines/${machineId}/export-logs`,
  );
}
