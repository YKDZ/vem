import { describe, expect, it, vi } from "vitest";

import { get, patchContract, postContract } from "@/api/request";

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
  get: vi.fn().mockResolvedValue({}),
  getContract: vi.fn().mockResolvedValue({}),
  patchContract: vi.fn().mockResolvedValue({}),
  patch: vi.fn(),
  post: vi.fn(),
  postContract: vi.fn().mockResolvedValue({}),
}));

describe("machines api", () => {
  it("reads External Natural Environment diagnostics for a selected machine", async () => {
    await getExternalNaturalEnvironment("550e8400-e29b-41d4-a716-446655440000");

    expect(get).toHaveBeenCalledWith(
      "/machines/550e8400-e29b-41d4-a716-446655440000/external-natural-environment",
    );
  });

  it("uses schema-bound helpers for platform machine writes", async () => {
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

    expect(postContract).toHaveBeenCalledWith(
      "/machines",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ code: "M-001" }),
    );
    expect(patchContract).toHaveBeenCalledWith(
      "/machines/550e8400-e29b-41d4-a716-446655440001",
      expect.any(Object),
      expect.any(Object),
      { geoLocation: null },
    );
  });

  it("uses schema-bound helpers for machine operation writes", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440001";
    const claimCodeId = "550e8400-e29b-41d4-a716-446655440002";

    await commandEnvironment(machineId, { airConditionerOn: true });
    await createMachineSlot(machineId, {
      layerNo: 1,
      cellNo: 1,
      slotCode: "A1",
      capacity: 10,
    });
    await generateMachineClaimCode(machineId, { purpose: "reclaim" });
    await revokeMachineClaimCode(machineId, claimCodeId);
    await rotateMachineCredentials(machineId);

    expect(postContract).toHaveBeenCalledWith(
      `/machines/${machineId}/commands/environment-control`,
      expect.any(Object),
      expect.any(Object),
      { airConditionerOn: true },
    );
    expect(postContract).toHaveBeenCalledWith(
      `/machines/${machineId}/slots`,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ slotCode: "A1" }),
    );
    expect(postContract).toHaveBeenCalledWith(
      `/machines/${machineId}/claim-codes`,
      expect.any(Object),
      expect.any(Object),
      { purpose: "reclaim" },
    );
    expect(postContract).toHaveBeenCalledWith(
      `/machines/${machineId}/claim-codes/${claimCodeId}/revoke`,
      expect.any(Object),
      expect.any(Object),
      {},
    );
    expect(postContract).toHaveBeenCalledWith(
      `/machines/${machineId}/credentials/rotate`,
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });
});
