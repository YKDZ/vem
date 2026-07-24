import { expect, type Page, test } from "@playwright/test";
import { paymentProviderConfigSchema } from "@vem/shared";
import { generateKeyPairSync } from "node:crypto";

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "AdminPassword123!";
const TEST_CERTIFICATE_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIICGjCCAYOgAwIBAgIUUUroCd7Tcfhw8LiUotQwSuGaQkYwDQYJKoZIhvcNAQEL",
  "BQAwHzEdMBsGA1UEAwwUVkVNIFRlc3QgQ2VydGlmaWNhdGUwHhcNMjYwNTA2MDUw",
  "MzIwWhcNMjcwNTA2MDUwMzIwWjAfMR0wGwYDVQQDDBRWRU0gVGVzdCBDZXJ0aWZp",
  "Y2F0ZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA2GWhrrFq7TCKMHSzlNt4",
  "8RP76RC0gRiVB5SgdDBJpQFT/ijn274zc5FpAkMBpa1weXeMQnzfu3AmBtpd8Ngu",
  "T6YrEY7LXkG+d9CukcidcEoTd3qdEig4aQr0CjupDFN7hAPWT4fxLQpikBr/4HeV",
  "IpYCVJsldn8ft4F18qJQMzMCAwEAAaNTMFEwHQYDVR0OBBYEFLrM+UtsnitLTiFZ",
  "k8shSRTFOJDaMB8GA1UdIwQYMBaAFLrM+UtsnitLTiFZk8shSRTFOJDaMA8GA1Ud",
  "EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADgYEACrb5ti4ca2y0t+CqcbRJ2hkt",
  "Q6IgvaB8o//IgXh1OiARj77yDlIpjbGNPbizPdHazsoNxgAkrM0ZXF0QBYRTasXD",
  "MBSg5izad5GrLVcOOJJFkyOdLWRrOkoEiD3EdVqbryxYAkVfCthk0IJde+uGl2kK",
  "fle74W8/qV53VzGPjlI=",
  "-----END CERTIFICATE-----",
].join("\n");

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /登录/ }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

test.describe("Payment Operations admin API contract", () => {
  test("upserts an Alipay provider config through the deployed UI session against the real admin API", async ({
    page,
  }) => {
    const unique = Date.now().toString(36);
    const merchantNo = `e2e-mch-${unique}`;
    const appId = `e2e-app-${unique}`;
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    await login(page);
    await page.goto("/payments");

    const configPayload = await page.evaluate(
      async ({ appId, merchantNo, privateKey, testCertificate }) => {
        const token = localStorage.getItem("vem.admin.accessToken");
        const response = await fetch("/api/payments/provider-configs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
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
              privateKeyPem: privateKey,
              appCertPem: testCertificate,
              alipayPublicCertPem: testCertificate,
              alipayRootCertPem: testCertificate,
            },
          }),
        });
        const payload = (await response.json()) as {
          data?: unknown;
          message?: string;
        };
        if (!response.ok) throw new Error(payload.message ?? "payment config");
        return payload.data;
      },
      { appId, merchantNo, privateKey, testCertificate: TEST_CERTIFICATE_PEM },
    );

    const config = paymentProviderConfigSchema.parse(configPayload);
    expect(config.providerCode).toBe("alipay");
    expect(config.providerName.length).toBeGreaterThan(0);
    expect(config.merchantNo).toBe(merchantNo);
    expect(config.appId).toBe(appId);
    expect(config.derivedNotifyUrl).toContain("/api/payments/webhooks/alipay");
    expect(config.secretStatusJson).toEqual(expect.any(Object));

    await page.reload();
    await page.getByRole("tab", { name: "支付机构" }).click();
    const alipayProviderRow = page
      .locator(".ant-table-row")
      .filter({ hasText: "支付宝" });
    await expect(alipayProviderRow).toContainText("已配置", {
      timeout: 10_000,
    });
    await alipayProviderRow.getByRole("button", { name: "编辑" }).click();
    await expect(
      page.getByRole("dialog", { name: /支付宝配置/ }),
    ).toBeVisible();
    await expect(
      page
        .locator(".ant-form-item")
        .filter({ hasText: "商户号" })
        .locator("input"),
    ).toHaveValue(merchantNo);
    await expect(page.getByText("当前支付机构默认使用此配置")).toBeVisible();
  });
});
