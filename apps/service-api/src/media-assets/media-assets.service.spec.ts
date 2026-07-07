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
              "product-display-images/550e8400-e29b-41d4-a716-446655440124.png",
            contentType: "image/png",
            byteSize: 33,
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
      originalname: "shirt.png",
      mimetype: "image/png",
      size: validPng(1200, 1600).byteLength,
      buffer: validPng(1200, 1600),
    });

    expect(asset).toEqual(
      expect.objectContaining({
        purpose: "product_display_image",
        storageProvider: "local",
        contentType: "image/png",
        byteSize: 33,
        publicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      }),
    );
  });

  it("stores a try-on silhouette as a managed local media asset with the silhouette purpose", async () => {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: "550e8400-e29b-41d4-a716-446655440125",
          purpose: "try_on_silhouette",
          storageProvider: "local",
          storageKey:
            "try-on-silhouettes/550e8400-e29b-41d4-a716-446655440125.png",
          contentType: "image/png",
          byteSize: 8,
          publicUrl:
            "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        },
      ]),
    });
    db.insert.mockReturnValue({ values });
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });

    const asset = await service.storeTryOnSilhouette({
      originalname: "shirt-silhouette.png",
      mimetype: "image/png",
      size: 8,
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "try_on_silhouette",
        storageProvider: "local",
        storageKey: expect.stringMatching(/^try-on-silhouettes\/.+\.png$/),
        contentType: "image/png",
        byteSize: 8,
      }),
    );
    expect(asset).toEqual(
      expect.objectContaining({
        purpose: "try_on_silhouette",
        publicUrl:
          "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
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

  it("rejects product display images outside the 1200 x 1600 px 3:4 spec", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });
    const buffer = validPng(1200, 1200);

    await expect(
      service.storeProductDisplayImage({
        originalname: "square.png",
        mimetype: "image/png",
        size: buffer.byteLength,
        buffer,
      }),
    ).rejects.toThrow("1200 x 1600 px (3:4)");
  });

  it("applies the same V1 image constraints to try-on silhouettes", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });

    await expect(
      service.storeTryOnSilhouette({
        originalname: "silhouette.svg",
        mimetype: "image/svg+xml",
        size: 7,
        buffer: Buffer.from("<svg />"),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.storeTryOnSilhouette({
        originalname: "large.webp",
        mimetype: "image/webp",
        size: 5 * 1024 * 1024 + 1,
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function validPng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    buffer,
    0,
  );
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}
