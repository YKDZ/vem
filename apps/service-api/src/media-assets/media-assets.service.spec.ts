import { BadRequestException } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaAssetsService } from "./media-assets.service";

function transparentPng(width = 256, height = 256): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * (width * 4 + 1);
    pixels[rowOffset] = 0;
    for (
      let column = Math.floor(width / 4);
      column < Math.ceil((width * 3) / 4);
      column += 1
    ) {
      if (row < Math.floor(height / 4) || row >= Math.ceil((height * 3) / 4))
        continue;
      const pixelOffset = rowOffset + 1 + column * 4;
      pixels[pixelOffset] = 20;
      pixels[pixelOffset + 1] = 50;
      pixels[pixelOffset + 2] = 180;
      pixels[pixelOffset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 0);
  return Buffer.concat([header, data, crc]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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

  it("persists its configured absolute public URL while catalog consumers use the asset identity", async () => {
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([]),
    });
    db.insert.mockReturnValue({ values });
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: "https://media.example/api",
    });

    await service.storeProductDisplayImage({
      originalname: "shirt.jpg",
      mimetype: "image/jpeg",
      size: 4,
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        publicUrl: expect.stringMatching(
          /^https:\/\/media\.example\/api\/media-assets\/[0-9a-f-]+\/content$/,
        ),
      }),
    );
  });

  it("stores a transparent PNG try-on garment with immutable media facts", async () => {
    const garment = transparentPng();
    const values = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: "550e8400-e29b-41d4-a716-446655440125",
          purpose: "try_on_garment",
          storageProvider: "local",
          storageKey:
            "try-on-garments/550e8400-e29b-41d4-a716-446655440125.png",
          contentType: "image/png",
          byteSize: garment.byteLength,
          width: 256,
          height: 256,
          hasTransparency: true,
          sha256: "a".repeat(64),
        },
      ]),
    });
    db.insert.mockReturnValue({ values });
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });

    await expect(
      service.storeTryOnGarment({
        originalname: "shirt.png",
        mimetype: "image/png",
        size: garment.byteLength,
        buffer: garment,
      }),
    ).resolves.toMatchObject({
      purpose: "try_on_garment",
      contentType: "image/png",
      byteSize: garment.byteLength,
      width: 256,
      height: 256,
      hasTransparency: true,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "try_on_garment",
        contentType: "image/png",
        width: 256,
        height: 256,
        hasTransparency: true,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("rejects unsupported and undersized Try-On Garment media with stable errors", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });
    const undersized = transparentPng(1, 1);

    await expect(
      service.storeTryOnGarment({
        originalname: "shirt.jpg",
        mimetype: "image/jpeg",
        size: 4,
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
    ).rejects.toMatchObject({ message: "TRY_ON_GARMENT_PNG_REQUIRED" });
    await expect(
      service.storeTryOnGarment({
        originalname: "tiny-shirt.png",
        mimetype: "image/png",
        size: undersized.byteLength,
        buffer: undersized,
      }),
    ).rejects.toMatchObject({
      message: "TRY_ON_GARMENT_DIMENSIONS_TOO_SMALL",
    });
  });

  it("rejects transparent-but-empty and one-transparent-pixel model-photo disguises", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });
    const transparentOnly = pngFromPixels(256, 256, () => [0, 0, 0, 0]);
    const oneTransparentPixel = pngFromPixels(256, 256, (x, y) =>
      x === 0 && y === 0 ? [0, 0, 0, 0] : [40, 80, 160, 255],
    );

    await expect(
      service.storeTryOnGarment({
        originalname: "empty.png",
        mimetype: "image/png",
        size: transparentOnly.byteLength,
        buffer: transparentOnly,
      }),
    ).rejects.toMatchObject({
      message: "TRY_ON_GARMENT_VISIBLE_PIXELS_REQUIRED",
    });
    await expect(
      service.storeTryOnGarment({
        originalname: "model-photo.png",
        mimetype: "image/png",
        size: oneTransparentPixel.byteLength,
        buffer: oneTransparentPixel,
      }),
    ).rejects.toMatchObject({
      message: "TRY_ON_GARMENT_TRANSPARENCY_REQUIRED",
    });
  });

  it("keeps near-transparent and near-opaque alpha from satisfying both image facts", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });
    const alphaOne = pngFromPixels(256, 256, () => [40, 80, 160, 1]);
    const alpha254 = pngFromPixels(256, 256, () => [40, 80, 160, 254]);

    await expect(
      service.storeTryOnGarment({
        originalname: "alpha-one.png",
        mimetype: "image/png",
        size: alphaOne.byteLength,
        buffer: alphaOne,
      }),
    ).rejects.toMatchObject({
      message: "TRY_ON_GARMENT_VISIBLE_PIXELS_REQUIRED",
    });
    await expect(
      service.storeTryOnGarment({
        originalname: "alpha-254.png",
        mimetype: "image/png",
        size: alpha254.byteLength,
        buffer: alpha254,
      }),
    ).rejects.toMatchObject({
      message: "TRY_ON_GARMENT_TRANSPARENCY_REQUIRED",
    });
  });

  it("decodes common transparent PNG forms and rejects damaged scanlines or unknown critical chunks", async () => {
    const service = new MediaAssetsService(db as never, {
      mediaAssetStorageRoot: storageRoot,
      mediaAssetPublicBaseUrl: undefined,
    });
    const grayscaleAlpha = grayscaleAlphaPng(256, 256);
    await expect(
      service.storeTryOnGarment({
        originalname: "shirt-gray-alpha.png",
        mimetype: "image/png",
        size: grayscaleAlpha.byteLength,
        buffer: grayscaleAlpha,
      }),
    ).resolves.toBeDefined();

    const paletteWithTransparency = paletteTransparencyPng(256, 256);
    await expect(
      service.storeTryOnGarment({
        originalname: "shirt-palette.png",
        mimetype: "image/png",
        size: paletteWithTransparency.byteLength,
        buffer: paletteWithTransparency,
      }),
    ).resolves.toBeDefined();

    const damaged = Buffer.from(transparentPng());
    damaged[damaged.length - 16] ^= 0xff;
    await expect(
      service.storeTryOnGarment({
        originalname: "damaged.png",
        mimetype: "image/png",
        size: damaged.byteLength,
        buffer: damaged,
      }),
    ).rejects.toMatchObject({ message: "TRY_ON_GARMENT_PNG_INVALID" });

    const unknownCritical = Buffer.concat([
      transparentPng().subarray(0, 33),
      pngChunk("ABCD", Buffer.alloc(0)),
      transparentPng().subarray(33),
    ]);
    await expect(
      service.storeTryOnGarment({
        originalname: "unknown-critical.png",
        mimetype: "image/png",
        size: unknownCritical.byteLength,
        buffer: unknownCritical,
      }),
    ).rejects.toMatchObject({ message: "TRY_ON_GARMENT_PNG_INVALID" });
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

function pngFromPixels(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const value = pixel(x, y);
      pixels.set(value, rowOffset + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function grayscaleAlphaPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  const pixels = Buffer.alloc((width * 2 + 1) * height);
  for (
    let y = Math.floor(height / 4);
    y < Math.ceil((height * 3) / 4);
    y += 1
  ) {
    const rowOffset = y * (width * 2 + 1);
    for (
      let x = Math.floor(width / 4);
      x < Math.ceil((width * 3) / 4);
      x += 1
    ) {
      pixels[rowOffset + 1 + x * 2] = 90;
      pixels[rowOffset + 1 + x * 2 + 1] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function paletteTransparencyPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const rows = Buffer.alloc((width + 1) * height);
  for (
    let y = Math.floor(height / 4);
    y < Math.ceil((height * 3) / 4);
    y += 1
  ) {
    const rowOffset = y * (width + 1);
    for (
      let x = Math.floor(width / 4);
      x < Math.ceil((width * 3) / 4);
      x += 1
    ) {
      rows[rowOffset + 1 + x] = 1;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", Buffer.from([0, 0, 0, 40, 80, 160])),
    pngChunk("tRNS", Buffer.from([0, 255])),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
