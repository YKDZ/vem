import { expect, type Locator, type Page, test } from "@playwright/test";
import { tryOnGarmentResponseSchema } from "@vem/shared";
import { deflateSync } from "node:zlib";

import { installAdminBrowserContractMonitor } from "./support/admin-browser-contract";
import { skipUnlessAdminMutationE2eEnabled } from "./support/admin-mutation-e2e";

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "AdminPassword123!";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /登录/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

function formItem(page: Page | Locator, label: string) {
  return page.locator(".ant-form-item").filter({ hasText: label }).first();
}

async function createProduct(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /新增商品/ }).click();
  const drawer = page.locator(".ant-drawer").filter({ hasText: "新增商品" });
  await formItem(drawer, "商品名称").locator("input").fill(name);
  await drawer.getByRole("button", { name: /保存/ }).click();
  await expect(
    page.locator(".ant-table-row").filter({ hasText: name }),
  ).toBeVisible({
    timeout: 10_000,
  });
}

test.describe("Try-On Garment Admin UI contract", () => {
  skipUnlessAdminMutationE2eEnabled(test);

  test("lets an operator select a product, preview a validated source, and explicitly confirm its draft", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const unique = Date.now().toString(36);
    const productName = `E2E试衣源-${unique}`;
    await login(page);
    await page.goto("/products");
    const monitor = await installAdminBrowserContractMonitor(page);
    await createProduct(page, productName);

    const row = page.locator(".ant-table-row").filter({ hasText: productName });
    await row.getByRole("button", { name: "新增试衣源" }).click();
    const modal = page
      .locator(".ant-modal")
      .filter({ hasText: "新增 Try-On Garment 草稿" });
    await expect(modal).toBeVisible();
    await formItem(modal, "可见颜色").locator("input").fill("海军蓝");

    const [uploadResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/media-assets/try-on-garments") &&
          response.request().method() === "POST",
      ),
      modal.locator("input[type='file']").setInputFiles({
        name: "shirt.png",
        mimeType: "image/png",
        buffer: rgbaPng(768, 1024, 0),
      }),
    ]);
    expect(uploadResponse.ok()).toBe(true);
    const preview = modal.getByAltText("Try-On Garment 来源预览");
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview.evaluate((image) => {
          const previewImage = image as HTMLImageElement;
          return [previewImage.naturalWidth, previewImage.naturalHeight];
        }),
      )
      .toEqual([768, 1024]);
    await expect(modal.getByText(/校验通过：透明 PNG/)).toBeVisible();

    const [draftResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/try-on-garments") &&
          response.request().method() === "POST",
      ),
      modal.getByRole("button", { name: "创建草稿" }).click(),
    ]);
    const draftBody = await draftResponse.json();
    const draft = tryOnGarmentResponseSchema.parse(draftBody.data);
    expect(draft).toMatchObject({
      colorLabel: "海军蓝",
      template: "tshirt_short_sleeve",
      status: "draft",
      confirmedAt: null,
    });

    const [confirmationResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response
            .url()
            .endsWith(`/api/try-on-garments/${draft.id}/confirmation`) &&
          response.request().method() === "POST",
      ),
      modal.getByRole("button", { name: "确认来源" }).click(),
    ]);
    expect(confirmationResponse.ok()).toBe(true);
    await expect(
      modal.getByText(/来源已确认。请显式激活并选择共享的尺码规格/),
    ).toBeVisible();
    const [activationResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response
            .url()
            .endsWith(`/api/try-on-garments/${draft.id}/activation`) &&
          response.request().method() === "POST",
      ),
      modal.getByRole("button", { name: "激活 Garment" }).click(),
    ]);
    expect(activationResponse.ok()).toBe(true);
    await expect(modal.getByText("共享尺码影响范围")).toBeVisible();
    await monitor.assertNoFailures();
  });

  test("shows deterministic upload feedback when an opaque model-photo-like source is rejected", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const unique = Date.now().toString(36);
    const productName = `E2E无透明度-${unique}`;
    await login(page);
    await page.goto("/products");
    await createProduct(page, productName);
    const row = page.locator(".ant-table-row").filter({ hasText: productName });
    await row.getByRole("button", { name: "新增试衣源" }).click();
    const modal = page
      .locator(".ant-modal")
      .filter({ hasText: "新增 Try-On Garment 草稿" });

    const [uploadResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/media-assets/try-on-garments") &&
          response.request().method() === "POST",
      ),
      modal.locator("input[type='file']").setInputFiles({
        name: "model-photo.png",
        mimeType: "image/png",
        buffer: rgbaPng(512, 512, 255),
      }),
    ]);
    expect(uploadResponse.status()).toBe(400);
    await expect(
      modal.getByText(/TRY_ON_GARMENT_TRANSPARENCY_REQUIRED/),
    ).toBeVisible();
  });
});

function rgbaPng(width: number, height: number, alpha: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 4 + 1);
    for (let pixel = 0; pixel < width; pixel += 1) {
      pixels[offset + 1 + pixel * 4 + 3] = alpha;
    }
  }
  if (alpha === 0) {
    for (
      let row = Math.floor(height / 4);
      row < Math.ceil((height * 3) / 4);
      row += 1
    ) {
      const offset = row * (width * 4 + 1);
      for (
        let pixel = Math.floor(width / 4);
        pixel < Math.ceil((width * 3) / 4);
        pixel += 1
      ) {
        const pixelOffset = offset + 1 + pixel * 4;
        pixels[pixelOffset] = 20;
        pixels[pixelOffset + 1] = 50;
        pixels[pixelOffset + 2] = 180;
        pixels[pixelOffset + 3] = 255;
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])), 0);
  return Buffer.concat([header, data, crc]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
