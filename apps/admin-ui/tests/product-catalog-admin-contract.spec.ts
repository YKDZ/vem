import type { z } from "zod";

import { expect, type Page, type Response, test } from "@playwright/test";
import {
  adminProductResponseSchema,
  adminProductVariantResponseSchema,
} from "@vem/shared";
import { z as zod } from "zod";

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
  test("creates a product and variant through the browser against the real admin API", async ({
    page,
  }) => {
    const unique = Date.now().toString(36);
    const productName = `E2E契约商品-${unique}`;
    const sku = `E2E-CONTRACT-${unique}`;

    await login(page);
    await page.goto("/products");
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
  });
});
