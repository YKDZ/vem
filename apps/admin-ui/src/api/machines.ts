import type {
  MachineCommandStatus,
  MachineClaimCodePurpose,
  MachineClaimCodeState,
  MachineEnvironmentControlRequest,
  MachineHeartbeatStatusPayload,
  MachineSlotStatus,
  MachineStatus,
} from "@vem/shared";

import { get, patch, post } from "./request";

export type MachineGeoLocation = {
  latitude: number;
  longitude: number;
  timezone: string;
};

export type ExternalNaturalEnvironment = {
  status: "ready" | "stale" | "unavailable" | "unconfigured";
  machineId: string;
  machineCode: string;
  checkedAt: string;
  weather?: {
    temperatureCelsius: number;
    conditionText: string;
    observedAt: string;
  };
  sun?: {
    sunriseAt: string;
    sunsetAt: string;
  };
  diagnostic?: {
    reason: "machine_geo_location_missing" | "provider_unavailable";
    message: string;
  };
};

export type Machine = {
  id: string;
  code: string;
  name: string;
  locationLabel: string | null;
  geoLocation: MachineGeoLocation | null;
  status: MachineStatus;
  mqttClientId: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  latestHeartbeatStatus?: MachineHeartbeatStatusPayload | null;
  latestHeartbeatReportedAt?: string | null;
  latestEnvironment?: MachineHeartbeatStatusPayload["environment"] | null;
  latestEnvironmentCommand?: MachineCommand | null;
  productionPilotReadiness?: ProductionPilotReadiness | null;
};

export type ProductionPilotReadinessCheck = {
  code: string;
  label: string;
  status: "ready" | "blocked" | "degraded" | "missing";
  message: string;
  operatorAction: string;
};

export type ProductionPilotReadiness = {
  status: "ready" | "blocked" | "degraded";
  checkedAt: string;
  blockers: ProductionPilotReadinessCheck[];
  degraded: ProductionPilotReadinessCheck[];
  checks: ProductionPilotReadinessCheck[];
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

export type MachineClaimCodeSnapshot = {
  id: string;
  machineId: string;
  machineCode: string;
  purpose?: MachineClaimCodePurpose;
  state: MachineClaimCodeState;
  expiresAt: string;
  failedAttemptCount: number;
  maxFailedAttempts: number;
  createdAt: string;
  consumedAt?: string | null;
  revokedAt?: string | null;
  lockedAt?: string | null;
};

export type MachineClaimCodeListResult = {
  items: MachineClaimCodeSnapshot[];
};

export type GenerateMachineClaimCodeResult = MachineClaimCodeSnapshot & {
  claimCode: string;
};

export type CreateMachineInput = {
  code: string;
  name: string;
  locationLabel?: string | null;
  geoLocation?: MachineGeoLocation | null;
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

export async function getExternalNaturalEnvironment(
  id: string,
): Promise<ExternalNaturalEnvironment> {
  return await get<ExternalNaturalEnvironment>(
    `/machines/${id}/external-natural-environment`,
  );
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

export async function listMachineClaimCodes(
  machineId: string,
): Promise<MachineClaimCodeListResult> {
  return await get<MachineClaimCodeListResult>(
    `/machines/${machineId}/claim-codes`,
  );
}

export async function generateMachineClaimCode(
  machineId: string,
  body?: { purpose: MachineClaimCodePurpose },
): Promise<GenerateMachineClaimCodeResult> {
  return await post<GenerateMachineClaimCodeResult>(
    `/machines/${machineId}/claim-codes`,
    body ?? {},
  );
}

export async function revokeMachineClaimCode(
  machineId: string,
  claimCodeId: string,
): Promise<MachineClaimCodeSnapshot> {
  return await post<MachineClaimCodeSnapshot>(
    `/machines/${machineId}/claim-codes/${claimCodeId}/revoke`,
    {},
  );
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
    `/machines/${machineId}/credentials/rotate`,
    {},
  );
}
