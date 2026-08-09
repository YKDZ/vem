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
import { PNG } from "pngjs";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";

export const MAX_PRODUCT_DISPLAY_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TRY_ON_SILHOUETTE_BYTES = MAX_PRODUCT_DISPLAY_IMAGE_BYTES;
export const MAX_TRY_ON_GARMENT_BYTES = 5 * 1024 * 1024;
export const MIN_TRY_ON_GARMENT_DIMENSION = 256;
export const MAX_TRY_ON_GARMENT_DIMENSION = 4096;
const MIN_TRY_ON_GARMENT_PIXEL_COVERAGE = 0.01;
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

export function managedMediaAssetReference(id: string): string {
  return `/api/media-assets/${id}/content`;
}

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
      if (purpose === "try_on_garment") {
        throw new BadRequestException("TRY_ON_GARMENT_FILE_REQUIRED");
      }
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

    const header = readPngHeader(file.buffer);
    if (!header) {
      throw new BadRequestException("TRY_ON_GARMENT_PNG_INVALID");
    }
    if (
      header.width < MIN_TRY_ON_GARMENT_DIMENSION ||
      header.height < MIN_TRY_ON_GARMENT_DIMENSION
    ) {
      throw new BadRequestException("TRY_ON_GARMENT_DIMENSIONS_TOO_SMALL");
    }
    if (
      header.width > MAX_TRY_ON_GARMENT_DIMENSION ||
      header.height > MAX_TRY_ON_GARMENT_DIMENSION
    ) {
      throw new BadRequestException("TRY_ON_GARMENT_DIMENSIONS_UNSUPPORTED");
    }
    const facts = decodePngFacts(file.buffer, header);
    if (!facts) {
      throw new BadRequestException("TRY_ON_GARMENT_PNG_INVALID");
    }
    if (facts.transparentPixelCount < minimumGarmentPixelCount(header)) {
      throw new BadRequestException("TRY_ON_GARMENT_TRANSPARENCY_REQUIRED");
    }
    if (facts.visiblePixelCount < minimumGarmentPixelCount(header)) {
      throw new BadRequestException("TRY_ON_GARMENT_VISIBLE_PIXELS_REQUIRED");
    }
    return {
      contentType: "image/png",
      extension: ".png",
      width: header.width,
      height: header.height,
      hasTransparency: true,
    };
  }
}

function minimumGarmentPixelCount({ width, height }: PngHeader): number {
  return Math.max(
    1,
    Math.ceil(width * height * MIN_TRY_ON_GARMENT_PIXEL_COVERAGE),
  );
}

function buildPublicAssetUrl(id: string, baseUrl: string | undefined): string {
  const path = managedMediaAssetReference(id);
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

type PngHeader = { width: number; height: number };

function readPngHeader(buffer: Buffer): PngHeader | undefined {
  if (!isPng(buffer) || buffer.byteLength < 57) return undefined;
  let offset = 8;
  let width: number | undefined;
  let height: number | undefined;
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
      if (width !== undefined || length !== 13 || offset !== 8)
        return undefined;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        width === 0 ||
        height === 0 ||
        ![1, 2, 4, 8, 16].includes(data[8]) ||
        ![0, 2, 3, 4, 6].includes(data[9]) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        return undefined;
      }
    } else if (type === "IDAT") {
      if (width === undefined) return undefined;
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
      offset = dataEnd + 4;
      break;
    } else if (isCriticalPngChunk(type)) {
      return undefined;
    }
    offset = dataEnd + 4;
  }

  if (
    !sawEnd ||
    width === undefined ||
    height === undefined ||
    offset !== buffer.byteLength
  ) {
    return undefined;
  }
  return { width, height };
}

function isCriticalPngChunk(type: string): boolean {
  return (
    type.length === 4 && type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90
  );
}

function decodePngFacts(
  buffer: Buffer,
  header: PngHeader,
): { transparentPixelCount: number; visiblePixelCount: number } | undefined {
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(buffer, { checkCRC: true });
  } catch {
    return undefined;
  }
  if (decoded.width !== header.width || decoded.height !== header.height) {
    return undefined;
  }
  let transparentPixelCount = 0;
  let visiblePixelCount = 0;
  for (let index = 3; index < decoded.data.length; index += 4) {
    if (decoded.data[index] < 255) transparentPixelCount += 1;
    if (decoded.data[index] > 0) visiblePixelCount += 1;
  }
  return { transparentPixelCount, visiblePixelCount };
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
