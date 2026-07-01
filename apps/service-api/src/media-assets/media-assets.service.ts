import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, mediaAssets, type DrizzleClient } from "@vem/db";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";

export const MAX_PRODUCT_DISPLAY_IMAGE_BYTES = 5 * 1024 * 1024;
const PRODUCT_DISPLAY_IMAGE_TYPES = new Map([
  ["image/jpeg", { extension: ".jpg", matches: isJpeg }],
  ["image/png", { extension: ".png", matches: isPng }],
  ["image/webp", { extension: ".webp", matches: isWebp }],
]);

type UploadedImage = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

type MediaAssetsConfig = Pick<
  AppConfigService,
  "mediaAssetStorageRoot" | "mediaAssetPublicBaseUrl"
>;

@Injectable()
export class MediaAssetsService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly config: MediaAssetsConfig,
  ) {}

  async storeProductDisplayImage(file: UploadedImage | undefined) {
    if (!file) {
      throw new BadRequestException("Product display image file is required");
    }
    const imageType = this.validateProductDisplayImage(file);
    const id = randomUUID();
    const storageKey = `product-display-images/${id}${imageType.extension}`;
    const absolutePath = join(this.config.mediaAssetStorageRoot, storageKey);
    const publicUrl = buildPublicAssetUrl(
      id,
      this.config.mediaAssetPublicBaseUrl,
    );

    await mkdir(
      join(this.config.mediaAssetStorageRoot, "product-display-images"),
      {
        recursive: true,
      },
    );
    await writeFile(absolutePath, file.buffer, { flag: "wx" });

    const [created] = await this.db
      .insert(mediaAssets)
      .values({
        id,
        purpose: "product_display_image",
        storageProvider: "local",
        storageKey,
        contentType: imageType.contentType,
        byteSize: file.size,
        originalFilename: file.originalname.slice(0, 255),
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        publicUrl,
      })
      .returning();

    return created;
  }

  async openPublicContent(id: string) {
    const [asset] = await this.db
      .select()
      .from(mediaAssets)
      .where(andAssetIsReadable(id))
      .limit(1);

    if (!asset) {
      throw new NotFoundException("Media asset not found");
    }
    if (asset.storageProvider !== "local") {
      throw new NotFoundException(
        "Media asset content is not locally readable",
      );
    }

    return {
      contentType: asset.contentType,
      stream: createReadStream(
        join(this.config.mediaAssetStorageRoot, asset.storageKey),
      ),
    };
  }

  private validateProductDisplayImage(file: UploadedImage): {
    contentType: string;
    extension: string;
  } {
    if (file.size > MAX_PRODUCT_DISPLAY_IMAGE_BYTES) {
      throw new BadRequestException(
        "Product display image must be 5 MB or less",
      );
    }
    if (file.mimetype === "image/svg+xml") {
      throw new BadRequestException(
        "SVG product display images are not supported",
      );
    }
    const expectedType = PRODUCT_DISPLAY_IMAGE_TYPES.get(file.mimetype);
    if (!expectedType) {
      throw new BadRequestException(
        "Product display image must be JPEG, PNG, or WebP",
      );
    }
    if (!expectedType.matches(file.buffer)) {
      throw new BadRequestException(
        "Product display image content does not match its declared type",
      );
    }
    if (file.buffer.byteLength !== file.size) {
      throw new BadRequestException("Uploaded file size metadata is invalid");
    }
    return {
      contentType: file.mimetype,
      extension: expectedType.extension,
    };
  }
}

function buildPublicAssetUrl(id: string, baseUrl: string | undefined): string {
  const path = `/api/media-assets/${id}/content`;
  if (!baseUrl) return path;

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  if (normalizedBase.endsWith("/api")) {
    return `${normalizedBase}/media-assets/${id}/content`;
  }
  return `${normalizedBase}${path}`;
}

function andAssetIsReadable(id: string) {
  return and(eq(mediaAssets.id, id), isNull(mediaAssets.deletedAt));
}

function isJpeg(buffer: Buffer): boolean {
  return (
    buffer.byteLength >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

function isPng(buffer: Buffer): boolean {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return pngSignature.every((byte, index) => buffer[index] === byte);
}

function isWebp(buffer: Buffer): boolean {
  return (
    buffer.byteLength >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}
