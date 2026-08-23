import {
  adminCreateOrderRecoveryActionContract,
  adminGetOrderInvestigationContract,
  adminMarkNotificationReadContract,
  adminRequestOrderRefundContract,
  adminResolveMaintenanceWorkOrderContract,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import { markNotificationRead } from "./notifications";
import {
  createOrderRecoveryAction,
  getOrderInvestigation,
  requestRefund,
} from "./orders";
import { resolveWorkOrder } from "./work-orders";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("recovery and maintenance admin api contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses complete shared endpoint contracts for order recovery actions and refund requests", async () => {
    await createOrderRecoveryAction("550e8400-e29b-41d4-a716-446655440000", {
      action: "confirm_not_dispensed",
      note: "operator found the item still in the slot",
    });
    await requestRefund("550e8400-e29b-41d4-a716-446655440001");

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminCreateOrderRecoveryActionContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440000" },
        body: {
          action: "confirm_not_dispensed",
          note: "operator found the item still in the slot",
        },
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminRequestOrderRefundContract,
      { pathParams: { id: "550e8400-e29b-41d4-a716-446655440001" } },
    );
  });

  it("uses complete shared endpoint contracts for work order resolution and notification read handling", async () => {
    await resolveWorkOrder(
      "550e8400-e29b-41d4-a716-446655440002",
      "replaced jammed spring and verified dispense",
    );
    await markNotificationRead("550e8400-e29b-41d4-a716-446655440003");

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminResolveMaintenanceWorkOrderContract,
      {
        pathParams: { id: "550e8400-e29b-41d4-a716-446655440002" },
        body: {
          resolutionNote: "replaced jammed spring and verified dispense",
        },
      },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminMarkNotificationReadContract,
      { pathParams: { id: "550e8400-e29b-41d4-a716-446655440003" } },
    );
  });

  it("parses order investigation key response through the shared contract", async () => {
    await getOrderInvestigation("550e8400-e29b-41d4-a716-446655440004");

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetOrderInvestigationContract,
      { pathParams: { id: "550e8400-e29b-41d4-a716-446655440004" } },
    );
  });

  it("rejects invalid recovery action bodies through the shared contract", async () => {
    vi.mocked(callAdminEndpointContract).mockImplementation(
      async (contract, input) => {
        const body = (input as { body?: unknown }).body;
        contract.bodySchema.parse(body);
        throw new Error("expected invalid recovery action body");
      },
    );

    const directDatabasePatchRecoveryAction = {
      action: "request_refund" as const,
      note: "operator confirmed no dispense",
      directDatabasePatch: true,
    };
    await expect(
      createOrderRecoveryAction(
        "550e8400-e29b-41d4-a716-446655440000",
        directDatabasePatchRecoveryAction,
      ),
    ).rejects.toThrow();
  });
});
