import "reflect-metadata";
import { describe, expect, it } from "vitest";

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
});
