import { adminRequestMachineLogExportContract } from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import { requestLogExport } from "./machine-ops";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("machine ops api", () => {
  it("uses the complete shared endpoint contract for admin log export requests", async () => {
    await requestLogExport("550e8400-e29b-41d4-a716-446655440001");

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminRequestMachineLogExportContract,
      {
        pathParams: { machineId: "550e8400-e29b-41d4-a716-446655440001" },
        body: {},
      },
    );
  });
});
