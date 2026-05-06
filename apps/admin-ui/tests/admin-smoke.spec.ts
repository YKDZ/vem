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
  { path: "/notifications", label: "通知中心" },
  { path: "/admin-users", label: "后台用户" },
  { path: "/roles", label: "角色权限" },
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

    for (const { path, label } of PROTECTED_PAGES) {
      test(`${label} (${path}) loads without 5xx error`, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator(".ant-spin")).toHaveCount(0, {
          timeout: 8_000,
        });
        const bodyText = await page.locator("body").innerText();
        expect(bodyText).not.toContain("500");
        expect(bodyText).not.toContain("Internal Server Error");
      });
    }

    test("creates a product", async ({ page }) => {
      await page.goto("/products");
      await page.getByRole("button", { name: /新增商品/ }).click();
      await page.getByLabel("商品名称").fill("E2E测试饮料");
      await page.getByRole("button", { name: /保存/ }).click();
      await expect(page.getByText("E2E测试饮料")).toBeVisible({
        timeout: 5_000,
      });
    });

    test("creates a machine", async ({ page }) => {
      await page.goto("/machines");
      await page.getByRole("button", { name: /新增机器/ }).click();
      await page.getByLabel("编码").fill("E2E-MACHINE-001");
      await page.getByLabel("名称").fill("E2E测试机器");
      await page.getByRole("button", { name: /保存/ }).click();
      await expect(page.getByText("E2E-MACHINE-001")).toBeVisible({
        timeout: 5_000,
      });
    });
  });
});
