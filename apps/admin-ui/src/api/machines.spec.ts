import {
  adminCommandMachineEnvironmentContract,
  adminCreateMachineContract,
  adminCreateMachineSlotContract,
  adminGenerateMachineClaimCodeContract,
  adminGetMachineExternalNaturalEnvironmentContract,
  adminRevokeMachineClaimCodeContract,
  adminRotateMachineCredentialsContract,
  adminUpdateMachineContract,
} from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  commandEnvironment,
  createMachine,
  createMachineSlot,
  generateMachineClaimCode,
  getExternalNaturalEnvironment,
  revokeMachineClaimCode,
  rotateMachineCredentials,
  updateMachine,
} from "./machines";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("machines api", () => {
  it("reads External Natural Environment diagnostics through the shared contract", async () => {
    await getExternalNaturalEnvironment("550e8400-e29b-41d4-a716-446655440000");

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetMachineExternalNaturalEnvironmentContract,
      { pathParams: { id: "550e8400-e29b-41d4-a716-446655440000" } },
    );
  });

  it("uses complete shared endpoint contracts for platform machine writes", async () => {
    await createMachine({
      code: "M-001",
      name: "Lobby Machine",
      locationLabel: null,
      geoLocation: {
        latitude: 31.2,
        longitude: 121.5,
        timezone: "Asia/Shanghai",
      },
    });
    await updateMachine("550e8400-e29b-41d4-a716-446655440001", {
      geoLocation: null,
    });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreateMachineContract,
      { body: expect.objectContaining({ code: "M-001" }) },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdateMachineContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440001" },
        body: { geoLocation: null },
      },
    );
  });

  it("uses complete shared endpoint contracts for machine operation writes", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440001";
    const claimCodeId = "550e8400-e29b-41d4-a716-446655440002";

    await commandEnvironment(machineId, { airConditionerOn: true });
    await createMachineSlot(machineId, {
      rowNo: 1,
      cellNo: 1,
      capacity: 10,
    });
    await generateMachineClaimCode(machineId, { purpose: "reclaim" });
    await revokeMachineClaimCode(machineId, claimCodeId);
    await rotateMachineCredentials(machineId);

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCommandMachineEnvironmentContract,
      { pathParams: { id: machineId }, body: { airConditionerOn: true } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreateMachineSlotContract,
      {
        pathParams: { id: machineId },
        body: expect.objectContaining({ rowNo: 1, cellNo: 1 }),
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGenerateMachineClaimCodeContract,
      { pathParams: { id: machineId }, body: { purpose: "reclaim" } },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminRevokeMachineClaimCodeContract,
      {
        pathParams: { id: machineId, claimCodeId },
        body: {},
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminRotateMachineCredentialsContract,
      { pathParams: { id: machineId }, body: {} },
    );
  });
});
