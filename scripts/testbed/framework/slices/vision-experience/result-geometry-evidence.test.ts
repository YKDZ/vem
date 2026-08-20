import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import {
  decodeSemanticResultPng,
  validateResultGeometryEvidence,
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

describe("试衣结果像素几何证据", () => {
  it("从实际 PNG 像素而不是 URL 或摘要测量袖子、比例和缩放", () => {
    const evidence = validateResultGeometryEvidence({
      source: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      far: decodeSemanticResultPng(semanticPng({ scale: 0.8 })),
      mid: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      near: decodeSemanticResultPng(semanticPng({ scale: 1.2 })),
      scale100: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      scale105: decodeSemanticResultPng(semanticPng({ scale: 1.05 })),
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
      scale105: scaled(1.05),
    });
    assert.equal(evidence.ok, true, JSON.stringify(evidence));
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
        scale105: decodeSemanticResultPng(semanticPng({ scale: 1.05 })),
      });
      assert.equal(evidence.ok, false);
    });
  }

  it("拒绝远中近不单调、仅改 URL/digest 的缩放和中心漂移", () => {
    const evidence = validateResultGeometryEvidence({
      source: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      far: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      mid: decodeSemanticResultPng(semanticPng({ scale: 0.8 })),
      near: decodeSemanticResultPng(semanticPng({ scale: 1.2 })),
      scale100: decodeSemanticResultPng(semanticPng({ scale: 1 })),
      scale105: decodeSemanticResultPng(semanticPng({ scale: 1, centerX: 36 })),
    });
    assert.equal(evidence.ok, false);
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
      scale105: proportional(1.05, 1),
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
      scale105: withSize(
        Math.ceil(source.garment.width * 1.05),
        Math.ceil(source.garment.height * 1.05),
      ),
    });
    assert.equal(evidence.resultAutomaticScale.observed, false);
  });
});
