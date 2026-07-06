import { beforeEach, describe, expect, it, vi } from "vitest";

import { getContract, postContract } from "@/api/request";

import { markNotificationRead } from "./notifications";
import {
  createOrderRecoveryAction,
  getOrderInvestigation,
  requestRefund,
} from "./orders";
import { resolveWorkOrder } from "./work-orders";

vi.mock("@/api/request", () => ({
  get: vi.fn(),
  getContract: vi.fn().mockResolvedValue({}),
  post: vi.fn(),
  postContract: vi.fn().mockResolvedValue({}),
}));

describe("recovery and maintenance admin api contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getContract).mockResolvedValue({});
    vi.mocked(postContract).mockResolvedValue({});
  });

  it("uses schema-bound helpers for order recovery actions and refund requests", async () => {
    await createOrderRecoveryAction("550e8400-e29b-41d4-a716-446655440000", {
      action: "confirm_not_dispensed",
      note: "operator found the item still in the slot",
    });
    await requestRefund("550e8400-e29b-41d4-a716-446655440001");

    expect(postContract).toHaveBeenCalledWith(
      "/orders/550e8400-e29b-41d4-a716-446655440000/recovery-actions",
      expect.any(Object),
      expect.any(Object),
      {
        action: "confirm_not_dispensed",
        note: "operator found the item still in the slot",
      },
    );
    expect(postContract).toHaveBeenCalledWith(
      "/orders/550e8400-e29b-41d4-a716-446655440001/refund",
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });

  it("uses schema-bound helpers for work order resolution and notification read handling", async () => {
    await resolveWorkOrder(
      "550e8400-e29b-41d4-a716-446655440002",
      "replaced jammed spring and verified dispense",
    );
    await markNotificationRead("550e8400-e29b-41d4-a716-446655440003");

    expect(postContract).toHaveBeenCalledWith(
      "/maintenance-work-orders/550e8400-e29b-41d4-a716-446655440002/resolve",
      expect.any(Object),
      expect.any(Object),
      { resolutionNote: "replaced jammed spring and verified dispense" },
    );
    expect(postContract).toHaveBeenCalledWith(
      "/notifications/550e8400-e29b-41d4-a716-446655440003/read",
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });

  it("parses order investigation key response through the shared contract", async () => {
    await getOrderInvestigation("550e8400-e29b-41d4-a716-446655440004");

    expect(getContract).toHaveBeenCalledWith(
      "/orders/550e8400-e29b-41d4-a716-446655440004/investigation",
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });

  it("rejects invalid recovery action bodies through the schema-bound helper", async () => {
    vi.mocked(postContract).mockImplementation(
      async (_url, bodySchema, _responseSchema, body) => {
        (bodySchema as { parse(value: unknown): unknown }).parse(body);
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
