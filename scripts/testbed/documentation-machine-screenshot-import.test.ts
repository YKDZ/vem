import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import {
  buildMachineDocumentationScreenshotMetadata,
  importMachineDocumentationScreenshots,
  parseMachineScreenshotImportArgs,
} from "./documentation-machine-screenshot-import.ts";

function png({ width = 1080, height = 1920 }) {
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
      const offset = 1 + column * channels;
      scanline[offset] = column % 255;
      scanline[offset + 1] = row % 255;
      scanline[offset + 2] = (column + row) % 255;
      scanline[offset + 3] = 255;
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

async function writeBatch(root, scenarios) {
  const batchPath = join(root, "index.json");
  await writeFile(
    batchPath,
    `${JSON.stringify(
      {
        schemaVersion: "vem-machine-ui-screenshot-batch/v1",
        ok: true,
        scenarios,
        failures: [],
      },
      null,
      2,
    )}\n`,
  );
  return batchPath;
}

describe("documentation machine screenshot import", () => {
  it("converts VM machine screenshots into manual metadata and quality results", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-machine-doc-shots-"));
    await writeFile(join(root, "maintenance-stock.png"), png({}));
    const batchPath = await writeBatch(root, [
      {
        name: "maintenance-stock",
        route: "#/maintenance",
        screenshot: { path: "maintenance-stock.png" },
      },
    ]);

    const out = join(root, "manual");
    const result = await importMachineDocumentationScreenshots({
      batchPath,
      outputRoot: out,
      commit: "0123456789abcdef0123456789abcdef01234567",
      capturedAt: "2026-07-25T12:00:00.000Z",
    });

    assert.deepEqual(
      result.imported.map((entry) => ({
        id: entry.id,
        scenario: entry.scenario,
        status: entry.status,
      })),
      [
        {
          id: "machine-maintenance-stock",
          scenario: "maintenance-stock",
          status: "manual-review",
        },
      ],
    );
    const metadata = JSON.parse(
      await readFile(join(out, "machine-maintenance-stock.json"), "utf8"),
    );
    assert.equal(metadata.source, "machine-runtime");
    assert.equal(metadata.expectedOrientation, "portrait");
    assert.deepEqual(metadata.expectedTexts, ["库存维护", "提交"]);
  });

  it("rejects selected scenarios missing from the VM screenshot batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-machine-doc-shots-"));
    const batchPath = await writeBatch(root, []);

    await assert.rejects(
      () =>
        importMachineDocumentationScreenshots({
          batchPath,
          outputRoot: join(root, "manual"),
          commit: "0123456789abcdef0123456789abcdef01234567",
          scenarios: ["maintenance-stock"],
        }),
      /selected machine screenshots missing/,
    );
  });

  it("rejects invalid commit input before publishing documentation metadata", () => {
    assert.throws(
      () =>
        buildMachineDocumentationScreenshotMetadata({
          scenario: { name: "catalog", route: "#/catalog" },
          commit: "not-a-commit",
          capturedAt: "2026-07-25T12:00:00.000Z",
        }),
      /commit/,
    );
    assert.throws(
      () =>
        parseMachineScreenshotImportArgs([
          "--batch",
          "/tmp/index.json",
          "--out",
          "/tmp/out",
          "--commit",
          "not-a-commit",
        ]),
      /commit/,
    );
  });
});
