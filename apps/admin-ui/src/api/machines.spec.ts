import { describe, expect, it, vi } from "vitest";

import { get } from "@/api/request";

import { getExternalNaturalEnvironment } from "./machines";

vi.mock("@/api/request", () => ({
  get: vi.fn().mockResolvedValue({}),
  patch: vi.fn(),
  post: vi.fn(),
}));

describe("machines api", () => {
  it("reads External Natural Environment diagnostics for a selected machine", async () => {
    await getExternalNaturalEnvironment("550e8400-e29b-41d4-a716-446655440000");

    expect(get).toHaveBeenCalledWith(
      "/machines/550e8400-e29b-41d4-a716-446655440000/external-natural-environment",
    );
  });
});
