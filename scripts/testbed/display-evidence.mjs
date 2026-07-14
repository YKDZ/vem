import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function malformed(message) {
  return { ok: false, kind: "malformed", message };
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance)
    return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function inspectPng(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  )
    return malformed("capture must be a complete PNG buffer");
  let width;
  let height;
  let colorType;
  let idat = Buffer.alloc(0);
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return malformed("PNG chunk is truncated");
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd + 4 > bytes.length)
      return malformed(`PNG ${type} chunk is truncated`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (
        width ||
        size !== 13 ||
        data.readUInt8(8) !== 8 ||
        ![2, 6].includes(data.readUInt8(9)) ||
        data.readUInt8(10) !== 0 ||
        data.readUInt8(11) !== 0 ||
        data.readUInt8(12) !== 0
      )
        return malformed(
          "PNG must be an 8-bit non-interlaced RGB or RGBA image",
        );
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idat = Buffer.concat([idat, data]);
    } else if (type === "IEND") {
      if (data.length !== 0 || dataEnd + 4 !== bytes.length)
        return malformed("PNG IEND is invalid");
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || !idat.length)
    return malformed("PNG must contain IHDR and IDAT chunks");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  let raw;
  try {
    raw = inflateSync(idat);
  } catch {
    return malformed("PNG image data cannot be decompressed");
  }
  if (raw.length !== height * (stride + 1))
    return malformed("PNG scanlines are invalid");
  let previous = Buffer.alloc(stride);
  const pixels = new Set();
  let nonTransparentPixelCount = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw.readUInt8(row * (stride + 1));
    const scanline = Buffer.from(
      raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)),
    );
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? scanline[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      if (filter === 1) scanline[index] = (scanline[index] + left) & 255;
      else if (filter === 2) scanline[index] = (scanline[index] + above) & 255;
      else if (filter === 3)
        scanline[index] =
          (scanline[index] + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4)
        scanline[index] =
          (scanline[index] + paeth(left, above, upperLeft)) & 255;
      else if (filter !== 0)
        return malformed("PNG uses an unsupported scanline filter");
    }
    for (let column = 0; column < width; column += 1) {
      const pixel = scanline.subarray(
        column * channels,
        (column + 1) * channels,
      );
      if (channels === 3 || pixel[3] > 0) nonTransparentPixelCount += 1;
      pixels.add(pixel.toString("hex"));
    }
    previous = scanline;
  }
  return {
    ok: true,
    kind: "passed",
    format: "png",
    widthPx: width,
    heightPx: height,
    pixelCount: width * height,
    nonTransparentPixelCount,
    nonTransparentPixelRatio: nonTransparentPixelCount / (width * height),
    distinctPixelCount: pixels.size,
  };
}

export function inspectExportedDisplayCapture({
  directory,
  evidence,
  capture,
}) {
  if (!/^[a-f0-9]{64}\.png$/.test(evidence?.fileName ?? ""))
    throw new Error(
      "display evidence must use a digest-bound relative PNG file name",
    );
  const bytes = readFileSync(join(directory, evidence.fileName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    evidence.identity !== `factory-evidence://sha256/${digest}` ||
    evidence.digest !== `sha256:${digest}`
  )
    throw new Error(
      "display evidence file digest does not match its logical identity",
    );
  const inspected = inspectPng(bytes);
  if (!inspected.ok || inspected.nonTransparentPixelCount === 0)
    throw new Error(
      `display PNG capture is ${inspected.kind}: ${inspected.message ?? "transparent"}`,
    );
  for (const key of [
    "format",
    "widthPx",
    "heightPx",
    "pixelCount",
    "nonTransparentPixelCount",
    "nonTransparentPixelRatio",
    "distinctPixelCount",
  ])
    if (capture[key] !== inspected[key])
      throw new Error(
        `display capture ${key} does not match exported PNG inspection`,
      );
  return inspected;
}
