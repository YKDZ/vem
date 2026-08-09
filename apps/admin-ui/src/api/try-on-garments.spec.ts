import { describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import {
  confirmTryOnGarment,
  createTryOnGarmentDraft,
  getTryOnGarment,
  uploadTryOnGarment,
} from "./try-on-garments";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

const id = "550e8400-e29b-41d4-a716-446655440124";

describe("try-on garments api", () => {
  it("uses complete shared endpoint contracts for upload, draft, retrieval, and confirmation", async () => {
    const file = new File(["png"], "shirt.png", { type: "image/png" });
    await uploadTryOnGarment(file);
    await createTryOnGarmentDraft({
      productId: id,
      colorLabel: "海军蓝",
      sourceMediaAssetId: id,
      template: "tshirt_long_sleeve",
    });
    await getTryOnGarment(id);
    await confirmTryOnGarment(id);

    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        path: "/media-assets/try-on-garments",
        pathParamsSchema: expect.any(Object),
        querySchema: expect.any(Object),
        bodySchema: expect.any(Object),
        responseSchema: expect.any(Object),
      }),
      { body: { file } },
    );
    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "POST", path: "/try-on-garments" }),
      {
        body: {
          productId: id,
          colorLabel: "海军蓝",
          sourceMediaAssetId: id,
          template: "tshirt_long_sleeve",
        },
      },
    );
    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ method: "GET", path: "/try-on-garments/:id" }),
      { pathParams: { id } },
    );
    expect(callAdminEndpointContract).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        method: "POST",
        path: "/try-on-garments/:id/confirmation",
      }),
      { pathParams: { id }, body: {} },
    );
  });
});
