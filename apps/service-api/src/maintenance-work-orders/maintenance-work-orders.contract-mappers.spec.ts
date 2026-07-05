import { describe, expect, it } from "vitest";

import { mapMaintenanceWorkOrderResolveDtoToPatch } from "./maintenance-work-orders.contract-mappers";

describe("maintenance work order contract mappers", () => {
  it("maps resolution notes into an explicit resolved patch", () => {
    const resolvedAt = new Date("2026-07-05T00:00:00.000Z");

    expect(
      mapMaintenanceWorkOrderResolveDtoToPatch(
        "admin-1",
        { resolutionNote: "  cleared jam and retested  " },
        resolvedAt,
      ),
    ).toEqual({
      status: "resolved",
      assigneeAdminUserId: "admin-1",
      resolutionNote: "cleared jam and retested",
      resolvedAt,
      updatedAt: resolvedAt,
    });
  });
});
