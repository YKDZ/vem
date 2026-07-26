import { expect, test } from "@playwright/test";

import {
  installAdminBrowserContractMonitor,
  loginAsAdmin,
  waitForAdminUiSettled,
} from "./support/admin-browser-contract";

type TabbedAdminPage = {
  path: string;
  routeLabel: string;
  tabs: string[];
  hiddenTabs?: string[];
};

const TABBED_ADMIN_PAGES: TabbedAdminPage[] = [
  {
    path: "/payments",
    routeLabel: "支付管理",
    tabs: [
      "支付流水",
      "支付渠道",
      "支付机构",
      "回调事件",
      "回调审计",
      "对账记录",
      "退款管理",
      "付款码尝试",
    ],
    hiddenTabs: ["上线门禁"],
  },
  {
    path: "/system-settings",
    routeLabel: "系统配置",
    tabs: ["天气服务", "用户管理", "角色权限"],
  },
  {
    path: "/notifications",
    routeLabel: "通知中心",
    tabs: ["通知列表", "维护工单"],
  },
];

test.describe("Admin tabbed page contract acceptance", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  for (const adminPage of TABBED_ADMIN_PAGES) {
    test(`${adminPage.routeLabel} visible tabs settle without contract violations`, async ({
      page,
    }) => {
      const monitor = await installAdminBrowserContractMonitor(page);

      await page.goto(adminPage.path);
      await expect(page).toHaveURL(new RegExp(`${adminPage.path}$`), {
        timeout: 10_000,
      });
      await waitForAdminUiSettled(page);
      await monitor.assertNoFailures();

      await adminPage.tabs.reduce<Promise<void>>(async (previous, tabName) => {
        await previous;
        const tab = page.getByRole("tab", { name: tabName });
        await expect(tab).toBeVisible({ timeout: 10_000 });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true", {
          timeout: 10_000,
        });
        await waitForAdminUiSettled(page);
        await monitor.assertNoFailures();
      }, Promise.resolve());

      await Promise.all(
        (adminPage.hiddenTabs ?? []).map(async (hiddenTabName) => {
          await expect(
            page.getByRole("tab", { name: hiddenTabName }),
          ).toHaveCount(0);
        }),
      );
    });
  }
});
