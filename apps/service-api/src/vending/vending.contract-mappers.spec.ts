import { vendingCommandPageResponseSchema } from "@vem/shared";
import { describe, expect, it } from "vitest";

import { toVendingCommandPageResponse } from "./vending.contract-mappers";

describe("vending contract mappers", () => {
  it("projects database-shaped command rows through the published page schema", () => {
    const page = toVendingCommandPageResponse({
      items: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          commandNo: "CMD202607050001",
          orderId: "550e8400-e29b-41d4-a716-446655440001",
          machineId: "550e8400-e29b-41d4-a716-446655440002",
          machineCode: "M001",
          slotId: "550e8400-e29b-41d4-a716-446655440003",
          orderItemId: null,
          status: "acknowledged",
          retryCount: 1,
          sentAt: new Date("2026-07-05T00:00:00.000Z"),
          ackAt: null,
          resultAt: null,
          lastError: null,
          createdAt: new Date("2026-07-05T00:00:00.000Z"),
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    });

    expect(vendingCommandPageResponseSchema.parse(page)).toEqual(page);
    expect(page.items[0]?.sentAt).toBe("2026-07-05T00:00:00.000Z");
  });
});
