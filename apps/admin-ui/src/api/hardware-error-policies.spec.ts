import {
  adminListHardwareErrorPoliciesContract,
  adminUpsertHardwareErrorPolicyContract,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  listHardwareErrorPolicies,
  upsertHardwareErrorPolicy,
} from "./hardware-error-policies";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("hardware error policies api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callAdminEndpointContract).mockResolvedValue([]);
  });

  it("uses complete shared endpoint contracts for list and upsert", async () => {
    await listHardwareErrorPolicies();
    await upsertHardwareErrorPolicy({
      errorCode: null,
      restoreInventory: true,
      faultSlot: true,
      requestRefund: true,
      createWorkOrder: true,
      severity: "critical",
    });

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListHardwareErrorPoliciesContract,
      {},
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpsertHardwareErrorPolicyContract,
      {
        body: expect.objectContaining({
          restoreInventory: true,
          severity: "critical",
        }),
      },
    );
  });
});
