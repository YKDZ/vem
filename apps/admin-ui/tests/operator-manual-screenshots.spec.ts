import { expect, type Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loginAsAdmin,
  waitForAdminUiSettled,
} from "./support/admin-browser-contract";
import { skipUnlessAdminMutationE2eEnabled } from "./support/admin-mutation-e2e";

const CAPTURE_ENABLED = process.env.VEM_ADMIN_MANUAL_SCREENSHOT_CAPTURE === "1";
const SCREENSHOT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../public/manual/screenshots",
);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

type AdminApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

type SeededCatalog = {
  machine: { id: string; code: string; name: string };
  slot: { id: string };
  product: { id: string; name: string };
  variant: { id: string; sku: string };
};

async function adminApi<T>(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  return (await page.evaluate(
    async ({ path, init }) => {
      const token = localStorage.getItem("vem.admin.accessToken");
      const response = await fetch(`/api${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.body == null ? {} : { "content-type": "application/json" }),
          authorization: `Bearer ${token}`,
        },
        body: init.body == null ? undefined : JSON.stringify(init.body),
      });
      const payload = (await response.json()) as AdminApiResponse<unknown>;
      if (!response.ok || payload.code !== 0) {
        throw new Error(
          `${init.method ?? "GET"} ${path} failed: ${payload.message}`,
        );
      }
      return payload.data;
    },
    { path, init },
  )) as T;
}

function currentCommit(): string {
  return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    encoding: "utf8",
  }).trim();
}

function visibleTextPattern(text: string): RegExp {
  const escapedCharacters = Array.from(text).map((character) =>
    character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(escapedCharacters.join("\\s*"));
}

async function captureManualScreenshot(
  page: Page,
  input: {
    id: string;
    route: string;
    expectedTexts: string[];
  },
): Promise<void> {
  await mkdir(SCREENSHOT_ROOT, { recursive: true });
  const pngPath = resolve(SCREENSHOT_ROOT, `${input.id}.png`);
  const metadataPath = resolve(SCREENSHOT_ROOT, `${input.id}.json`);
  const viewport = page.viewportSize();
  for (const text of input.expectedTexts) {
    await expect(page.getByText(visibleTextPattern(text)).first()).toBeVisible({
      timeout: 10_000,
    });
  }
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((animation) =>
            ["finished", "idle"].includes(animation.playState),
          ),
      undefined,
      { timeout: 2_000 },
    )
    .catch(() => undefined);
  await page.screenshot({ path: pngPath, fullPage: false });
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        id: input.id,
        source: "admin-ui",
        route: input.route,
        capturedAt: new Date().toISOString(),
        commit: currentCommit(),
        viewport: viewport ?? { width: 1440, height: 1080 },
        expectedOrientation: "landscape",
        expectedTexts: input.expectedTexts,
        detectedTexts: input.expectedTexts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function seedCatalogForScreenshots(page: Page): Promise<SeededCatalog> {
  const unique = Date.now().toString(36);
  const machine = await adminApi<{ id: string; code: string; name: string }>(
    page,
    "/machines",
    {
      method: "POST",
      body: {
        code: `MANUAL-${unique}`,
        name: "手册验收机器",
        locationLabel: "手册截图",
      },
    },
  );
  const slot = await adminApi<{ id: string }>(
    page,
    `/machines/${machine.id}/slots`,
    {
      method: "POST",
      body: { rowNo: 7, cellNo: 1, capacity: 10, status: "enabled" },
    },
  );
  const product = await adminApi<{ id: string; name: string }>(
    page,
    "/products",
    {
      method: "POST",
      body: {
        name: `手册验收商品-${unique}`,
        description: "用于运营手册截图",
        status: "active",
        sortOrder: 0,
      },
    },
  );
  const variant = await adminApi<{ id: string; sku: string }>(
    page,
    "/product-variants",
    {
      method: "POST",
      body: {
        productId: product.id,
        sku: `MANUAL-SKU-${unique}`,
        priceCents: 321,
        costCents: null,
        status: "active",
        size: "L",
        color: "黑色",
        barcode: null,
        targetGender: null,
        tryOnSilhouetteMediaAssetId: null,
      },
    },
  );
  return { machine, slot, product, variant };
}

async function installOrderIncidentRoutes(page: Page): Promise<void> {
  const now = "2026-07-25T12:00:00.000Z";
  const order = {
    id: "manual-order-incident",
    orderNo: "ORD-MANUAL-INCIDENT",
    machineId: "manual-machine",
    machineCode: "VEM-MANUAL",
    status: "manual_handling",
    paymentState: "payment_unknown",
    fulfillmentState: "manual_handling",
    totalAmountCents: 1200,
    currency: "CNY",
    paidAt: null,
    dispensedAt: null,
    canceledAt: null,
    createdAt: now,
  };
  const orderListItem = {
    id: order.id,
    orderNo: order.orderNo,
    machineId: order.machineId,
    machineCode: order.machineCode,
    status: order.status,
    paymentState: order.paymentState,
    fulfillmentState: order.fulfillmentState,
    totalAmountCents: order.totalAmountCents,
    paidAt: order.paidAt,
    dispensedAt: order.dispensedAt,
    createdAt: order.createdAt,
  };
  const investigation = {
    order,
    items: [],
    payments: [
      {
        id: "manual-payment-unknown",
        paymentNo: "PAY-MANUAL-UNKNOWN",
        orderId: order.id,
        method: "payment_code",
        status: "unknown",
        amountCents: 1200,
        expiresAt: null,
        paidAt: null,
        failedReason: null,
        protectedDiagnostics: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    paymentEvents: [
      {
        id: "manual-payment-event",
        paymentId: "manual-payment-unknown",
        eventType: "payment.unknown",
        signatureValid: true,
        handledAt: now,
        protectedDiagnostics: { providerEventId: "provider-event-1" },
        createdAt: now,
      },
    ],
    paymentWebhookAttempts: [],
    paymentReconciliationAttempts: [],
    paymentCodeAttempts: [
      {
        id: "manual-code-attempt",
        paymentId: "manual-payment-unknown",
        orderId: order.id,
        attemptNo: 1,
        idempotencyKey: "manual-code-attempt-key",
        status: "reversal_unknown",
        isActive: false,
        amountCents: 1200,
        currency: "CNY",
        authCodeMasked: "2876****4394",
        source: "serial_text",
        submittedAt: now,
        lastCheckedAt: now,
        reversedAt: null,
        finishedAt: null,
        manualReason: "渠道查询超时",
        protectedDiagnostics: {
          providerPaymentNo: "PCA001",
          providerStatus: "UNKNOWN",
          failureMessage: "撤销结果未知",
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    vendingCommands: [],
    fulfillmentProjection: {
      state: "manual_handling",
      latestCommand: null,
      requiresPhysicalOutcomeConfirmation: false,
      availableRecoveryActions: ["request_refund"],
    },
    inventoryMovements: [],
    stockReconciliationLinks: [],
    refunds: [
      {
        id: "manual-refund-processing",
        refundNo: "RFD-MANUAL-PROCESSING",
        paymentId: "manual-payment-unknown",
        orderId: order.id,
        amountCents: 1200,
        status: "processing",
        reason: "admin_refund",
        requestedByAdminUserId: null,
        refundedAt: null,
        reconciliationAttempts: [
          {
            trigger: "manual",
            attemptNo: 1,
            status: "network_error",
            nextRetryAt: null,
            startedAt: now,
            finishedAt: now,
            protectedDiagnostics: { errorMessage: "渠道查询超时" },
            createdAt: now,
          },
        ],
        protectedDiagnostics: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    maintenanceWorkOrders: [],
    adminAuditEntries: [],
    orderStatusEvents: [],
  };

  await page.route("**/api/orders**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/orders/manual-order-incident/investigation"
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ code: 0, message: "ok", data: investigation }),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/orders") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          code: 0,
          message: "ok",
          data: {
            items: [orderListItem],
            total: 1,
            page: 1,
            pageSize: 20,
          },
        }),
      });
      return;
    }
    await route.fallback();
  });
}

function formItem(page: Page, label: string) {
  return page.locator(".ant-form-item").filter({ hasText: label }).first();
}

test.describe("Operator manual Admin UI screenshots", () => {
  skipUnlessAdminMutationE2eEnabled(test);

  test.skip(
    !CAPTURE_ENABLED,
    "manual screenshots are captured only when explicitly requested",
  );

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1080 });
    await loginAsAdmin(page);
  });

  test("captures product, inventory, payment, machine, and incident details", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { machine, product, variant } = await seedCatalogForScreenshots(page);

    await page.goto("/products");
    await waitForAdminUiSettled(page);
    const productRow = page.locator(".ant-table-row").filter({
      hasText: product.name,
    });
    await productRow.getByRole("button", { name: "编辑" }).click();
    const productDrawer = page
      .locator(".ant-drawer")
      .filter({ hasText: "编辑商品" });
    await expect(productDrawer).toBeVisible({ timeout: 10_000 });
    await productDrawer.locator("input[type='file']").setInputFiles({
      name: "product.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });
    await expect(productDrawer.getByAltText(product.name)).toBeVisible({
      timeout: 10_000,
    });
    await captureManualScreenshot(page, {
      id: "admin-product-image-upload",
      route: "/products#product-image",
      expectedTexts: ["展示图", "上传图片", "保存"],
    });
    await productDrawer.getByRole("button", { name: /保存/ }).click();
    await expect(productDrawer).toBeHidden({ timeout: 10_000 });

    await productRow.getByRole("button", { name: "SKU" }).click();
    const skuDrawer = page
      .locator(".ant-drawer")
      .filter({ hasText: "SKU 列表" });
    await expect(skuDrawer).toBeVisible({ timeout: 10_000 });
    const skuRow = skuDrawer.locator(".ant-table-row").filter({
      hasText: variant.sku,
    });
    await skuRow.getByRole("button", { name: /编\s*辑/ }).click();
    const skuModal = page.locator(".ant-modal").filter({ hasText: "编辑 SKU" });
    await expect(skuModal).toBeVisible({ timeout: 10_000 });
    await formItem(page, "售价(分)").locator("input").fill("456");
    await captureManualScreenshot(page, {
      id: "admin-product-price-edit",
      route: "/products#sku-price",
      expectedTexts: ["编辑 SKU", "售价(分)", "确定"],
    });
    await skuModal.locator("input[type='file']").setInputFiles({
      name: "silhouette.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });
    await expect(skuModal.getByAltText(`${variant.sku} 试穿剪影`)).toBeVisible({
      timeout: 10_000,
    });
    await captureManualScreenshot(page, {
      id: "admin-try-on-silhouette-upload",
      route: "/products#try-on-silhouette",
      expectedTexts: ["编辑 SKU", "试穿剪影", "确定"],
    });
    await skuModal.getByRole("button", { name: /确\s*定/ }).click();
    await expect(skuModal).toBeHidden({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(skuDrawer).toBeHidden({ timeout: 10_000 });

    await page.goto("/inventory");
    await waitForAdminUiSettled(page);
    await page.getByRole("button", { name: "绑定库存" }).click();
    const inventoryModal = page.locator(".ant-modal").filter({
      hasText: "绑定库存",
    });
    await expect(inventoryModal).toContainText("商品规格", {
      timeout: 10_000,
    });
    await captureManualScreenshot(page, {
      id: "admin-inventory-slot-binding",
      route: "/inventory#bind",
      expectedTexts: ["绑定库存", "机器", "货道", "商品规格"],
    });
    await page.keyboard.press("Escape");
    await expect(inventoryModal).toBeHidden({ timeout: 10_000 });

    await page.goto("/payments");
    await page.getByRole("tab", { name: "支付渠道" }).click();
    await expect(page.getByText("支付渠道管理")).toBeVisible({
      timeout: 10_000,
    });
    await captureManualScreenshot(page, {
      id: "admin-payment-channel-policy",
      route: "/payments#channels",
      expectedTexts: ["支付渠道管理", "启用", "默认", "保存"],
    });

    await page.goto("/machines");
    await waitForAdminUiSettled(page);
    const machineRow = page.locator(".ant-table-row").filter({
      hasText: machine.code,
    });
    await machineRow.getByRole("button", { name: "领取码" }).click();
    const claimDrawer = page.getByRole("dialog", {
      name: new RegExp(`领取码 - ${machine.code}`),
    });
    await expect(claimDrawer).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "生成领取码" }).click();
    await expect(page.getByText("请立即保存领取码")).toBeVisible({
      timeout: 10_000,
    });
    await captureManualScreenshot(page, {
      id: "admin-machine-claim-code",
      route: "/machines#claim-code",
      expectedTexts: ["领取码", "请立即保存领取码", "首次领取"],
    });
    await page.keyboard.press("Escape");
    await expect(claimDrawer).toBeHidden({ timeout: 10_000 });

    await installOrderIncidentRoutes(page);
    await page.goto("/orders");
    await expect(page.getByText("ORD-MANUAL-INCIDENT")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: "ORD-MANUAL-INCIDENT" }).click();
    const orderDrawer = page.getByRole("dialog", { name: /订单调查/ });
    await expect(orderDrawer).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("查询支付")).toBeVisible({ timeout: 10_000 });
    await captureManualScreenshot(page, {
      id: "admin-payment-incident-actions",
      route: "/orders#payment-incident",
      expectedTexts: ["订单调查", "查询支付", "申请退款处理", "标记人工处理"],
    });
  });
});
