import type { z } from "zod";

import { expect, type Page, type Response, test } from "@playwright/test";
import {
  adminProductResponseSchema,
  adminProductVariantResponseSchema,
} from "@vem/shared";
import { z as zod } from "zod";

import { installAdminBrowserContractMonitor } from "./support/admin-browser-contract";
import { skipUnlessAdminMutationE2eEnabled } from "./support/admin-mutation-e2e";

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "AdminPassword123!";

const adminApiResponseSchema = zod.strictObject({
  code: zod.number(),
  message: zod.string(),
  data: zod.unknown(),
});

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /登录/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

async function parseAdminData<TSchema extends z.ZodType>(
  response: Response,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  expect(response.ok()).toBe(true);
  const body = adminApiResponseSchema.parse(await response.json());
  expect(body.code).toBe(0);
  return schema.parse(body.data);
}

function formItem(page: Page, label: string) {
  return page.locator(".ant-form-item").filter({ hasText: label }).first();
}

test.describe("Product Variant Catalog admin API contract", () => {
  skipUnlessAdminMutationE2eEnabled(test);

  test("creates a product and variant through the browser against the real admin API", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const unique = Date.now().toString(36);
    const productName = `E2E契约商品-${unique}`;
    const sku = `E2E-CONTRACT-${unique}`;

    await login(page);
    await page.goto("/products");
    const monitor = await installAdminBrowserContractMonitor(page);
    const observedVariantRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (!url.includes("/api/product-variants")) return;
      observedVariantRequests.push(`${request.method()} ${url}`);
    });
    await page.getByRole("button", { name: /新增商品/ }).click();
    await expect(
      page.locator(".ant-drawer").filter({ hasText: "新增商品" }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await formItem(page, "商品名称").locator("input").fill(productName);

    const [productResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/products") &&
          response.request().method() === "POST",
      ),
      page.getByRole("button", { name: /保存/ }).click(),
    ]);
    const product = await parseAdminData(
      productResponse,
      adminProductResponseSchema,
    );
    expect(product.name).toBe(productName);

    const productRow = page
      .locator(".ant-table-row")
      .filter({ hasText: productName })
      .first();
    await expect(productRow).toBeVisible({ timeout: 10_000 });
    await productRow.getByRole("button", { name: "SKU" }).click();
    await page.getByRole("button", { name: /新增 SKU/ }).click();

    const modal = page.locator(".ant-modal").filter({ hasText: "新增 SKU" });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await formItem(page, "SKU").locator("input").fill(sku);
    await formItem(page, "售价(分)").locator("input").fill("321");
    await formItem(page, "成本(分)").locator("input").fill("123");

    const [variantResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/product-variants") &&
          response.request().method() === "POST",
      ),
      modal.locator(".ant-btn-primary").click(),
    ]);
    const variant = await parseAdminData(
      variantResponse,
      adminProductVariantResponseSchema,
    );

    expect(variant.productId).toBe(product.id);
    expect(variant.sku).toBe(sku);
    expect(variant.priceCents).toBe(321);
    expect(variant.costCents).toBe(123);

    await expect(
      page.locator(".ant-modal").filter({ hasText: "新增 SKU" }),
    ).toBeHidden({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(
      page.locator(".ant-drawer").filter({ hasText: "SKU 列表" }),
    ).toBeHidden({ timeout: 10_000 });

    await productRow.getByRole("button", { name: "编辑" }).click();
    const productDrawer = page
      .locator(".ant-drawer")
      .filter({ hasText: "编辑商品" });
    await expect(productDrawer).toBeVisible({ timeout: 10_000 });
    const [imageUploadResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/media-assets/product-display-images") &&
          response.request().method() === "POST",
      ),
      productDrawer.locator("input[type='file']").setInputFiles({
        name: "product.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    ]);
    expect(imageUploadResponse.ok()).toBe(true);
    await expect(productDrawer.getByAltText(productName)).toBeVisible({
      timeout: 10_000,
    });
    const [productUpdateResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/products/${product.id}`) &&
          response.request().method() === "PATCH",
      ),
      productDrawer.getByRole("button", { name: /保存/ }).click(),
    ]);
    const updatedProduct = await parseAdminData(
      productUpdateResponse,
      adminProductResponseSchema,
    );
    expect(updatedProduct.displayImageMediaAsset).toEqual(expect.any(Object));
    await expect(productDrawer).toBeHidden({ timeout: 10_000 });

    const updatedProductRow = page
      .locator(".ant-table-row")
      .filter({ hasText: productName })
      .first();
    await updatedProductRow.getByRole("button", { name: "SKU" }).click();
    const variantDrawer = page
      .locator(".ant-drawer")
      .filter({ hasText: "SKU 列表" });
    await expect(variantDrawer).toBeVisible({ timeout: 10_000 });
    const variantRow = variantDrawer
      .locator(".ant-table-row")
      .filter({ hasText: sku });
    await expect(variantRow).toBeVisible({ timeout: 10_000 });
    await variantRow.getByRole("button", { name: /编\s*辑/ }).click();
    const editVariantModal = page
      .locator(".ant-modal")
      .filter({ hasText: "编辑 SKU" });
    await expect(editVariantModal).toBeVisible({ timeout: 10_000 });
    const variantPriceInput = formItem(page, "售价(分)").locator("input");
    await variantPriceInput.fill("456");
    await variantPriceInput.blur();
    const [silhouetteUploadResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/media-assets/try-on-silhouettes") &&
          response.request().method() === "POST",
      ),
      editVariantModal.locator("input[type='file']").setInputFiles({
        name: "silhouette.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    ]);
    expect(silhouetteUploadResponse.ok()).toBe(true);
    await expect(editVariantModal.getByAltText(`${sku} 试穿剪影`)).toBeVisible({
      timeout: 10_000,
    });
    const saveVariantButton = editVariantModal.getByRole("button", {
      name: /确\s*定/,
    });
    await expect(saveVariantButton).toBeEnabled({ timeout: 10_000 });
    const variantUpdateResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/product-variants/${variant.id}`) &&
        response.request().method() === "PATCH",
      { timeout: 10_000 },
    );
    await saveVariantButton.click();
    const variantUpdateResponse = await variantUpdateResponsePromise.catch(
      async (error: unknown) => {
        await monitor.assertNoFailures();
        throw new Error(
          [
            `SKU 编辑保存未发出 PATCH: ${String(error)}`,
            `observed=${JSON.stringify(observedVariantRequests)}`,
          ].join("\n"),
        );
      },
    );
    const updatedVariant = await parseAdminData(
      variantUpdateResponse,
      adminProductVariantResponseSchema,
    );
    expect(updatedVariant.priceCents).toBe(456);
    expect(updatedVariant.tryOnSilhouetteMediaAsset).toEqual(
      expect.any(Object),
    );
    await monitor.assertNoFailures();
  });
});
