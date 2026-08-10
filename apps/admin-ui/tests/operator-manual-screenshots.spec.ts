import { expect, type Locator, type Page, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  loginAsAdmin,
  waitForAdminUiSettled,
} from "./support/admin-browser-contract";
import { skipUnlessAdminMutationE2eEnabled } from "./support/admin-mutation-e2e";

const CAPTURE_ENABLED = process.env.VEM_ADMIN_MANUAL_SCREENSHOT_CAPTURE === "1";
const CAPTURE_IDS = new Set(
  (process.env.VEM_ADMIN_MANUAL_SCREENSHOT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);
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
      const hasBody = init.body !== null && init.body !== undefined;
      const response = await fetch(`/api${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${token}`,
        },
        body: hasBody ? JSON.stringify(init.body) : undefined,
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
  return execFileSync("git", ["rev-parse", "HEAD"], {
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
  if (CAPTURE_IDS.size > 0 && !CAPTURE_IDS.has(input.id)) return;
  await mkdir(SCREENSHOT_ROOT, { recursive: true });
  const pngPath = resolve(SCREENSHOT_ROOT, `${input.id}.png`);
  const metadataPath = resolve(SCREENSHOT_ROOT, `${input.id}.json`);
  const viewport = page.viewportSize();
  await Promise.all(
    input.expectedTexts.map(async (text) => {
      await expect(
        page.getByText(visibleTextPattern(text)).first(),
      ).toBeVisible({
        timeout: 10_000,
      });
    }),
  );
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
        sourceCommit:
          process.env.VEM_ADMIN_MANUAL_SCREENSHOT_SOURCE_COMMIT ??
          currentCommit(),
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
      },
    },
  );
  return { machine, slot, product, variant };
}

type IncidentActionRequest = {
  action: string;
  reason: string;
  refundId?: string;
};

async function installOrderIncidentRoutes(
  page: Page,
): Promise<IncidentActionRequest[]> {
  const incidentActions: IncidentActionRequest[] = [];
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
  await page.route("**/api/payments/*/incident-actions", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON() as IncidentActionRequest;
    incidentActions.push(body);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          action: body.action,
          status: "submitted",
          handled: true,
          message: "处理动作已提交",
          protectedDiagnostics: {},
        },
      }),
    });
  });
  return incidentActions;
}

function formItem(page: Page | Locator, label: string) {
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
    test.setTimeout(150_000);
    const { machine, slot, product, variant } =
      await seedCatalogForScreenshots(page);

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
    await captureManualScreenshot(page, {
      id: "admin-product-sku-editor",
      route: "/products#sku-list",
      expectedTexts: ["SKU 列表", "新增 SKU", "价格(分)", "编辑"],
    });
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
    await skuModal.getByRole("button", { name: /确\s*定/ }).click();
    await expect(skuModal).toBeHidden({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await expect(skuDrawer).toBeHidden({ timeout: 10_000 });

    await productRow.getByRole("button", { name: "新增试衣源" }).click();
    const tryOnGarmentModal = page
      .locator(".ant-modal")
      .filter({ hasText: "Try-On Garment 草稿" });
    await expect(tryOnGarmentModal).toBeVisible({ timeout: 10_000 });
    await formItem(tryOnGarmentModal, "可见颜色")
      .locator("input")
      .fill("手册海军蓝");
    await tryOnGarmentModal.locator("input[type='file']").setInputFiles({
      name: "manual-garment.png",
      mimeType: "image/png",
      buffer: transparentGarmentPng(768, 1024),
    });
    const garmentPreview = tryOnGarmentModal.getByAltText(
      "Try-On Garment 来源预览",
    );
    await expect(garmentPreview).toBeVisible({ timeout: 10_000 });
    await expect(
      tryOnGarmentModal.getByText(/校验通过：透明 PNG/),
    ).toBeVisible();
    await tryOnGarmentModal.getByRole("button", { name: "创建草稿" }).click();
    await expect(
      tryOnGarmentModal.getByRole("button", { name: "确认来源" }),
    ).toBeVisible();
    await tryOnGarmentModal.getByRole("button", { name: "确认来源" }).click();
    await expect(
      tryOnGarmentModal.getByRole("button", { name: "激活 Garment" }),
    ).toBeVisible();
    await tryOnGarmentModal
      .getByRole("button", { name: "激活 Garment" })
      .click();
    await expect(tryOnGarmentModal.getByText("共享尺码影响范围")).toBeVisible();
    await tryOnGarmentModal
      .getByRole("checkbox", { name: variant.sku })
      .check();
    await tryOnGarmentModal
      .getByRole("button", { name: "保存共享尺码关联" })
      .click();
    await expect(tryOnGarmentModal.getByText(/已原子关联/)).toBeVisible();
    await captureManualScreenshot(page, {
      id: "admin-try-on-garment-upload",
      route: "/products#try-on-garment",
      expectedTexts: [
        "Try-On Garment 草稿",
        "透明 PNG 来源",
        "共享尺码影响范围",
        "保存共享尺码关联",
      ],
    });
    await tryOnGarmentModal.getByRole("button", { name: /取\s*消/ }).click();
    await expect(tryOnGarmentModal).toBeHidden({ timeout: 10_000 });

    await page.goto("/inventory");
    await waitForAdminUiSettled(page);
    const [bindMachinesResponse, bindProductsResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/api/machines") &&
          response.request().method() === "GET",
      ),
      page.waitForResponse(
        (response) =>
          response.url().includes("/api/products") &&
          response.request().method() === "GET",
      ),
      page.getByRole("button", { name: "绑定库存" }).click(),
    ]);
    expect(bindMachinesResponse.ok()).toBe(true);
    expect(bindProductsResponse.ok()).toBe(true);
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
    await adminApi(page, "/inventories", {
      method: "POST",
      body: {
        machineId: machine.id,
        slotId: slot.id,
        variantId: variant.id,
        onHandQty: 5,
        reservedQty: 0,
        lowStockThreshold: 1,
        note: "手册工作流验收",
      },
    });
    await page.goto("/inventory");
    await waitForAdminUiSettled(page);
    await expect(
      page.locator(".ant-table-row").filter({ hasText: variant.sku }),
    ).toBeVisible({ timeout: 10_000 });

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
    const [paymentPolicyResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/payments/channel-policy") &&
          response.request().method() === "PUT",
      ),
      page.getByRole("button", { name: "保存" }).click(),
    ]);
    expect(paymentPolicyResponse.ok()).toBe(true);

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

    const incidentActions = await installOrderIncidentRoutes(page);
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
    await orderDrawer.locator("textarea").first().fill("手册工作流验收");
    const [incidentActionResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response
            .url()
            .endsWith(
              "/api/payments/manual-payment-unknown/incident-actions",
            ) && response.request().method() === "POST",
      ),
      orderDrawer.getByRole("button", { name: "查询支付" }).click(),
    ]);
    expect(incidentActionResponse.ok()).toBe(true);
    expect(incidentActions).toContainEqual(
      expect.objectContaining({
        action: "query_payment",
        reason: "手册工作流验收",
      }),
    );
  });
});

function transparentGarmentPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (
    let row = Math.floor(height / 4);
    row < Math.ceil((height * 3) / 4);
    row += 1
  ) {
    const offset = row * (width * 4 + 1);
    for (
      let column = Math.floor(width / 4);
      column < Math.ceil((width * 3) / 4);
      column += 1
    ) {
      const pixel = offset + 1 + column * 4;
      pixels[pixel] = 20;
      pixels[pixel + 1] = 50;
      pixels[pixel + 2] = 110;
      pixels[pixel + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
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
