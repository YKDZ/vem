import { describe, expect, it } from "vitest";

import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminListTryOnGarmentsByProductContract,
  adminTryOnGarmentUploadContract,
  adminTryOnGarmentConfirmationContract,
  adminTryOnGarmentActivationContract,
  adminTryOnGarmentAssociationContract,
  adminTryOnGarmentSourceReplacementContract,
} from "./schemas/try-on-garments";

const id = "550e8400-e29b-41d4-a716-446655440124";

describe("Try-On Garment Admin Endpoint Contracts", () => {
  it("defines the complete immutable PNG upload boundary", () => {
    expect(adminTryOnGarmentUploadContract.method).toBe("POST");
    expect(adminTryOnGarmentUploadContract.path).toBe(
      "/media-assets/try-on-garments",
    );
    expect(adminTryOnGarmentUploadContract.querySchema.parse({})).toEqual({});
    expect(() =>
      adminTryOnGarmentUploadContract.bodySchema.parse({
        file: { unexpected: true },
      }),
    ).toThrow();
    expect(() =>
      adminTryOnGarmentUploadContract.bodySchema.parse({
        file: new Blob([new Uint8Array([1])], { type: "image/png" }),
        unexpected: true,
      }),
    ).toThrow();
    expect(
      adminTryOnGarmentUploadContract.bodySchema.parse({
        file: new Blob([new Uint8Array([1])], { type: "image/png" }),
      }).file,
    ).toBeInstanceOf(Blob);
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

  it("binds confirmation, retrieval, and product management list boundaries", () => {
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
    expect(adminListTryOnGarmentsByProductContract.method).toBe("GET");
    expect(adminListTryOnGarmentsByProductContract.path).toBe(
      "/try-on-garments",
    );
    expect(
      adminListTryOnGarmentsByProductContract.querySchema.parse({
        productId: id,
      }),
    ).toEqual({ productId: id });
  });

  it("defines an explicit confirmed-draft activation boundary", () => {
    expect(adminTryOnGarmentActivationContract.method).toBe("POST");
    expect(adminTryOnGarmentActivationContract.path).toBe(
      "/try-on-garments/:id/activation",
    );
    expect(
      adminTryOnGarmentActivationContract.pathParamsSchema.parse({ id }),
    ).toEqual({ id });
    expect(adminTryOnGarmentActivationContract.bodySchema.parse({})).toEqual(
      {},
    );
  });

  it("binds explicit same-product variant associations and atomic source replacement", () => {
    expect(adminTryOnGarmentAssociationContract.method).toBe("PUT");
    expect(adminTryOnGarmentAssociationContract.path).toBe(
      "/try-on-garments/:id/variant-associations",
    );
    expect(
      adminTryOnGarmentAssociationContract.bodySchema.parse({
        variantIds: [id, "550e8400-e29b-41d4-a716-446655440125"],
      }),
    ).toEqual({
      variantIds: [id, "550e8400-e29b-41d4-a716-446655440125"],
    });
    expect(
      adminTryOnGarmentAssociationContract.bodySchema.parse({ variantIds: [] }),
    ).toEqual({ variantIds: [] });

    expect(adminTryOnGarmentSourceReplacementContract.method).toBe("PATCH");
    expect(adminTryOnGarmentSourceReplacementContract.path).toBe(
      "/try-on-garments/:id/source",
    );
    expect(
      adminTryOnGarmentSourceReplacementContract.bodySchema.parse({
        sourceMediaAssetId: id,
        template: "tshirt_long_sleeve",
      }),
    ).toEqual({ sourceMediaAssetId: id, template: "tshirt_long_sleeve" });
  });
});
