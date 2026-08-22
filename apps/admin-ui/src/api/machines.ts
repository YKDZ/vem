import type { z } from "zod";

import {
  adminCommandMachineEnvironmentContract,
  adminCreateMachineContract,
  adminCreateMachineSlotContract,
  adminGenerateMachineClaimCodeContract,
  adminGetMachineContract,
  adminGetMachineExternalNaturalEnvironmentContract,
  adminListMachineClaimCodesContract,
  adminListMachineSlotsContract,
  adminListMachinesContract,
  adminRevokeMachineClaimCodeContract,
  adminRotateMachineCredentialsContract,
  adminUpdateMachineContract,
  createMachineSchema,
  createMachineSlotSchema,
  generateMachineClaimCodeRequestSchema,
  machineEnvironmentControlRequestSchema,
  pageQuerySchema,
  updateMachineSchema,
  type AdminMachineCommandResponse,
  type AdminMachineResponse,
  type AdminMachineSlotResponse,
  type ExternalNaturalEnvironment,
  type GenerateMachineClaimCodeResponse,
  type MachineClaimCodeListResponse,
  type MachineClaimCodeSnapshot,
  type PageResult,
  type RotateMachineCredentialsResponse,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type MachineGeoLocation = {
  latitude: number;
  longitude: number;
  timezone: string;
};

export type Machine = AdminMachineResponse;
export type MachineCommand = AdminMachineCommandResponse;
export type MachineSlot = AdminMachineSlotResponse;
export type MachineClaimCodeListResult = MachineClaimCodeListResponse;
export type GenerateMachineClaimCodeResult = GenerateMachineClaimCodeResponse;
export type { MachineClaimCodeSnapshot, PageResult };

function toMachine(response: AdminMachineResponse): Machine {
  return response;
}

export async function listMachines(
  query?: z.input<typeof pageQuerySchema>,
): Promise<PageResult<Machine>> {
  const page = await callAdminEndpointContract(adminListMachinesContract, {
    query: query ?? {},
  });
  return {
    ...page,
    items: page.items.map(toMachine),
  };
}

export async function getMachine(id: string): Promise<Machine> {
  return toMachine(
    await callAdminEndpointContract(adminGetMachineContract, {
      pathParams: { id },
    }),
  );
}

export async function getExternalNaturalEnvironment(
  id: string,
): Promise<ExternalNaturalEnvironment> {
  return await callAdminEndpointContract(
    adminGetMachineExternalNaturalEnvironmentContract,
    { pathParams: { id } },
  );
}

export async function createMachine(
  body: z.input<typeof createMachineSchema>,
): Promise<Machine> {
  return toMachine(
    await callAdminEndpointContract(adminCreateMachineContract, { body }),
  );
}

export async function updateMachine(
  id: string,
  body: z.input<typeof updateMachineSchema>,
): Promise<Machine> {
  return toMachine(
    await callAdminEndpointContract(adminUpdateMachineContract, {
      pathParams: { id },
      body,
    }),
  );
}

export async function commandEnvironment(
  id: string,
  body: z.input<typeof machineEnvironmentControlRequestSchema>,
): Promise<MachineCommand> {
  return await callAdminEndpointContract(
    adminCommandMachineEnvironmentContract,
    { pathParams: { id }, body },
  );
}

export async function listMachineSlots(
  machineId: string,
): Promise<MachineSlot[]> {
  return await callAdminEndpointContract(adminListMachineSlotsContract, {
    pathParams: { id: machineId },
  });
}

export async function createMachineSlot(
  machineId: string,
  body: z.input<typeof createMachineSlotSchema>,
): Promise<MachineSlot> {
  return await callAdminEndpointContract(adminCreateMachineSlotContract, {
    pathParams: { id: machineId },
    body,
  });
}

export async function listMachineClaimCodes(
  machineId: string,
): Promise<MachineClaimCodeListResult> {
  return await callAdminEndpointContract(adminListMachineClaimCodesContract, {
    pathParams: { id: machineId },
  });
}

export async function generateMachineClaimCode(
  machineId: string,
  body?: z.input<typeof generateMachineClaimCodeRequestSchema>,
): Promise<GenerateMachineClaimCodeResult> {
  return await callAdminEndpointContract(
    adminGenerateMachineClaimCodeContract,
    { pathParams: { id: machineId }, body: body ?? {} },
  );
}

export async function revokeMachineClaimCode(
  machineId: string,
  claimCodeId: string,
): Promise<MachineClaimCodeSnapshot> {
  return await callAdminEndpointContract(adminRevokeMachineClaimCodeContract, {
    pathParams: { id: machineId, claimCodeId },
    body: {},
  });
}

export type RotateCredentialsResult = RotateMachineCredentialsResponse;

export async function rotateMachineCredentials(
  machineId: string,
): Promise<RotateCredentialsResult> {
  return await callAdminEndpointContract(
    adminRotateMachineCredentialsContract,
    { pathParams: { id: machineId }, body: {} },
  );
}
