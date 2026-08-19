import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import {
  evaluateDocumentationScreenshot,
  normalizeDocumentationScreenshotMetadata,
} from "./documentation-screenshot-quality.ts";

function png({ width = 2, height = 2, pixels }) {
  const channels = 4;
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length, 0);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    return bytes;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const rows = [];
  for (let row = 0; row < height; row += 1) {
    const scanline = Buffer.alloc(1 + width * channels);
    scanline.writeUInt8(0, 0);
    for (let column = 0; column < width; column += 1) {
      const pixel = pixels[row * width + column];
      const offset = 1 + column * channels;
      scanline[offset] = pixel[0];
      scanline[offset + 1] = pixel[1];
      scanline[offset + 2] = pixel[2];
      scanline[offset + 3] = pixel[3];
    }
    rows.push(scanline);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function metadata(overrides = {}) {
  return {
    id: "admin-products-list",
    source: "admin-ui",
    route: "/products",
    capturedAt: "2026-07-25T12:00:00Z",
    commit: "0123456789abcdef0123456789abcdef01234567",
    viewport: { width: 1440, height: 1080 },
    expectedTexts: ["商品管理", "新增商品"],
    ...overrides,
  };
}

describe("documentation screenshot quality gate", () => {
  it("rejects solid-color PNG screenshots", () => {
    const shot = png({
      pixels: Array.from({ length: 4 }, () => [255, 255, 255, 255]),
    });

    const result = evaluateDocumentationScreenshot({
      bytes: shot,
      metadata: metadata(),
    });

    assert.equal(result.status, "rejected");
    assert.match(result.reasons.join("\n"), /solid-color/i);
  });

  it("normalizes metadata and keeps expected text requirements explicit", () => {
    assert.deepEqual(
      normalizeDocumentationScreenshotMetadata(
        metadata({
          expectedTexts: [" 商品管理 ", "新增商品", "商品管理"],
          detectedTexts: [" 商品管理 "],
        }),
      ),
      {
        id: "admin-products-list",
        source: "admin-ui",
        route: "/products",
        capturedAt: "2026-07-25T12:00:00Z",
        commit: "0123456789abcdef0123456789abcdef01234567",
        viewport: { width: 1440, height: 1080 },
        expectedOrientation: null,
        expectedTexts: ["商品管理", "新增商品"],
        detectedTexts: ["商品管理"],
        manualReviewReason: null,
      },
    );
  });

  it("marks screenshots without detected text evidence as manual review", () => {
    const shot = png({
      pixels: [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
      ],
    });

    const result = evaluateDocumentationScreenshot({
      bytes: shot,
      metadata: metadata(),
    });

    assert.equal(result.status, "manual-review");
    assert.match(result.reasons.join("\n"), /expected text/i);
  });

  it("rejects screenshots whose detected text misses required UI copy", () => {
    const shot = png({
      pixels: [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
      ],
    });

    const result = evaluateDocumentationScreenshot({
      bytes: shot,
      metadata: metadata({ detectedTexts: ["商品管理"] }),
    });

    assert.equal(result.status, "rejected");
    assert.match(result.reasons.join("\n"), /新增商品/);
  });

  it("rejects screenshots whose orientation does not match the documented expectation", () => {
    const shot = png({
      width: 2,
      height: 3,
      pixels: [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
        [255, 255, 0, 255],
        [0, 255, 255, 255],
      ],
    });

    const result = evaluateDocumentationScreenshot({
      bytes: shot,
      metadata: metadata({
        source: "machine-runtime",
        viewport: { width: 1080, height: 1920 },
        expectedOrientation: "landscape",
        detectedTexts: ["商品管理", "新增商品"],
      }),
    });

    assert.equal(result.status, "rejected");
    assert.match(result.reasons.join("\n"), /orientation/i);
  });

  it("passes screenshots with visual content, metadata, and detected text evidence", () => {
    const shot = png({
      pixels: [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
      ],
    });

    const result = evaluateDocumentationScreenshot({
      bytes: shot,
      metadata: metadata({ detectedTexts: ["商品管理", "新增商品"] }),
    });

    assert.equal(result.status, "passed");
    assert.equal(result.capture.widthPx, 2);
    assert.equal(result.capture.heightPx, 2);
  });
});
