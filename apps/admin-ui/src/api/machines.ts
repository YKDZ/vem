import type {
  AdminMachineCommandResponse,
  AdminMachineResponse,
  AdminMachineSlotResponse,
  ExternalNaturalEnvironment,
  GenerateMachineClaimCodeResponse,
  MachineClaimCodeListResponse,
  MachineClaimCodeSnapshot,
  PageResult,
  ProductionPilotReadinessCheck,
  ProductionPilotReadinessDiagnosticContract,
} from "@vem/shared";

import {
  adminMachineCommandResponseSchema,
  adminMachineContractNoBodySchema,
  adminMachinePageResponseSchema,
  adminMachineResponseSchema,
  adminMachineSlotResponseSchema,
  createMachineSchema,
  createMachineSlotSchema,
  generateMachineClaimCodeRequestSchema,
  generateMachineClaimCodeResponseSchema,
  machineClaimCodeListResponseSchema,
  machineClaimCodeSnapshotSchema,
  machineEnvironmentControlRequestSchema,
  pageQuerySchema,
  rotateMachineCredentialsResponseSchema,
  updateMachineSchema,
  type RotateMachineCredentialsResponse,
} from "@vem/shared";
import { z } from "zod";

import { get, getContract, patchContract, postContract } from "./request";

export type MachineGeoLocation = {
  latitude: number;
  longitude: number;
  timezone: string;
};

export type Machine = AdminMachineResponse & {
  productionPilotReadiness?: ProductionPilotReadinessDiagnosticContract | null;
};

export type MachineCommand = AdminMachineCommandResponse;

export type MachineSlot = AdminMachineSlotResponse;
export type MachineClaimCodeListResult = MachineClaimCodeListResponse;
export type GenerateMachineClaimCodeResult = GenerateMachineClaimCodeResponse;
export type {
  MachineClaimCodeSnapshot,
  PageResult,
  ProductionPilotReadinessCheck,
};

function toMachine(response: AdminMachineResponse): Machine {
  const { productionPilotReadiness, ...machine } = response;
  if (productionPilotReadiness === undefined) {
    return machine;
  }
  return {
    ...machine,
    productionPilotReadiness,
  };
}

export async function listMachines(
  query?: z.input<typeof pageQuerySchema>,
): Promise<PageResult<Machine>> {
  const page = await getContract(
    "/machines",
    pageQuerySchema,
    adminMachinePageResponseSchema,
    query ?? {},
  );
  return {
    ...page,
    items: page.items.map(toMachine),
  };
}

export async function getMachine(id: string): Promise<Machine> {
  return toMachine(await get<AdminMachineResponse>(`/machines/${id}`));
}

export async function getExternalNaturalEnvironment(
  id: string,
): Promise<ExternalNaturalEnvironment> {
  return await get<ExternalNaturalEnvironment>(
    `/machines/${id}/external-natural-environment`,
  );
}

export async function createMachine(
  body: z.input<typeof createMachineSchema>,
): Promise<Machine> {
  return toMachine(
    await postContract(
      "/machines",
      createMachineSchema,
      adminMachineResponseSchema,
      body,
    ),
  );
}

export async function updateMachine(
  id: string,
  body: z.input<typeof updateMachineSchema>,
): Promise<Machine> {
  return toMachine(
    await patchContract(
      `/machines/${id}`,
      updateMachineSchema,
      adminMachineResponseSchema,
      body,
    ),
  );
}

export async function commandEnvironment(
  id: string,
  body: z.input<typeof machineEnvironmentControlRequestSchema>,
): Promise<MachineCommand> {
  return await postContract(
    `/machines/${id}/commands/environment-control`,
    machineEnvironmentControlRequestSchema,
    adminMachineCommandResponseSchema,
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
  body: z.input<typeof createMachineSlotSchema>,
): Promise<MachineSlot> {
  return await postContract(
    `/machines/${machineId}/slots`,
    createMachineSlotSchema,
    adminMachineSlotResponseSchema,
    body,
  );
}

export async function listMachineClaimCodes(
  machineId: string,
): Promise<MachineClaimCodeListResult> {
  return await getContract(
    `/machines/${machineId}/claim-codes`,
    adminMachineContractNoBodySchema,
    machineClaimCodeListResponseSchema,
    {},
  );
}

export async function generateMachineClaimCode(
  machineId: string,
  body?: z.input<typeof generateMachineClaimCodeRequestSchema>,
): Promise<GenerateMachineClaimCodeResult> {
  return await postContract(
    `/machines/${machineId}/claim-codes`,
    generateMachineClaimCodeRequestSchema,
    generateMachineClaimCodeResponseSchema,
    body ?? {},
  );
}

export async function revokeMachineClaimCode(
  machineId: string,
  claimCodeId: string,
): Promise<MachineClaimCodeSnapshot> {
  return await postContract(
    `/machines/${machineId}/claim-codes/${claimCodeId}/revoke`,
    adminMachineContractNoBodySchema,
    machineClaimCodeSnapshotSchema,
    {},
  );
}

export type RotateCredentialsResult = RotateMachineCredentialsResponse;

export async function rotateMachineCredentials(
  machineId: string,
): Promise<RotateCredentialsResult> {
  return await postContract(
    `/machines/${machineId}/credentials/rotate`,
    adminMachineContractNoBodySchema,
    rotateMachineCredentialsResponseSchema,
    {},
  );
}
