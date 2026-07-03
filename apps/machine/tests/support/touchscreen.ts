import { expect, type Locator, type Page } from "@playwright/test";

const KIOSK_WIDTH = 1080;
const KIOSK_HEIGHT = 1920;
const MIN_TOUCH_TARGET_SIZE = 44;

type BoundingBox = NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>;

export async function tapByRole(
  page: Page,
  role: Parameters<Page["getByRole"]>[0],
  options: Parameters<Page["getByRole"]>[1],
): Promise<void> {
  await tapLocator(page, page.getByRole(role, options));
}

export async function tapByVisibleLabel(
  page: Page,
  label: string | RegExp,
): Promise<void> {
  await tapLocator(
    page,
    page.getByText(label, { exact: typeof label === "string" }),
  );
}

export async function tapLocator(page: Page, locator: Locator): Promise<void> {
  const box = await getReasonableTouchTargetBox(locator);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

export async function expectReasonableTouchTarget(
  locator: Locator,
): Promise<void> {
  await getReasonableTouchTargetBox(locator);
}

async function getReasonableTouchTargetBox(
  locator: Locator,
): Promise<BoundingBox> {
  const target = locator.first();
  await expect(target).toBeVisible();
  let box = await target.boundingBox();
  if (box && !isBoxCenterInsideKioskViewport(box)) {
    await target.scrollIntoViewIfNeeded();
    box = await target.boundingBox();
  }
  expect(box, "touch target should have a visible bounding box").not.toBeNull();
  expect(box?.width ?? 0, "touch target width").toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET_SIZE,
  );
  expect(box?.height ?? 0, "touch target height").toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET_SIZE,
  );
  if (!box) {
    throw new Error("Cannot resolve touch target without a visible box.");
  }
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  expect(
    centerX,
    "touch target center x should be in kiosk viewport",
  ).toBeGreaterThanOrEqual(0);
  expect(
    centerX,
    "touch target center x should be in kiosk viewport",
  ).toBeLessThanOrEqual(KIOSK_WIDTH);
  expect(
    centerY,
    "touch target center y should be in kiosk viewport",
  ).toBeGreaterThanOrEqual(0);
  expect(
    centerY,
    "touch target center y should be in kiosk viewport",
  ).toBeLessThanOrEqual(KIOSK_HEIGHT);
  const receivesTouch = await target.evaluate(
    (element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit === element || Boolean(hit && element.contains(hit));
    },
    { x: centerX, y: centerY },
  );
  expect(receivesTouch, "touch target center should not be covered").toBe(true);
  return box;
}

function isBoxCenterInsideKioskViewport(box: BoundingBox): boolean {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return (
    centerX >= 0 &&
    centerX <= KIOSK_WIDTH &&
    centerY >= 0 &&
    centerY <= KIOSK_HEIGHT
  );
}

export async function expectKioskMainFrame(page: Page): Promise<void> {
  expect(page.viewportSize()).toEqual({
    width: KIOSK_WIDTH,
    height: KIOSK_HEIGHT,
  });
  const shell = page.locator(".kiosk-shell");
  await expect(shell).toBeVisible();
  await expect(shell).toHaveJSProperty("clientWidth", KIOSK_WIDTH);
  await expect(shell).toHaveJSProperty("clientHeight", KIOSK_HEIGHT);
}
