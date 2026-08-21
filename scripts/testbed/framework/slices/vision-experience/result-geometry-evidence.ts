import { inflateSync } from "node:zlib";

import { isStructurallyValidPng } from "../../../../lib/png-structure.mjs";

const PALETTE = {
  leftSleeve: [255, 0, 0],
  torso: [0, 220, 0],
  rightSleeve: [0, 0, 255],
} as const;
const MAX_ASPECT_ERROR = 0.02;
const MIN_SLEEVE_RETAINED_RATIO = 0.65;
const MIN_SLEEVE_SYMMETRY_RATIO = 0.8;
const MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH = 1.08;
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
  garmentScaleRendersPixels: AssertionValue;
}

/** 同一 Vision attempt 的 100%/105% PNG 对，独立确认真实成衣像素与锁定中心。 */
export function validateResultScalePair({
  scale100,
  scale105,
}: {
  scale100: SemanticResultPng;
  scale105: SemanticResultPng;
}): AssertionValue {
  const widthGrowth = scale105.garment.width / scale100.garment.width;
  const heightGrowth = scale105.garment.height / scale100.garment.height;
  const centerDrift = Math.hypot(
    scale105.garment.centerX - scale100.garment.centerX,
    scale105.garment.centerY - scale100.garment.centerY,
  );
  return {
    expected: true,
    observed: widthGrowth >= 1.03 && heightGrowth >= 1.03 && centerDrift <= 2,
  };
}

/** 以独立语义色块夹具验证结果的袖子、等比、自动尺度和 105% 像素变化。 */
export function validateResultGeometryEvidence({
  source,
  far,
  mid,
  near,
  scale100,
  scale105,
}: {
  source: SemanticResultPng;
  far: SemanticResultPng;
  mid: SemanticResultPng;
  near: SemanticResultPng;
  scale100: SemanticResultPng;
  scale105: SemanticResultPng;
}): ResultGeometryValidation {
  const expectedSleevePixels = (
    result: SemanticResultPng,
    sourcePixels: number,
  ) =>
    (sourcePixels * (result.garment.width * result.garment.height)) /
    (source.garment.width * source.garment.height);
  const retained =
    source.leftSleevePixels > 0 &&
    source.rightSleevePixels > 0 &&
    mid.leftSleevePixels / expectedSleevePixels(mid, source.leftSleevePixels) >=
      MIN_SLEEVE_RETAINED_RATIO &&
    mid.rightSleevePixels /
      expectedSleevePixels(mid, source.rightSleevePixels) >=
      MIN_SLEEVE_RETAINED_RATIO;
  const sleeveSymmetry =
    mid.leftSleevePixels > 0 &&
    mid.rightSleevePixels > 0 &&
    Math.min(mid.leftSleevePixels, mid.rightSleevePixels) /
      Math.max(mid.leftSleevePixels, mid.rightSleevePixels) >=
      MIN_SLEEVE_SYMMETRY_RATIO;
  const sleeves = retained && sleeveSymmetry;
  const uniform = [far, mid, near, scale100, scale105].every(
    (result) =>
      Math.abs(result.garment.aspect - source.garment.aspect) <=
      MAX_ASPECT_ERROR,
  );
  const automaticScale =
    mid.garment.width / far.garment.width >=
      MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH &&
    near.garment.width / mid.garment.width >=
      MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH &&
    mid.garment.height / far.garment.height >=
      MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH &&
    near.garment.height / mid.garment.height >=
      MIN_ADJACENT_AUTOMATIC_SCALE_GROWTH;
  const scalePixels = validateResultScalePair({ scale100, scale105 })
    .observed as boolean;
  return {
    ok: sleeves && uniform && automaticScale && scalePixels,
    resultSleevesRetained: { expected: true, observed: sleeves },
    resultUniformPlacement: { expected: true, observed: uniform },
    resultAutomaticScale: { expected: true, observed: automaticScale },
    garmentScaleRendersPixels: { expected: true, observed: scalePixels },
  };
}
