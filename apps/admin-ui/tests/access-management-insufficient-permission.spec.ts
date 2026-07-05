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
  test("limited admin cannot see or execute admin user writes in the browser", async ({
    page,
  }) => {
    const unique = Date.now().toString(36);
    const limitedUsername = `limited-ui-${unique}`;
    const limitedPassword = "LimitedPassword123!";

    await login(page, ADMIN_USERNAME, ADMIN_PASSWORD, /\/dashboard/);

    await page.evaluate(
      async ({ limitedPassword, limitedUsername, unique }) => {
        const rolesModulePath = "/src/api/roles.ts";
        const adminUsersModulePath = "/src/api/admin-users.ts";
        const { createRole } = (await import(
          rolesModulePath
        )) as typeof import("../src/api/roles");
        const { createAdminUser } = (await import(
          adminUsersModulePath
        )) as typeof import("../src/api/admin-users");

        const role = await createRole({
          code: `limited_ui_${unique}`,
          name: `Limited UI ${unique}`,
          permissionCodes: ["adminUsers.read" as const],
        });
        await createAdminUser({
          username: limitedUsername,
          password: limitedPassword,
          displayName: `Limited UI ${unique}`,
          roleIds: [role.id],
        });
      },
      { limitedPassword, limitedUsername, unique },
    );

    await page.evaluate(() => localStorage.clear());
    await login(page, limitedUsername, limitedPassword);

    await page.goto("/admin-users");
    await expect(page).toHaveURL(/\/admin-users/);
    await expect(page.getByRole("button", { name: /新增用户/ })).toHaveCount(0);

    const writeAttempt = await page.evaluate(async ({ unique }) => {
      const adminUsersModulePath = "/src/api/admin-users.ts";
      const { createAdminUser } = (await import(
        adminUsersModulePath
      )) as typeof import("../src/api/admin-users");

      try {
        await createAdminUser({
          username: `blocked-ui-${unique}`,
          password: "BlockedPassword123!",
          displayName: "Blocked UI Write",
        });
        return { ok: true, status: null };
      } catch (error) {
        const maybeAxios = error as { response?: { status?: number } };
        return { ok: false, status: maybeAxios.response?.status ?? null };
      }
    }, { unique });

    expect(writeAttempt).toEqual({ ok: false, status: 403 });
  });
});
