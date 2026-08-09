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
import { inflateSync } from "node:zlib";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";

export const MAX_PRODUCT_DISPLAY_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TRY_ON_SILHOUETTE_BYTES = MAX_PRODUCT_DISPLAY_IMAGE_BYTES;
export const MAX_TRY_ON_GARMENT_BYTES = 5 * 1024 * 1024;
export const MIN_TRY_ON_GARMENT_DIMENSION = 256;
export const MAX_TRY_ON_GARMENT_DIMENSION = 4096;
const MANAGED_IMAGE_TYPES = new Map([
  ["image/jpeg", { extension: ".jpg", matches: isJpeg }],
  ["image/png", { extension: ".png", matches: isPng }],
  ["image/webp", { extension: ".webp", matches: isWebp }],
]);
type ManagedImagePurpose =
  | "product_display_image"
  | "try_on_silhouette"
  | "try_on_garment";
const MANAGED_IMAGE_PURPOSE_CONFIG = {
  product_display_image: {
    directory: "product-display-images",
    label: "Product display image",
  },
  try_on_silhouette: {
    directory: "try-on-silhouettes",
    label: "Try-on silhouette",
  },
  try_on_garment: {
    directory: "try-on-garments",
    label: "Try-On Garment",
  },
} satisfies Record<ManagedImagePurpose, { directory: string; label: string }>;

type UploadedImage = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

type StoredImageFacts = {
  contentType: string;
  extension: string;
  width?: number;
  height?: number;
  hasTransparency?: boolean;
};

type MediaAssetsConfig = Pick<
  AppConfigService,
  "mediaAssetStorageRoot" | "mediaAssetPublicBaseUrl"
>;

@Injectable()
export class MediaAssetsService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(AppConfigService) private readonly config: MediaAssetsConfig,
  ) {}

  async storeProductDisplayImage(file: UploadedImage | undefined) {
    return await this.storeManagedImage("product_display_image", file);
  }

  async storeTryOnSilhouette(file: UploadedImage | undefined) {
    return await this.storeManagedImage("try_on_silhouette", file);
  }

  async storeTryOnGarment(file: UploadedImage | undefined) {
    return await this.storeManagedImage("try_on_garment", file);
  }

  private async storeManagedImage(
    purpose: ManagedImagePurpose,
    file: UploadedImage | undefined,
  ) {
    const config = MANAGED_IMAGE_PURPOSE_CONFIG[purpose];
    if (!file) {
      throw new BadRequestException(`${config.label} file is required`);
    }
    const imageType =
      purpose === "try_on_garment"
        ? this.validateTryOnGarment(file)
        : this.validateManagedImage(file, config.label);
    const id = randomUUID();
    const storageKey = `${config.directory}/${id}${imageType.extension}`;
    const absolutePath = join(this.config.mediaAssetStorageRoot, storageKey);
    const publicUrl = buildPublicAssetUrl(
      id,
      this.config.mediaAssetPublicBaseUrl,
    );

    await mkdir(join(this.config.mediaAssetStorageRoot, config.directory), {
      recursive: true,
    });
    await writeFile(absolutePath, file.buffer, { flag: "wx" });

    const [created] = await this.db
      .insert(mediaAssets)
      .values({
        id,
        purpose,
        storageProvider: "local",
        storageKey,
        contentType: imageType.contentType,
        byteSize: file.size,
        originalFilename: file.originalname.slice(0, 255),
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        width: imageType.width,
        height: imageType.height,
        hasTransparency: imageType.hasTransparency,
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

  private validateManagedImage(
    file: UploadedImage,
    label: string,
  ): StoredImageFacts {
    if (file.size > MAX_PRODUCT_DISPLAY_IMAGE_BYTES) {
      throw new BadRequestException(`${label} must be 5 MB or less`);
    }
    if (file.mimetype === "image/svg+xml") {
      throw new BadRequestException(
        `SVG ${label.toLowerCase()}s are not supported`,
      );
    }
    const expectedType = MANAGED_IMAGE_TYPES.get(file.mimetype);
    if (!expectedType) {
      throw new BadRequestException(`${label} must be JPEG, PNG, or WebP`);
    }
    if (!expectedType.matches(file.buffer)) {
      throw new BadRequestException(
        `${label} content does not match its declared type`,
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

  private validateTryOnGarment(file: UploadedImage): StoredImageFacts {
    if (file.size > MAX_TRY_ON_GARMENT_BYTES) {
      throw new BadRequestException("TRY_ON_GARMENT_FILE_TOO_LARGE");
    }
    if (file.mimetype !== "image/png" || !isPng(file.buffer)) {
      throw new BadRequestException("TRY_ON_GARMENT_PNG_REQUIRED");
    }
    if (file.buffer.byteLength !== file.size) {
      throw new BadRequestException("TRY_ON_GARMENT_SIZE_INVALID");
    }

    const facts = readTransparentPngFacts(file.buffer);
    if (!facts) {
      throw new BadRequestException("TRY_ON_GARMENT_PNG_INVALID");
    }
    if (
      facts.width < MIN_TRY_ON_GARMENT_DIMENSION ||
      facts.height < MIN_TRY_ON_GARMENT_DIMENSION
    ) {
      throw new BadRequestException("TRY_ON_GARMENT_DIMENSIONS_TOO_SMALL");
    }
    if (
      facts.width > MAX_TRY_ON_GARMENT_DIMENSION ||
      facts.height > MAX_TRY_ON_GARMENT_DIMENSION
    ) {
      throw new BadRequestException("TRY_ON_GARMENT_DIMENSIONS_UNSUPPORTED");
    }
    if (!facts.hasTransparency) {
      throw new BadRequestException("TRY_ON_GARMENT_TRANSPARENCY_REQUIRED");
    }
    return {
      contentType: "image/png",
      extension: ".png",
      width: facts.width,
      height: facts.height,
      hasTransparency: true,
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

function readTransparentPngFacts(
  buffer: Buffer,
): { width: number; height: number; hasTransparency: boolean } | undefined {
  if (buffer.byteLength < 57) return undefined;
  let offset = 8;
  let width: number | undefined;
  let height: number | undefined;
  const idat: Buffer[] = [];
  let sawEnd = false;

  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.byteLength) return undefined;
    const data = buffer.subarray(dataStart, dataEnd);
    if (
      crc32(buffer.subarray(offset + 4, dataEnd)) !==
      buffer.readUInt32BE(dataEnd)
    ) {
      return undefined;
    }
    if (type === "IHDR") {
      if (width !== undefined || length !== 13) return undefined;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        width === 0 ||
        height === 0 ||
        data[8] !== 8 ||
        data[9] !== 6 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        return undefined;
      }
    } else if (type === "IDAT") {
      if (width === undefined) return undefined;
      idat.push(data);
    } else if (type === "IEND") {
      if (
        length !== 0 ||
        width === undefined ||
        height === undefined ||
        dataEnd + 4 !== buffer.byteLength
      ) {
        return undefined;
      }
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }

  if (
    !sawEnd ||
    width === undefined ||
    height === undefined ||
    idat.length === 0
  ) {
    return undefined;
  }
  const bytesPerRow = width * 4;
  const expectedLength = height * (bytesPerRow + 1);
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength > 68 * 1024 * 1024
  ) {
    return undefined;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedLength });
  } catch {
    return undefined;
  }
  if (raw.byteLength !== expectedLength) return undefined;
  try {
    return {
      width,
      height,
      hasTransparency: pngHasTransparency(raw, width, height),
    };
  } catch {
    return undefined;
  }
}

function pngHasTransparency(
  raw: Buffer,
  width: number,
  height: number,
): boolean {
  const rowBytes = width * 4;
  let previous = Buffer.alloc(rowBytes);
  let offset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[offset];
    offset += 1;
    const current = Buffer.alloc(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const encoded = raw[offset];
      offset += 1;
      const left = index >= 4 ? current[index - 4] : 0;
      const up = previous[index];
      const upLeft = index >= 4 ? previous[index - 4] : 0;
      current[index] = decodePngByte(filter, encoded, left, up, upLeft);
      if (index % 4 === 3 && current[index] < 255) return true;
    }
    previous = current;
  }
  return false;
}

function decodePngByte(
  filter: number,
  encoded: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filter === 0) return encoded;
  if (filter === 1) return (encoded + left) & 0xff;
  if (filter === 2) return (encoded + up) & 0xff;
  if (filter === 3) return (encoded + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) return (encoded + paeth(left, up, upLeft)) & 0xff;
  throw new Error("Unsupported PNG filter");
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
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
