import type {
  MachineCommandStatus,
  MachineEnvironmentControlRequest,
  MachineHeartbeatStatusPayload,
  MachineSlotStatus,
  MachineStatus,
} from "@vem/shared";

import { get, patch, post } from "./request";

export type Machine = {
  id: string;
  code: string;
  name: string;
  locationText: string | null;
  status: MachineStatus;
  mqttClientId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestEnvironment?: MachineHeartbeatStatusPayload["environment"] | null;
  latestEnvironmentCommand?: MachineCommand | null;
};

export type MachineCommand = {
  id: string;
  machineId: string;
  commandNo: string;
  type: string;
  status: MachineCommandStatus;
  payloadJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  lastError?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type MachineSlot = {
  id: string;
  machineId: string;
  layerNo: number;
  cellNo: number;
  slotCode: string;
  capacity: number;
  status: MachineSlotStatus;
};

export type CreateMachineInput = {
  code: string;
  name: string;
  locationText?: string | null;
  status?: MachineStatus;
  mqttClientId?: string | null;
};

export type CreateMachineSlotInput = {
  layerNo: number;
  cellNo: number;
  slotCode: string;
  capacity: number;
  status?: MachineSlotStatus;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listMachines(
  query?: Record<string, unknown>,
): Promise<PageResult<Machine>> {
  return await get<PageResult<Machine>>("/machines", { params: query });
}

export async function getMachine(id: string): Promise<Machine> {
  return await get<Machine>(`/machines/${id}`);
}

export async function createMachine(
  body: CreateMachineInput,
): Promise<Machine> {
  return await post<Machine>("/machines", body);
}

export async function updateMachine(
  id: string,
  body: Partial<CreateMachineInput>,
): Promise<Machine> {
  return await patch<Machine>(`/machines/${id}`, body);
}

export async function commandEnvironment(
  id: string,
  body: MachineEnvironmentControlRequest,
): Promise<MachineCommand> {
  return await post<MachineCommand>(
    `/machines/${id}/commands/environment-control`,
    body,
  );
}

export async function listMachineSlots(
  machineId: string,
): Promise<MachineSlot[]> {
  return await get<MachineSlot[]>(`/machines/${machineId}/slots`);
}

export async function createMachineSlot(
  machineId: string,
  body: CreateMachineSlotInput,
): Promise<MachineSlot> {
  return await post<MachineSlot>(`/machines/${machineId}/slots`, body);
}

export type RotateCredentialsResult = {
  machineCode: string;
  machineSecret: string;
  mqttSigningSecret: string;
  secretVersion: number;
};

export async function rotateMachineCredentials(
  machineId: string,
): Promise<RotateCredentialsResult> {
  return await post<RotateCredentialsResult>(
    `/machines/${machineId}/rotate-credentials`,
    {},
  );
}
