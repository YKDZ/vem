import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import {
  inspectExportedDisplayCapture,
  inspectPng,
} from "./display-evidence.mjs";

function png() {
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length, 0);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    return bytes;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk(
      "IDAT",
      deflateSync(
        Buffer.from([
          0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
          255,
        ]),
      ),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("display evidence PNG inspection", () => {
  it("decodes actual RGBA pixels and verifies the digest-bound export", () => {
    const bytes = png();
    assert.deepEqual(inspectPng(bytes), {
      ok: true,
      kind: "passed",
      format: "png",
      widthPx: 2,
      heightPx: 2,
      pixelCount: 4,
      nonTransparentPixelCount: 4,
      distinctPixelCount: 4,
    });
    const directory = mkdtempSync(join(tmpdir(), "vem-display-evidence-"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const evidence = {
      identity: `factory-evidence://sha256/${digest}`,
      digest: `sha256:${digest}`,
      fileName: `${digest}.png`,
    };
    writeFileSync(join(directory, evidence.fileName), bytes);
    assert.equal(
      inspectExportedDisplayCapture({
        directory,
        evidence,
        capture: {
          format: "png",
          widthPx: 2,
          heightPx: 2,
          pixelCount: 4,
          nonTransparentPixelCount: 4,
          distinctPixelCount: 4,
        },
      }).kind,
      "passed",
    );
  });

  it("rejects a non-PNG payload even when the file name and digest agree", () => {
    assert.equal(inspectPng(Buffer.from("not a png")).kind, "malformed");
  });
});
