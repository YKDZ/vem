import { expect, type Page, test } from "@playwright/test";

const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "AdminPassword123!";

async function login(
  page: Page,
  username: string,
  password: string,
  expectedPath: RegExp = /\/dashboard|\/403/,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: /登录/ }).click();
  await expect(page).toHaveURL(expectedPath, { timeout: 10_000 });
}

test.describe("Access Management insufficient permission", () => {
  test("limited admin cannot see or execute admin user writes through the deployed UI session", async ({
    page,
  }) => {
    const unique = Date.now().toString(36);
    const limitedUsername = `limited-ui-${unique}`;
    const limitedPassword = "LimitedPassword123!";

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD, /\/dashboard/);

    await page.evaluate(
      async ({ limitedPassword, limitedUsername, unique }) => {
        const token = localStorage.getItem("vem.admin.accessToken");
        const post = async (path: string, body: unknown): Promise<unknown> => {
          const response = await fetch(`/api${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
          });
          const payload = (await response.json()) as {
            data?: unknown;
            message?: string;
          };
          if (!response.ok) throw new Error(payload.message ?? path);
          return payload.data;
        };
        const role = (await post("/roles", {
          code: `limited_ui_${unique}`,
          name: `Limited UI ${unique}`,
          permissionCodes: ["adminUsers.read"],
        })) as { id: string };
        await post("/admin-users", {
          username: limitedUsername,
          password: limitedPassword,
          displayName: `Limited UI ${unique}`,
          roleIds: [role.id],
        });
      },
      { limitedPassword, limitedUsername, unique },
    );

    await page.evaluate(() => {
      localStorage.clear();
    });
    await login(page, limitedUsername, limitedPassword);

    await page.goto("/system-settings");
    await expect(page).toHaveURL(/\/system-settings/);
    await expect(page.getByRole("tab", { name: "用户管理" })).toBeVisible();
    await expect(page.getByRole("button", { name: /新增用户/ })).toHaveCount(0);

    const writeAttempt = await page.evaluate(
      async ({ unique }) => {
        const token = localStorage.getItem("vem.admin.accessToken");
        const response = await fetch("/api/admin-users", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            username: `blocked-ui-${unique}`,
            password: "BlockedPassword123!",
            displayName: "Blocked UI Write",
          }),
        });
        return { ok: response.ok, status: response.status };
      },
      { unique },
    );

    expect(writeAttempt).toEqual({ ok: false, status: 403 });
  });
});
