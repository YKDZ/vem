import { BadRequestException } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaAssetsService } from "./media-assets.service";

describe("MediaAssetsService", () => {
  let storageRoot: string;
  const db = { insert: vi.fn(), select: vi.fn() };

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "vem-media-assets-"));
    vi.resetAllMocks();
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "550e8400-e29b-41d4-a716-446655440124",
            purpose: "product_display_image",
            storageProvider: "local",
            storageKey:
              "product-display-images/550e8400-e29b-41d4-a716-446655440124.jpg",
            contentType: "image/jpeg",
            byteSize: 4,
            publicUrl:
              "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
          },
        ]),
      }),
    });
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("stores a product display image as a local media asset with a public URL", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });

    const asset = await service.storeProductDisplayImage({
      originalname: "shirt.jpg",
      mimetype: "image/jpeg",
      size: 4,
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });

    expect(asset).toEqual(
      expect.objectContaining({
        purpose: "product_display_image",
        storageProvider: "local",
        contentType: "image/jpeg",
        byteSize: 4,
        publicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      }),
    );
  });

  it.each([
    ["SVG", "image/svg+xml", Buffer.from("<svg />")],
    ["unsupported image type", "image/gif", Buffer.from("GIF89a")],
    [
      "spoofed JPEG metadata",
      "image/jpeg",
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' />"),
    ],
    ["arbitrary PNG bytes", "image/png", Buffer.from("not actually a png")],
  ])("rejects %s uploads", async (_name, mimetype, buffer) => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });

    await expect(
      service.storeProductDisplayImage({
        originalname: "asset",
        mimetype,
        size: buffer.byteLength,
        buffer,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects product display images larger than 5 MB", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });

    await expect(
      service.storeProductDisplayImage({
        originalname: "large.jpg",
        mimetype: "image/jpeg",
        size: 5 * 1024 * 1024 + 1,
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
