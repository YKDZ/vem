import { beforeEach, describe, expect, it, vi } from "vitest";

import { getContract, postContract } from "@/api/request";

import {
  createMaintenanceSession,
  getMaintenanceAccessOverview,
} from "./maintenance-access";

vi.mock("@/api/request", () => ({
  getContract: vi.fn().mockResolvedValue({}),
  postContract: vi.fn().mockResolvedValue({}),
}));

describe("maintenance access admin api", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses shared contracts for the overview and session creation", async () => {
    await getMaintenanceAccessOverview();
    await createMaintenanceSession({
      sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
      targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
      reason: "Investigate Windows runtime failure",
      ttlMinutes: 30,
    });

    expect(getContract).toHaveBeenCalledWith(
      "/maintenance-access",
      expect.any(Object),
      expect.any(Object),
      {},
    );
    expect(postContract).toHaveBeenCalledWith(
      "/maintenance-access/sessions",
      expect.any(Object),
      expect.any(Object),
      {
        sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
        targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 30,
      },
    );
  });
});
