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
        type CreateRole = (body: {
          code: string;
          name: string;
          permissionCodes: string[];
        }) => Promise<{ id: string }>;
        type CreateAdminUser = (body: {
          username: string;
          password: string;
          displayName: string;
          roleIds?: string[];
        }) => Promise<unknown>;

        function isRecord(value: unknown): value is Record<string, unknown> {
          return typeof value === "object" && value !== null;
        }

        function isRolesModule(
          value: unknown,
        ): value is { createRole: CreateRole } {
          return isRecord(value) && typeof value.createRole === "function";
        }

        function isAdminUsersModule(
          value: unknown,
        ): value is { createAdminUser: CreateAdminUser } {
          return isRecord(value) && typeof value.createAdminUser === "function";
        }

        const rolesModulePath = "/src/api/roles.ts";
        const adminUsersModulePath = "/src/api/admin-users.ts";
        const rolesModule: unknown = await import(rolesModulePath);
        const adminUsersModule: unknown = await import(adminUsersModulePath);
        if (!isRolesModule(rolesModule)) {
          throw new Error("roles API module is unavailable");
        }
        if (!isAdminUsersModule(adminUsersModule)) {
          throw new Error("admin users API module is unavailable");
        }
        const { createRole } = rolesModule;
        const { createAdminUser } = adminUsersModule;

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
        type CreateAdminUser = (body: {
          username: string;
          password: string;
          displayName: string;
        }) => Promise<unknown>;

        function isRecord(value: unknown): value is Record<string, unknown> {
          return typeof value === "object" && value !== null;
        }

        function isAdminUsersModule(
          value: unknown,
        ): value is { createAdminUser: CreateAdminUser } {
          return isRecord(value) && typeof value.createAdminUser === "function";
        }

        function statusFromError(error: unknown): number | null {
          if (!isRecord(error) || !isRecord(error.response)) return null;
          return typeof error.response.status === "number"
            ? error.response.status
            : null;
        }

        const adminUsersModulePath = "/src/api/admin-users.ts";
        const adminUsersModule: unknown = await import(adminUsersModulePath);
        if (!isAdminUsersModule(adminUsersModule)) {
          throw new Error("admin users API module is unavailable");
        }
        const { createAdminUser } = adminUsersModule;

        try {
          await createAdminUser({
            username: `blocked-ui-${unique}`,
            password: "BlockedPassword123!",
            displayName: "Blocked UI Write",
          });
          return { ok: true, status: null };
        } catch (error) {
          return { ok: false, status: statusFromError(error) };
        }
      },
      { unique },
    );

    expect(writeAttempt).toEqual({ ok: false, status: 403 });
  });
});
