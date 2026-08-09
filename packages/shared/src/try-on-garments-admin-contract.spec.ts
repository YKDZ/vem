import { describe, expect, it } from "vitest";

import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminTryOnGarmentUploadContract,
  adminTryOnGarmentConfirmationContract,
} from "./schemas/try-on-garments";

const id = "550e8400-e29b-41d4-a716-446655440124";

describe("Try-On Garment Admin Endpoint Contracts", () => {
  it("defines the complete immutable PNG upload boundary", () => {
    expect(adminTryOnGarmentUploadContract.method).toBe("POST");
    expect(adminTryOnGarmentUploadContract.path).toBe(
      "/media-assets/try-on-garments",
    );
    expect(adminTryOnGarmentUploadContract.querySchema.parse({})).toEqual({});
    expect(
      adminTryOnGarmentUploadContract.responseSchema.parse({
        id,
        managedReference: `/api/media-assets/${id}/content`,
        purpose: "try_on_garment",
        contentType: "image/png",
        byteSize: 2048,
        width: 768,
        height: 1024,
        hasTransparency: true,
        sha256: "a".repeat(64),
      }),
    ).toMatchObject({ purpose: "try_on_garment", hasTransparency: true });
  });

  it("allows only the two explicit T-shirt templates at the draft boundary", () => {
    expect(adminCreateTryOnGarmentContract.method).toBe("POST");
    expect(adminCreateTryOnGarmentContract.path).toBe("/try-on-garments");
    expect(
      adminCreateTryOnGarmentContract.bodySchema.parse({
        productId: id,
        colorLabel: "海军蓝",
        sourceMediaAssetId: id,
        template: "tshirt_short_sleeve",
      }).template,
    ).toBe("tshirt_short_sleeve");
    expect(
      adminCreateTryOnGarmentContract.bodySchema.parse({
        productId: id,
        colorLabel: "海军蓝",
        sourceMediaAssetId: id,
        template: "tshirt_long_sleeve",
      }).template,
    ).toBe("tshirt_long_sleeve");
    expect(() =>
      adminCreateTryOnGarmentContract.bodySchema.parse({
        productId: id,
        colorLabel: "海军蓝",
        sourceMediaAssetId: id,
        template: "hoodie",
      }),
    ).toThrow();
  });

  it("binds confirmation and retrieval path parameters, request, and response", () => {
    expect(adminTryOnGarmentConfirmationContract.method).toBe("POST");
    expect(adminTryOnGarmentConfirmationContract.path).toBe(
      "/try-on-garments/:id/confirmation",
    );
    expect(
      adminTryOnGarmentConfirmationContract.pathParamsSchema.parse({ id }),
    ).toEqual({ id });
    expect(adminTryOnGarmentConfirmationContract.bodySchema.parse({})).toEqual(
      {},
    );
    expect(adminGetTryOnGarmentContract.method).toBe("GET");
    expect(adminGetTryOnGarmentContract.path).toBe("/try-on-garments/:id");
    expect(adminGetTryOnGarmentContract.pathParamsSchema.parse({ id })).toEqual(
      { id },
    );
  });
});
