import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import {
  decodeComposedGarmentPng,
  decodeSemanticResultPng,
  decodeTransparentGarmentPng,
  validateResultGeometryEvidence,
  validateResultScaleRoundTrip,
  validateResultScaleStep,
} from "./result-geometry-evidence.ts";

const PALETTE = {
  leftSleeve: [255, 0, 0],
  torso: [0, 220, 0],
  rightSleeve: [0, 0, 255],
} as const;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 0);
  return Buffer.concat([header, data, checksum]);
}

function semanticPng({
  scale = 1,
  leftSleeve = true,
  centerX = 32,
  centerY = 32,
  widthScale = 1,
  heightScale = 1,
}: {
  scale?: number;
  leftSleeve?: boolean;
  centerX?: number;
  centerY?: number;
  widthScale?: number;
  heightScale?: number;
} = {}) {
  const width = 64;
  const height = 64;
  const pixels = Buffer.alloc(width * height * 3, 180);
  const rectangle = (
    rgb: readonly number[],
    x: number,
    y: number,
    w: number,
    h: number,
  ) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row += 1) {
      for (
        let column = Math.max(0, x);
        column < Math.min(width, x + w);
        column += 1
      ) {
        const index = (row * width + column) * 3;
        pixels[index] = rgb[0];
        pixels[index + 1] = rgb[1];
        pixels[index + 2] = rgb[2];
      }
    }
  };
  const garmentWidth = Math.round(24 * scale * widthScale);
  const garmentHeight = Math.round(30 * scale * heightScale);
  const torsoWidth = Math.round(14 * scale * widthScale);
  const sleeveWidth = Math.max(1, Math.round((garmentWidth - torsoWidth) / 2));
  const x = Math.round(centerX - garmentWidth / 2);
  const y = Math.round(centerY - garmentHeight / 2);
  rectangle(PALETTE.torso, x + sleeveWidth, y, torsoWidth, garmentHeight);
  if (leftSleeve)
    rectangle(
      PALETTE.leftSleeve,
      x,
      y + 4,
      sleeveWidth,
      Math.round(12 * scale * heightScale),
    );
  rectangle(
    PALETTE.rightSleeve,
    x + sleeveWidth + torsoWidth,
    y + 4,
    sleeveWidth,
    Math.round(12 * scale * heightScale),
  );
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let row = 0; row < height; row += 1) {
    pixels.copy(
      raw,
      row * (width * 3 + 1) + 1,
      row * width * 3,
      (row + 1) * width * 3,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function rasterPng({
  rgba = false,
  pixel,
}: {
  rgba?: boolean;
  pixel: (x: number, y: number) => readonly number[];
}) {
  const width = 64;
  const height = 64;
  const channels = rgba ? 4 : 3;
  const raw = Buffer.alloc(height * (width * channels + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * channels + 1);
    for (let x = 0; x < width; x += 1) {
      const color = pixel(x, y);
      for (let channel = 0; channel < channels; channel += 1) {
        raw[row + 1 + x * channels + channel] = color[channel] ?? 255;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = rgba ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("试衣结果像素几何证据", () => {
  it("从真实纹理透明成衣及捕获帧差分提取公开结果几何", () => {
    const shirt = (x: number, y: number) =>
      y >= 14 &&
      y <= 50 &&
      ((x >= 20 && x <= 44) ||
        (y <= 30 && ((x >= 12 && x < 20) || (x > 44 && x <= 52))));
    const source = decodeTransparentGarmentPng(
      rasterPng({
        rgba: true,
        pixel: (x, y) => (shirt(x, y) ? [28, 29, 31, 255] : [0, 0, 0, 0]),
      }),
    );
    const captured = rasterPng({ pixel: () => [232, 228, 219] });
    const result = rasterPng({
      pixel: (x, y) => (shirt(x, y) ? [28, 29, 31] : [232, 228, 219]),
    });

    const composed = decodeComposedGarmentPng(result, captured);

    assert.deepEqual(source.garment, composed.garment);
    assert.ok(composed.leftSleevePixels > 0);
    assert.ok(composed.rightSleevePixels > 0);
  });

  it("从实际 PNG 像素而不是 URL 或摘要测量袖子、比例和缩放", () => {
    const evidence = validateResultGeometryEvidence({
      source: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      far: decodeSemanticResultPng(semanticPng({ scale: 0.8 })),
      mid: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      near: decodeSemanticResultPng(semanticPng({ scale: 1.2 })),
      scale100: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      scaled: decodeSemanticResultPng(semanticPng({ scale: 1.05 })),
    });
    assert.equal(evidence.ok, true, JSON.stringify(evidence));
  });

  it("从独立 source mask 推导约 0.96 的比例与每侧 65% 保留率", () => {
    const source = decodeSemanticResultPng(
      semanticPng({ widthScale: 1.2, heightScale: 1 }),
    );
    const scaled = (scale: number) => ({
      ...source,
      leftSleevePixels: Math.round(source.leftSleevePixels * scale * scale),
      torsoPixels: Math.round(source.torsoPixels * scale * scale),
      rightSleevePixels: Math.round(source.rightSleevePixels * scale * scale),
      garment: {
        ...source.garment,
        width: source.garment.width * scale,
        height: source.garment.height * scale,
        centerX: source.garment.centerX,
        centerY: source.garment.centerY,
        aspect: source.garment.aspect,
      },
    });
    const evidence = validateResultGeometryEvidence({
      source,
      far: scaled(0.8),
      mid: scaled(1),
      near: scaled(1.2),
      scale100: scaled(1),
      scaled: scaled(1.05),
    });
    assert.equal(evidence.ok, true, JSON.stringify(evidence));
  });

  it("以人工确认的现场远近可见边界验收默认 100%", () => {
    const source = decodeSemanticResultPng(semanticPng({ scale: 1 }));
    const fieldResult = ({
      x,
      y,
      width,
      height,
    }: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => {
      const areaScale =
        (width * height) / (source.garment.width * source.garment.height);
      return {
        ...source,
        width: 1_080,
        height: 1_920,
        leftSleevePixels: Math.round(source.leftSleevePixels * areaScale),
        torsoPixels: Math.round(source.torsoPixels * areaScale),
        rightSleevePixels: Math.round(source.rightSleevePixels * areaScale),
        garment: {
          x,
          y,
          width,
          height,
          centerX: x + (width - 1) / 2,
          centerY: y + (height - 1) / 2,
          aspect: width / height,
        },
      };
    };
    const far = fieldResult({ x: 0, y: 1_347, width: 838, height: 573 });
    const near = fieldResult({ x: 0, y: 1_043, width: 1_080, height: 877 });
    const fieldGolden = {
      far: {
        xRatio: 0,
        yRatio: 1_347 / 1_920,
        widthRatio: 838 / 1_080,
        heightRatio: 573 / 1_920,
      },
      near: {
        xRatio: 0,
        yRatio: 1_043 / 1_920,
        widthRatio: 1,
        heightRatio: 877 / 1_920,
      },
    };

    const accepted = validateResultGeometryEvidence({
      source,
      far,
      near,
      scale100: near,
      scaled: near,
      fieldGolden,
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    const shifted = fieldResult({ x: 80, y: 900, width: 1_000, height: 800 });
    const rejected = validateResultGeometryEvidence({
      source,
      far,
      near: shifted,
      scale100: shifted,
      scaled: shifted,
      fieldGolden,
    });
    assert.equal(rejected.resultDefaultMatchesFieldGolden.observed, false);
  });

  for (const [name, input] of [
    ["单侧袖缺失", { leftSleeve: false }],
    ["非等比摆放", { widthScale: 1.2, heightScale: 0.8 }],
  ] as const) {
    it(`拒绝${name}`, () => {
      const evidence = validateResultGeometryEvidence({
        source: decodeSemanticResultPng(semanticPng({ scale: 1 })),
        far: decodeSemanticResultPng(semanticPng({ scale: 0.8 })),
        mid: decodeSemanticResultPng(semanticPng(input)),
        near: decodeSemanticResultPng(semanticPng({ scale: 1.2 })),
        scale100: decodeSemanticResultPng(semanticPng({ scale: 1 })),
        scaled: decodeSemanticResultPng(semanticPng({ scale: 1.05 })),
      });
      assert.equal(evidence.ok, false);
    });
  }

  it("拒绝远中近不单调的自动尺度", () => {
    const evidence = validateResultGeometryEvidence({
      source: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      far: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      mid: decodeSemanticResultPng(semanticPng({ scale: 0.8 })),
      near: decodeSemanticResultPng(semanticPng({ scale: 1.2 })),
      scale100: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      scaled: decodeSemanticResultPng(semanticPng({ scale: 1.05 })),
    });
    assert.equal(evidence.ok, false);
  });

  for (const [name, direction, beforeScale, afterScale, expected] of [
    ["放大步真的放大", "up", 1, 1.05, true],
    ["放大步不足 3% 判失败", "up", 1, 1.01, false],
    ["缩小步真的缩小", "down", 1.1, 1.05, true],
    ["缩小步不足 3% 判失败", "down", 1.1, 1.09, false],
  ] as const) {
    it(`缩放步校验：${name}`, () => {
      const check = validateResultScaleStep({
        before: decodeSemanticResultPng(semanticPng({ scale: beforeScale })),
        after: decodeSemanticResultPng(semanticPng({ scale: afterScale })),
        direction,
      });
      assert.equal(check.observed, expected);
    });
  }

  it("缩放步拒绝中心漂移", () => {
    const check = validateResultScaleStep({
      before: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      after: decodeSemanticResultPng(semanticPng({ scale: 1.05, centerX: 36 })),
      direction: "up",
    });
    assert.equal(check.observed, false);
  });

  it("缩放步允许现场画面边缘裁切造成的可见中心变化", () => {
    const before = decodeSemanticResultPng(semanticPng({ scale: 1 }));
    const clipped = (
      width: number,
      height: number,
      top: number,
    ): typeof before => ({
      ...before,
      width: 1_080,
      height: 1_920,
      garment: {
        x: 0,
        y: top,
        width,
        height,
        centerX: (width - 1) / 2,
        centerY: top + (height - 1) / 2,
        aspect: width / height,
      },
    });
    const check = validateResultScaleStep({
      before: clipped(838, 573, 1_347),
      after: clipped(860, 598, 1_322),
      direction: "up",
    });
    assert.equal(check.observed, true);
  });

  it("回程 100% 与初始 100% 的成衣 bbox 在容差内一致", () => {
    const initial = decodeSemanticResultPng(semanticPng({ scale: 1 }));
    const roundTrip = validateResultScaleRoundTrip({
      before: initial,
      after: decodeSemanticResultPng(semanticPng({ scale: 1 })),
    });
    assert.equal(roundTrip.observed, true);
    const drifted = validateResultScaleRoundTrip({
      before: initial,
      after: decodeSemanticResultPng(semanticPng({ scale: 1.03 })),
    });
    assert.equal(drifted.observed, false);
  });

  it("按 source 到 result 的实际面积归一化袖子，拒绝缩小或放大后的半袖", () => {
    const source = decodeSemanticResultPng(semanticPng({ scale: 1 }));
    const proportional = (scale: number, sleeveRatio: number) => ({
      ...source,
      leftSleevePixels: Math.round(
        source.leftSleevePixels * scale * scale * sleeveRatio,
      ),
      rightSleevePixels: Math.round(
        source.rightSleevePixels * scale * scale * sleeveRatio,
      ),
      torsoPixels: Math.round(source.torsoPixels * scale * scale),
      garment: {
        ...source.garment,
        width: source.garment.width * scale,
        height: source.garment.height * scale,
        aspect: source.garment.aspect,
      },
    });
    const base = {
      source,
      far: proportional(0.8, 1),
      near: proportional(1.2, 1),
      scale100: proportional(1, 1),
      scaled: proportional(1.05, 1),
    };
    for (const mid of [
      proportional(0.8, 0.5),
      proportional(1, 0.5),
      proportional(1.2, 0.5),
    ]) {
      assert.equal(
        validateResultGeometryEvidence({ ...base, mid }).resultSleevesRetained
          .observed,
        false,
      );
    }
  });

  it("拒绝只有一像素噪声的远中近自动尺度", () => {
    const source = decodeSemanticResultPng(semanticPng({ scale: 1 }));
    const withSize = (width: number, height: number) => ({
      ...source,
      garment: {
        ...source.garment,
        width,
        height,
        aspect: source.garment.aspect,
      },
    });
    const evidence = validateResultGeometryEvidence({
      source,
      far: withSize(100, 125),
      mid: withSize(101, 126),
      near: withSize(102, 127),
      scale100: source,
      scaled: withSize(
        Math.ceil(source.garment.width * 1.05),
        Math.ceil(source.garment.height * 1.05),
      ),
    });
    assert.equal(evidence.resultAutomaticScale.observed, false);
  });
});
