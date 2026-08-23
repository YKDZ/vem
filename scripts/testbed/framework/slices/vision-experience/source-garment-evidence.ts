/**
 * 试衣源图只能来自本次 local-testbed 预置的 Service API 资产；这里不从结果
 * 像素反推来源，而是比较 Machine 实际发出的 V2 start garment 描述。
 */
export interface SourceGarmentMetadata {
  reference: string;
  origin: string;
  assetId: string;
  digest: string;
  contentType: "image/png";
  byteSize: number;
  template: "tshirt_short_sleeve" | "tshirt_long_sleeve";
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 解析 guest-input 中的预置资产，并把 URL 限为该 Service API 的规范资产路径。 */
export function parseSourceGarmentMetadata(
  value: unknown,
  serviceApiOrigin: unknown,
): SourceGarmentMetadata | null {
  if (!isRecord(value) || typeof serviceApiOrigin !== "string") return null;
  const metadata = value as Partial<SourceGarmentMetadata>;
  if (
    typeof metadata.reference !== "string" ||
    typeof metadata.origin !== "string" ||
    typeof metadata.assetId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      metadata.assetId,
    ) ||
    typeof metadata.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.digest) ||
    metadata.contentType !== "image/png" ||
    typeof metadata.byteSize !== "number" ||
    !Number.isInteger(metadata.byteSize) ||
    metadata.byteSize < 1 ||
    metadata.byteSize > 8 * 1024 * 1024 ||
    (metadata.template !== "tshirt_short_sleeve" &&
      metadata.template !== "tshirt_long_sleeve") ||
    typeof metadata.width !== "number" ||
    !Number.isInteger(metadata.width) ||
    typeof metadata.height !== "number" ||
    !Number.isInteger(metadata.height) ||
    metadata.width < 1 ||
    metadata.height < 1
  ) {
    return null;
  }
  try {
    const reference = new URL(metadata.reference);
    const origin = new URL(metadata.origin).origin;
    if (
      origin !== new URL(serviceApiOrigin).origin ||
      reference.origin !== origin ||
      reference.pathname !== `/api/media-assets/${metadata.assetId}/content` ||
      reference.search !== "" ||
      reference.hash !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return metadata as SourceGarmentMetadata;
}

/** V2 start 必须逐字段等同于 guest-input 中本次预置的源资产。 */
export function isSourceGarmentAttemptBound(
  metadata: SourceGarmentMetadata | null,
  garment: unknown,
): boolean {
  if (!metadata || !isRecord(garment)) return false;
  return (
    garment.assetId === metadata.assetId &&
    garment.digest === metadata.digest &&
    garment.byteSize === metadata.byteSize &&
    garment.contentType === metadata.contentType &&
    garment.template === metadata.template
  );
}
