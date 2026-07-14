import { expect, test, type Page } from "@playwright/test";

import { getMachineRuntimeScenario } from "../src/dev/runtime-scenarios";
import {
  getUiDebugScenario,
  saleViewOverrideKey,
} from "../src/dev/ui-debug-fixtures";
import { expectKioskMainFrame } from "./support/touchscreen";
import { loadMachineRuntimeScenario } from "./support/ui-debug";

const readyCatalogScenario = getMachineRuntimeScenario("ready-catalog");
const soldOutCatalogScenario = getMachineRuntimeScenario("sold-out-catalog");

async function seedSaleViewOverride(page: Page, items: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    {
      key: saleViewOverrideKey("ready"),
      value: JSON.stringify({
        ...getUiDebugScenario("ready").saleView,
        items,
      }),
    },
  );
}

async function expectThreeFixedCategoryCards(page: Page): Promise<void> {
  const cards = page.locator(".home-category-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("袜子");
  await expect(cards.nth(1)).toContainText("内裤");
  await expect(cards.nth(2)).toContainText("T恤");

  const boxes = await Promise.all(
    [0, 1, 2].map((index) => cards.nth(index).boundingBox()),
  );
  expect(boxes.every((box) => box !== null)).toBe(true);
  const [first, second, third] = boxes as NonNullable<(typeof boxes)[number]>[];
  expect(first.x).toBeLessThan(second.x);
  expect(second.x).toBeLessThan(third.x);
  expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(second.y - third.y)).toBeLessThanOrEqual(1);
}

test.describe("catalog recovery visual behavior matrix", () => {
  test("keeps the ready catalog fixed at the kiosk viewport through presence and refresh", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1080, height: 1920 });
    await loadMachineRuntimeScenario(page, readyCatalogScenario);

    await expectKioskMainFrame(page);
    await expectThreeFixedCategoryCards(page);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByText("当前分类暂无可售商品，请选择其他分类或联系工作人员。"),
    ).toHaveCount(0);

    await page.locator(".catalog-home").click({ position: { x: 4, y: 4 } });
    await expect(page.locator(".catalog-home")).toHaveClass(/presence-present/);

    // CatalogView refreshes readiness every five seconds. It must keep the
    // customer on the fixed catalog instead of surfacing an error card.
    await page.waitForTimeout(5_200);
    await expect(page).toHaveURL(/#\/catalog$/);
    await expectThreeFixedCategoryCards(page);
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("keeps exactly one customer notification for the full sold-out state", async ({
    page,
  }) => {
    await loadMachineRuntimeScenario(page, soldOutCatalogScenario);
    await expectThreeFixedCategoryCards(page);
    await expect(page.locator(".home-category-card:disabled")).toHaveCount(3);
    await expect(page.getByRole("status")).toHaveCount(1);
    await expect(
      page.getByText("暂无可售商品，请稍后再来或联系工作人员。"),
    ).toHaveCount(1);
  });

  test("keeps a partially sold-out catalog purchasable without an error card", async ({
    page,
  }) => {
    const readyItems = getUiDebugScenario("ready").saleView.items.map(
      (item, index) =>
        index === 0
          ? {
              ...item,
              physicalStock: 0,
              saleableStock: 0,
              slotSalesState: "frozen",
            }
          : item,
    );
    await seedSaleViewOverride(page, readyItems);
    await loadMachineRuntimeScenario(page, readyCatalogScenario);
    await expectThreeFixedCategoryCards(page);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.locator(".home-category-card:disabled")).toHaveCount(0);
  });

  test("keeps unknown-category products purchasable through an explicit Other products entry", async ({
    page,
  }) => {
    const readyItems = getUiDebugScenario("ready").saleView.items.map(
      (item, index) =>
        index === 0
          ? {
              ...item,
              productName: "季节限定保暖披肩",
              categoryName: "季节限定",
            }
          : item,
    );
    await seedSaleViewOverride(page, readyItems);
    await loadMachineRuntimeScenario(page, readyCatalogScenario);

    await expectThreeFixedCategoryCards(page);
    const otherProducts = page
      .getByRole("button", { name: /其他商品/ })
      .first();
    await expect(otherProducts).toContainText("发现更多可售商品");
    await otherProducts.click();
    await expect(
      page.getByRole("button", { name: /季节限定保暖披肩/ }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
  });

  test("uses one image placeholder without a customer-visible catalog error card", async ({
    page,
  }) => {
    const readyItems = getUiDebugScenario("ready").saleView.items.map(
      (item, index) =>
        index === 0
          ? {
              ...item,
              coverImageUrl:
                "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
            }
          : item,
    );
    await seedSaleViewOverride(page, readyItems);
    await loadMachineRuntimeScenario(page, readyCatalogScenario);

    await page.getByRole("button", { name: /袜子/ }).click();
    const productImage = page.getByRole("img", { name: "商务中筒袜" }).first();
    await expect(productImage).toBeVisible();
    await expect(productImage).not.toHaveAttribute("src", /ui-debug\.local/);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByText("当前分类暂无可售商品，请选择其他分类或联系工作人员。"),
    ).toHaveCount(0);
  });
});
