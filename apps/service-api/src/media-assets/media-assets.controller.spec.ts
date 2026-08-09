import "reflect-metadata";
import {
  adminProductDisplayImageUploadContract,
  adminTryOnGarmentUploadContract,
} from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { ADMIN_ENDPOINT_CONTRACT } from "../common/admin-endpoint-contract.decorator";
import { MediaAssetsController } from "./media-assets.controller";

describe("MediaAssetsController", () => {
  it("requires product write permission for uploads and keeps public content readable", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        MediaAssetsController.prototype.uploadProductDisplayImage,
      ),
    ).toEqual(["products.write"]);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        MediaAssetsController.prototype.readPublicContent,
      ),
    ).toBe(true);
  });

  it.each([
    ["uploadProductDisplayImage", adminProductDisplayImageUploadContract],
    ["uploadTryOnGarment", adminTryOnGarmentUploadContract],
  ] as const)(
    "binds %s directly to its complete shared endpoint contract",
    (method, contract) => {
      expect(
        Reflect.getMetadata(
          ADMIN_ENDPOINT_CONTRACT,
          MediaAssetsController.prototype[method],
        ),
      ).toBe(contract);
    },
  );

  it("does not retain the deleted silhouette upload operation", () => {
    expect(MediaAssetsController.prototype).not.toHaveProperty(
      "uploadTryOnSilhouette",
    );
  });

  it("declares the complete product display upload contract", () => {
    expect(
      adminProductDisplayImageUploadContract.bodySchema.safeParse({
        file: { unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      adminProductDisplayImageUploadContract.bodySchema.safeParse({
        file: new Blob([new Uint8Array([1])], { type: "image/png" }),
      }).success,
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        ADMIN_ENDPOINT_CONTRACT,
        MediaAssetsController.prototype.uploadProductDisplayImage,
      ),
    ).toBe(adminProductDisplayImageUploadContract);
  });

  it.each([["uploadProductDisplayImage", "storeProductDisplayImage"]] as const)(
    "projects %s responses to the strict admin media summary contract",
    async (controllerMethod, serviceMethod) => {
      const stored = {
        id: "550e8400-e29b-41d4-a716-446655440125",
        purpose: "product_display_image",
        storageKey: "private/storage-key.png",
        sha256: "private-digest",
        publicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        contentType: "image/png",
      };
      const mediaAssetsService = {
        storeProductDisplayImage: vi.fn().mockResolvedValue(stored),
      };
      const controller = new MediaAssetsController(mediaAssetsService as never);

      await expect(controller[controllerMethod]({} as never)).resolves.toEqual({
        id: stored.id,
        publicUrl: stored.publicUrl,
        contentType: stored.contentType,
      });
      expect(mediaAssetsService[serviceMethod]).toHaveBeenCalledOnce();
    },
  );
});
