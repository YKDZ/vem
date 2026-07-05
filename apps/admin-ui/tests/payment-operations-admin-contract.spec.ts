import { expect, type Page, test } from "@playwright/test";
import { paymentProviderConfigSchema } from "@vem/shared";

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "AdminPassword123!";

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /登录/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

test.describe("Payment Operations admin API contract", () => {
  test("upserts an Alipay provider config through the admin-ui contract helper against the real admin API", async ({
    page,
  }) => {
    const unique = Date.now().toString(36);
    const merchantNo = `e2e-mch-${unique}`;
    const appId = `e2e-app-${unique}`;

    await login(page);
    await page.goto("/payments");

    const configPayload = await page.evaluate(
      async ({ appId, merchantNo }) => {
        const paymentsModulePath = "/src/api/payments.ts";
        const { upsertPaymentProviderConfig } = (await import(
          paymentsModulePath
        )) as typeof import("../src/api/payments");
        return await upsertPaymentProviderConfig({
          providerCode: "alipay",
          machineId: null,
          merchantNo,
          appId,
          status: "enabled",
          publicConfigJson: {
            mode: "sandbox",
            gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
            keyType: "PKCS8",
            qrExpiresMinutes: 10,
          },
          sensitiveConfigJson: {
            privateKeyPem: "test-key",
            appCertPem: "test-cert",
            alipayPublicCertPem: "test-alipay-cert",
            alipayRootCertPem: "test-root-cert",
          },
        });
      },
      { appId, merchantNo },
    );

    const config = paymentProviderConfigSchema.parse(configPayload);
    expect(config.providerCode).toBe("alipay");
    expect(config.providerName.length).toBeGreaterThan(0);
    expect(config.merchantNo).toBe(merchantNo);
    expect(config.appId).toBe(appId);
    expect(config.derivedNotifyUrl).toContain("/api/payments/webhooks/alipay");
    expect(config.secretStatusJson).toEqual(expect.any(Object));

    await page.reload();
    await page.getByRole("tab", { name: "支付配置" }).click();
    await expect(
      page.locator(".ant-table-row").filter({ hasText: merchantNo }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
