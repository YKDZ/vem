import { expect, test } from "@playwright/test";

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "AdminPassword123!";

const PROTECTED_PAGES = [
  { path: "/dashboard", label: "仪表盘" },
  { path: "/products", label: "商品管理" },
  { path: "/machines", label: "机器管理" },
  { path: "/inventory", label: "库存管理" },
  { path: "/orders", label: "订单管理" },
  { path: "/payments", label: "支付管理" },
  { path: "/system-settings", label: "系统配置" },
  { path: "/notifications", label: "通知中心" },
  { path: "/audit-logs", label: "系统审计" },
];

test.describe("admin-smoke", () => {
  test("unauthenticated access to / redirects to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("login with valid credentials succeeds", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("用户名").fill(ADMIN_USERNAME);
    await page.getByLabel("密码").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /登录/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  });

  test.describe("authenticated page smoke tests", () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/login");
      await page.getByLabel("用户名").fill(ADMIN_USERNAME);
      await page.getByLabel("密码").fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: /登录/ }).click();
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
    });

    test("every visible sidebar destination settles without browser or API failures", async ({
      page,
    }) => {
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(`page: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") {
          failures.push(`console: ${message.text()}`);
        }
      });
      page.on("requestfailed", (request) => {
        failures.push(
          `request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
        );
      });
      page.on("response", (response) => {
        if (response.url().includes("/api/") && response.status() >= 400) {
          failures.push(`response: ${response.status()} ${response.url()}`);
        }
      });

      const sidebar = page.locator(".ant-layout-sider");
      await expect(sidebar).toBeVisible({ timeout: 10_000 });
      /* eslint-disable no-await-in-loop -- each navigation must settle before the next click */
      for (const { path, label } of PROTECTED_PAGES) {
        await sidebar.getByText(label, { exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`), {
          timeout: 10_000,
        });
        await expect(sidebar).toBeVisible();
        await page.waitForTimeout(250);
      }
      /* eslint-enable no-await-in-loop */

      expect(failures).toEqual([]);
    });

    test("creates a product", async ({ page }) => {
      await page.goto("/products");
      await page.getByRole("button", { name: /新增商品/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
      await page
        .locator(".ant-form-item")
        .filter({ hasText: "商品名称" })
        .locator("input")
        .fill("E2E测试饮料");
      await page.getByRole("button", { name: /保存/ }).click();
      await expect(page.getByText("E2E测试饮料")).toBeVisible({
        timeout: 5_000,
      });
    });

    test("creates a machine", async ({ page }) => {
      await page.goto("/machines");
      await page.getByRole("button", { name: /新增机器/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
      await page
        .locator(".ant-form-item")
        .filter({ hasText: "编码" })
        .locator("input")
        .fill("E2E-MACHINE-001");
      await page
        .locator(".ant-form-item")
        .filter({ hasText: "名称" })
        .locator("input")
        .fill("E2E测试机器");
      await page.getByRole("button", { name: /保存/ }).click();
      await expect(page.getByText("E2E-MACHINE-001")).toBeVisible({
        timeout: 5_000,
      });
    });

    test("payment provider drawer shows provider-specific fields and hides generic api key", async ({
      page,
    }) => {
      await page.goto("/payments");
      await page.getByRole("tab", { name: "支付机构" }).click();
      const alipayProviderRow = page
        .locator(".ant-table-row")
        .filter({ hasText: "支付宝" });
      await expect(alipayProviderRow).toBeVisible({
        timeout: 8_000,
      });
      await alipayProviderRow.getByRole("button", { name: "编辑" }).click();
      await expect(
        page.getByRole("dialog", { name: /支付宝配置/ }),
      ).toBeVisible();
      await expect(page.getByText("二维码有效期")).toBeVisible();
      await expect(page.getByText("补偿窗口")).toBeVisible();
      await expect(page.getByText("应用私钥 PEM")).toBeVisible();
      await expect(page.getByText("API Key (敏感)")).toHaveCount(0);
    });
  });
});
