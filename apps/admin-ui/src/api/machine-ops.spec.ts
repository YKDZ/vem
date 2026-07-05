import { describe, expect, it, vi } from "vitest";

import { postContract } from "@/api/request";

import { requestLogExport } from "./machine-ops";

vi.mock("@/api/request", () => ({
  getContract: vi.fn().mockResolvedValue([]),
  postContract: vi.fn().mockResolvedValue({}),
}));

describe("machine ops api", () => {
  it("uses schema-bound helpers for admin log export requests", async () => {
    await requestLogExport("550e8400-e29b-41d4-a716-446655440001");

    expect(postContract).toHaveBeenCalledWith(
      "/machine-ops/machines/550e8400-e29b-41d4-a716-446655440001/export-logs",
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });
});
