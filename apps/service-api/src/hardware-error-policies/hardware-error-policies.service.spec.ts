import { HARDWARE_ERROR_HANDLING } from "@vem/shared";
import { describe, expect, it } from "vitest";

import { HardwareErrorPoliciesService } from "./hardware-error-policies.service";

function makeServiceWithQuery(queryResult: unknown[]) {
  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queryResult,
          orderBy: async () => queryResult,
        }),
      }),
    }),
  };

  return new HardwareErrorPoliciesService(mockDb as never);
}

describe("HardwareErrorPoliciesService", () => {
  it("falls back to shared defaults for unknown error code", async () => {
    const service = makeServiceWithQuery([]);
    const result = await service.getPolicy("UNKNOWN");
    expect(result).toEqual(HARDWARE_ERROR_HANDLING["UNKNOWN"]);
  });

  it("falls back to NULL_ERROR default when errorCode is null and no DB row", async () => {
    const service = makeServiceWithQuery([]);
    const result = await service.getPolicy(null);
    expect(result).toEqual(HARDWARE_ERROR_HANDLING["NULL_ERROR"]);
  });

  it("returns DB config when present", async () => {
    const dbRow = {
      errorCode: "NO_DROP",
      restoreInventory: true,
      faultSlot: false,
      requestRefund: false,
      createWorkOrder: true,
      severity: "warning" as const,
      status: "enabled",
    };
    const service = makeServiceWithQuery([dbRow]);
    const result = await service.getPolicy("NO_DROP");
    expect(result.errorCode).toBe("NO_DROP");
    expect(result.restoreInventory).toBe(true);
    expect(result.severity).toBe("warning");
  });

  it("maps NULL_ERROR DB row to errorCode=null", async () => {
    const dbRow = {
      errorCode: "NULL_ERROR",
      restoreInventory: false,
      faultSlot: true,
      requestRefund: true,
      createWorkOrder: true,
      severity: "critical" as const,
      status: "enabled",
    };
    const service = makeServiceWithQuery([dbRow]);
    const result = await service.getPolicy(null);
    expect(result.errorCode).toBeNull();
  });
});
