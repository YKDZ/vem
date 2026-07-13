import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
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
    ["uploadProductDisplayImage", "storeProductDisplayImage"],
    ["uploadTryOnSilhouette", "storeTryOnSilhouette"],
  ] as const)(
    "projects %s responses to the strict admin media summary contract",
    async (controllerMethod, serviceMethod) => {
      const stored = {
        id: "550e8400-e29b-41d4-a716-446655440125",
        purpose: "try_on_silhouette",
        storageKey: "private/storage-key.png",
        sha256: "private-digest",
        publicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        contentType: "image/png",
      };
      const mediaAssetsService = {
        storeProductDisplayImage: vi.fn().mockResolvedValue(stored),
        storeTryOnSilhouette: vi.fn().mockResolvedValue(stored),
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
