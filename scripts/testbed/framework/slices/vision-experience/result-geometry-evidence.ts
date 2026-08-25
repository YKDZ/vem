import { inflateSync } from "node:zlib";

import { isStructurallyValidPng } from "../../../../lib/png-structure.ts";

const PALETTE = {
  leftSleeve: [255, 0, 0],
  torso: [0, 220, 0],
  rightSleeve: [0, 0, 255],
} as const;
const MAX_ASPECT_ERROR = 0.02;
const MIN_SLEEVE_RETAINED_RATIO = 0.65;
const MIN_SLEEVE_SYMMETRY_RATIO = 0.8;
const MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH = 1.08;
const MIN_FIELD_DISTANCE_MAJOR_SCALE_GROWTH = 1.5;
const MIN_FIELD_DISTANCE_MINOR_SCALE_GROWTH = 1.2;
const MAX_FIELD_GOLDEN_ABSOLUTE_RATIO_ERROR = 0.04;
const MAX_RESULT_PNG_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_PNG_PIXELS = 16_000_000;
const MAX_RESULT_PNG_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export interface SemanticResultPng {
  width: number;
  height: number;
  leftSleevePixels: number;
  torsoPixels: number;
  rightSleevePixels: number;
  garment: {
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
    aspect: number;
  };
}

export type SemanticResultPngDecodeFailureCode =
  | "byte_size"
  | "structure"
  | "pixel_limit"
  | "format"
  | "decompressed_size"
  | "scanlines"
  | "filter"
  | "decode"
  | "semantic_pixels";

/** 保留既有中文文案，同时让调用者不必匹配错误文本判断失败阶段。 */
export class SemanticResultPngDecodeError extends Error {
  readonly code: SemanticResultPngDecodeFailureCode;

  constructor(code: SemanticResultPngDecodeFailureCode, message: string) {
    super(message);
    this.name = "SemanticResultPngDecodeError";
    this.code = code;
  }
}

function pngDecodeFailure(
  code: SemanticResultPngDecodeFailureCode,
  message: string,
): never {
  throw new SemanticResultPngDecodeError(code, message);
}

function paeth(left: number, above: number, upperLeft: number) {
  const predicted = left + above - upperLeft;
  const leftDistance = Math.abs(predicted - left);
  const aboveDistance = Math.abs(predicted - above);
  const upperLeftDistance = Math.abs(predicted - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance)
    return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function parseRgbPng(bytes: Buffer): {
  width: number;
  height: number;
  pixels: Buffer;
} {
  if (bytes.byteLength > MAX_RESULT_PNG_BYTES)
    pngDecodeFailure("byte_size", "结果 PNG 响应超过字节上限");
  if (!isStructurallyValidPng(bytes))
    pngDecodeFailure("structure", "结果不是结构有效的 PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (width * height > MAX_RESULT_PNG_PIXELS) {
        pngDecodeFailure("pixel_limit", "结果 PNG 像素尺寸超过上限");
      }
      if (
        data[8] !== 8 ||
        ![2, 6].includes(data[9]) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      ) {
        pngDecodeFailure("format", "结果 PNG 必须是 8 位非隔行 RGB 或 RGBA");
      }
      colorType = data[9]!;
    }
    if (type === "IDAT") idat.push(data);
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expectedRawLength = height * (stride + 1);
  if (expectedRawLength > MAX_RESULT_PNG_DECOMPRESSED_BYTES) {
    pngDecodeFailure("decompressed_size", "结果 PNG 解压尺寸超过上限");
  }
  const raw = inflateSync(Buffer.concat(idat), {
    maxOutputLength: MAX_RESULT_PNG_DECOMPRESSED_BYTES,
  });
  if (raw.length !== expectedRawLength)
    pngDecodeFailure("scanlines", "结果 PNG 扫描线无效");
  const pixels = Buffer.alloc(width * height * channels);
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)]!;
    const line = Buffer.from(
      raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)),
    );
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels]! : 0;
      const above = previous[index]!;
      const upperLeft = index >= channels ? previous[index - channels]! : 0;
      if (filter === 1) line[index] = (line[index]! + left) & 255;
      else if (filter === 2) line[index] = (line[index]! + above) & 255;
      else if (filter === 3)
        line[index] = (line[index]! + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4)
        line[index] = (line[index]! + paeth(left, above, upperLeft)) & 255;
      else if (filter !== 0)
        pngDecodeFailure("filter", "结果 PNG 使用了不支持的滤镜");
    }
    line.copy(pixels, row * stride);
    previous = line;
  }
  return { width, height, pixels };
}

function sameColor(value: Buffer, offset: number, color: readonly number[]) {
  return (
    Math.abs(value[offset]! - color[0]) <= 8 &&
    Math.abs(value[offset + 1]! - color[1]) <= 8 &&
    Math.abs(value[offset + 2]! - color[2]) <= 8
  );
}

function geometryFromMask(
  width: number,
  height: number,
  included: (x: number, y: number) => boolean,
): SemanticResultPng {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!included(x, y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY)
    pngDecodeFailure("semantic_pixels", "结果 PNG 没有可见成衣像素");
  const garmentWidth = maxX - minX + 1;
  const garmentHeight = maxY - minY + 1;
  const sleeveBottom = minY + garmentHeight * 0.55;
  const leftBoundary = minX + garmentWidth * 0.32;
  const rightBoundary = maxX - garmentWidth * 0.32;
  let leftSleevePixels = 0;
  let torsoPixels = 0;
  let rightSleevePixels = 0;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!included(x, y)) continue;
      if (y <= sleeveBottom && x <= leftBoundary) leftSleevePixels += 1;
      else if (y <= sleeveBottom && x >= rightBoundary) rightSleevePixels += 1;
      else torsoPixels += 1;
    }
  }
  return {
    width,
    height,
    leftSleevePixels,
    torsoPixels,
    rightSleevePixels,
    garment: {
      x: minX,
      y: minY,
      width: garmentWidth,
      height: garmentHeight,
      centerX: minX + (garmentWidth - 1) / 2,
      centerY: minY + (garmentHeight - 1) / 2,
      aspect: garmentWidth / garmentHeight,
    },
  };
}

/** 从生产透明成衣的 alpha，而不是测试色块，读取可见剪影。 */
export function decodeTransparentGarmentPng(bytes: Buffer): SemanticResultPng {
  const decoded = parseRgbPng(bytes);
  const channels = decoded.pixels.length / (decoded.width * decoded.height);
  if (channels !== 4) pngDecodeFailure("format", "透明成衣 PNG 必须包含 alpha");
  return geometryFromMask(decoded.width, decoded.height, (x, y) => {
    const offset = (y * decoded.width + x) * channels;
    return decoded.pixels[offset + 3]! >= 32;
  });
}

/** 从同一公开捕获帧与合成结果的像素差读取真实成衣区域。 */
export function decodeComposedGarmentPng(
  resultBytes: Buffer,
  capturedBytes: Buffer,
): SemanticResultPng {
  const result = parseRgbPng(resultBytes);
  const captured = parseRgbPng(capturedBytes);
  if (result.width !== captured.width || result.height !== captured.height) {
    pngDecodeFailure("format", "试衣结果与捕获帧尺寸不一致");
  }
  const resultChannels = result.pixels.length / (result.width * result.height);
  const capturedChannels =
    captured.pixels.length / (captured.width * captured.height);
  return geometryFromMask(result.width, result.height, (x, y) => {
    const resultOffset = (y * result.width + x) * resultChannels;
    const capturedOffset = (y * captured.width + x) * capturedChannels;
    return [0, 1, 2].some(
      (channel) =>
        Math.abs(
          result.pixels[resultOffset + channel]! -
            captured.pixels[capturedOffset + channel]!,
        ) >= 24,
    );
  });
}

/** 解码受控语义夹具的真实结果 PNG，并从像素计算成衣区域。 */
export function decodeSemanticResultPng(bytes: Buffer): SemanticResultPng {
  let decoded: ReturnType<typeof parseRgbPng>;
  try {
    decoded = parseRgbPng(bytes);
  } catch (error) {
    if (error instanceof SemanticResultPngDecodeError) throw error;
    pngDecodeFailure("decode", "结果 PNG 无法解码");
  }
  const channels = decoded.pixels.length / (decoded.width * decoded.height);
  let leftSleevePixels = 0;
  let torsoPixels = 0;
  let rightSleevePixels = 0;
  let minX = decoded.width;
  let minY = decoded.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const offset = (y * decoded.width + x) * channels;
      const left = sameColor(decoded.pixels, offset, PALETTE.leftSleeve);
      const torso = sameColor(decoded.pixels, offset, PALETTE.torso);
      const right = sameColor(decoded.pixels, offset, PALETTE.rightSleeve);
      if (left) leftSleevePixels += 1;
      if (torso) torsoPixels += 1;
      if (right) rightSleevePixels += 1;
      if (left || torso || right) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY)
    pngDecodeFailure("semantic_pixels", "结果 PNG 没有语义成衣像素");
  const garmentWidth = maxX - minX + 1;
  const garmentHeight = maxY - minY + 1;
  return {
    width: decoded.width,
    height: decoded.height,
    leftSleevePixels,
    torsoPixels,
    rightSleevePixels,
    garment: {
      x: minX,
      y: minY,
      width: garmentWidth,
      height: garmentHeight,
      centerX: minX + (garmentWidth - 1) / 2,
      centerY: minY + (garmentHeight - 1) / 2,
      aspect: garmentWidth / garmentHeight,
    },
  };
}

interface AssertionValue {
  expected: unknown;
  observed: unknown;
}

export interface ResultGeometryValidation {
  ok: boolean;
  resultSleevesRetained: AssertionValue;
  resultUniformPlacement: AssertionValue;
  resultAutomaticScale: AssertionValue;
  resultDefaultMatchesFieldGolden: AssertionValue;
}

export type ResultScaleDirection = "up" | "down";

/** 同一 attempt 相邻两步：确认成衣 bbox 真的放大/缩小且中心锁定。 */
export function validateResultScaleStep({
  before,
  after,
  direction,
}: {
  before: SemanticResultPng;
  after: SemanticResultPng;
  direction: ResultScaleDirection;
}): AssertionValue {
  const widthRatio = after.garment.width / before.garment.width;
  const heightRatio = after.garment.height / before.garment.height;
  const beforeRight = before.garment.x + before.garment.width;
  const afterRight = after.garment.x + after.garment.width;
  const beforeBottom = before.garment.y + before.garment.height;
  const afterBottom = after.garment.y + after.garment.height;
  const horizontalAnchorStable =
    (before.garment.x === 0 && after.garment.x === 0) ||
    (beforeRight === before.width && afterRight === after.width) ||
    Math.abs(after.garment.centerX - before.garment.centerX) <= 2;
  const verticalAnchorStable =
    (before.garment.y === 0 && after.garment.y === 0) ||
    (beforeBottom === before.height && afterBottom === after.height) ||
    Math.abs(after.garment.centerY - before.garment.centerY) <= 2;
  const majorRatio = Math.max(widthRatio, heightRatio);
  const minorRatio = Math.min(widthRatio, heightRatio);
  const ratiosOk =
    direction === "up"
      ? majorRatio >= 1.03 && minorRatio >= 0.995
      : minorRatio <= 0.97 && majorRatio <= 1.005;
  return {
    expected: true,
    observed: ratiosOk && horizontalAnchorStable && verticalAnchorStable,
  };
}

/** 回程 100%：与初始 100% 的成衣 bbox 在容差内一致且中心锁定。 */
export function validateResultScaleRoundTrip({
  before,
  after,
}: {
  before: SemanticResultPng;
  after: SemanticResultPng;
}): AssertionValue {
  const widthRatio = after.garment.width / before.garment.width;
  const heightRatio = after.garment.height / before.garment.height;
  const centerDrift = Math.hypot(
    after.garment.centerX - before.garment.centerX,
    after.garment.centerY - before.garment.centerY,
  );
  const sizeConsistent =
    Math.abs(widthRatio - 1) <= 0.02 && Math.abs(heightRatio - 1) <= 0.02;
  return { expected: true, observed: sizeConsistent && centerDrift <= 2 };
}

/** 以独立语义色块夹具验证结果的袖子、等比、自动尺度和 105% 像素变化。 */
export function validateResultGeometryEvidence({
  source,
  far,
  mid = null,
  near,
  scale100,
  scaled,
  fieldGolden = null,
}: {
  source: SemanticResultPng;
  far: SemanticResultPng;
  mid?: SemanticResultPng | null;
  near: SemanticResultPng;
  scale100: SemanticResultPng;
  scaled: SemanticResultPng;
  fieldGolden?: {
    far: {
      xRatio: number;
      yRatio: number;
      widthRatio: number;
      heightRatio: number;
    };
    near: {
      xRatio: number;
      yRatio: number;
      widthRatio: number;
      heightRatio: number;
    };
  } | null;
}): ResultGeometryValidation {
  const representative = mid ?? near;
  const expectedSleevePixels = (
    result: SemanticResultPng,
    sourcePixels: number,
  ) =>
    (sourcePixels * (result.garment.width * result.garment.height)) /
    (source.garment.width * source.garment.height);
  const retained =
    source.leftSleevePixels > 0 &&
    source.rightSleevePixels > 0 &&
    representative.leftSleevePixels /
      expectedSleevePixels(representative, source.leftSleevePixels) >=
      MIN_SLEEVE_RETAINED_RATIO &&
    representative.rightSleevePixels /
      expectedSleevePixels(representative, source.rightSleevePixels) >=
      MIN_SLEEVE_RETAINED_RATIO;
  const sleeveSymmetry =
    representative.leftSleevePixels > 0 &&
    representative.rightSleevePixels > 0 &&
    Math.min(
      representative.leftSleevePixels,
      representative.rightSleevePixels,
    ) /
      Math.max(
        representative.leftSleevePixels,
        representative.rightSleevePixels,
      ) >=
      MIN_SLEEVE_SYMMETRY_RATIO;
  const sleeves = retained && sleeveSymmetry;
  const ratioError = (observed: number, expected: number) =>
    Math.abs(observed - expected);
  const matchesGoldenSegment = (
    result: SemanticResultPng,
    expected: NonNullable<typeof fieldGolden>["far"],
  ) =>
    ratioError(result.garment.x / result.width, expected.xRatio) <=
      MAX_FIELD_GOLDEN_ABSOLUTE_RATIO_ERROR &&
    ratioError(result.garment.y / result.height, expected.yRatio) <=
      MAX_FIELD_GOLDEN_ABSOLUTE_RATIO_ERROR &&
    ratioError(result.garment.width / result.width, expected.widthRatio) <=
      MAX_FIELD_GOLDEN_ABSOLUTE_RATIO_ERROR &&
    ratioError(result.garment.height / result.height, expected.heightRatio) <=
      MAX_FIELD_GOLDEN_ABSOLUTE_RATIO_ERROR;
  const matchesFieldGolden = fieldGolden
    ? matchesGoldenSegment(far, fieldGolden.far) &&
      matchesGoldenSegment(near, fieldGolden.near)
    : true;
  // 现场近景会同时切掉成衣左右和下缘；可见 bbox 的宽高比因此不再等于
  // 完整源图。此时人工确认的公开可见边界才是等比摆放的端到端代理事实。
  const uniform = fieldGolden
    ? matchesFieldGolden
    : [far, ...(mid ? [mid] : []), near, scale100, scaled].every(
        (result) =>
          Math.abs(result.garment.aspect - source.garment.aspect) <=
          MAX_ASPECT_ERROR,
      );
  const automaticScale = mid
    ? mid.garment.width / far.garment.width >=
        MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH &&
      near.garment.width / mid.garment.width >=
        MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH &&
      mid.garment.height / far.garment.height >=
        MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH &&
      near.garment.height / mid.garment.height >=
        MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH
    : Math.max(
        near.garment.width / far.garment.width,
        near.garment.height / far.garment.height,
      ) >= MIN_FIELD_DISTANCE_MAJOR_SCALE_GROWTH &&
      Math.min(
        near.garment.width / far.garment.width,
        near.garment.height / far.garment.height,
      ) >= MIN_FIELD_DISTANCE_MINOR_SCALE_GROWTH;
  return {
    ok: sleeves && uniform && automaticScale && matchesFieldGolden,
    resultSleevesRetained: { expected: true, observed: sleeves },
    resultUniformPlacement: { expected: true, observed: uniform },
    resultAutomaticScale: { expected: true, observed: automaticScale },
    resultDefaultMatchesFieldGolden: {
      expected: true,
      observed: matchesFieldGolden,
    },
  };
}
