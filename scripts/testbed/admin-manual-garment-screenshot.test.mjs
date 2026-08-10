import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { evaluateDocumentationScreenshotFile } from "./documentation-screenshot-quality.mjs";

const screenshotRoot = resolve("public/manual/screenshots");
const screenshot = resolve(screenshotRoot, "admin-try-on-garment-upload.png");
const metadata = resolve(screenshotRoot, "admin-try-on-garment-upload.json");
const productView = readFileSync(
  "apps/admin-ui/src/views/products/ProductsView.vue",
  "utf8",
);
const captureSpec = readFileSync(
  "apps/admin-ui/tests/operator-manual-screenshots.spec.ts",
  "utf8",
);

describe("Try-On Garment operator-manual screenshot", () => {
  it("is a current, non-placeholder Admin capture with lifecycle controls", async () => {
    const result = await evaluateDocumentationScreenshotFile({
      screenshotPath: screenshot,
      metadataPath: metadata,
    });
    assert.equal(result.status, "passed");
    assert.equal(result.capture.widthPx, 1440);
    assert.equal(result.capture.heightPx, 1080);
    assert.equal(result.metadata.source, "admin-ui");
    assert.deepEqual(result.metadata.expectedTexts, [
      "Try-On Garment 草稿",
      "透明 PNG 来源",
      "共享尺码影响范围",
      "保存共享尺码关联",
    ]);
    for (const contract of [
      "admin-try-on-garment-modal",
      "admin-try-on-garment-upload",
      "admin-try-on-garment-confirm",
      "admin-try-on-garment-activate",
      "admin-try-on-garment-associate",
    ]) {
      assert.match(productView, new RegExp(`data-test="${contract}"`));
    }
    for (const operation of [
      'name: "创建草稿"',
      'name: "确认来源"',
      'name: "激活 Garment"',
      'name: "保存共享尺码关联"',
    ]) {
      assert.match(captureSpec, new RegExp(operation));
    }
  });
});
