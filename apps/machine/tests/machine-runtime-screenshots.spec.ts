import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  selectScreenshotMachineRuntimeScenarios,
  type MachineRuntimeScenario,
} from "../src/dev/runtime-scenarios";
import { expectKioskMainFrame } from "./support/touchscreen";
import { loadMachineRuntimeScenario } from "./support/ui-debug";

const artifactRoot =
  process.env.VEM_MACHINE_RUNTIME_SCREENSHOT_ARTIFACT_DIR ??
  join(process.cwd(), "runtime-screenshot-artifacts");
const screenshotsDir = join(artifactRoot, "screenshots");
const manifestPath = join(artifactRoot, "manifest.json");
const runtimeScreenshotStorageKey = "vem.machine.runtimeScreenshot";

const selectedScenarios = selectScreenshotMachineRuntimeScenarios(
  process.env.VEM_MACHINE_RUNTIME_SCREENSHOT_SCENARIOS,
);

type ScreenshotManifest = {
  generatedAt: string;
  viewport: { width: number; height: number };
  scenarios: {
    id: string;
    name: string;
    category: string;
    targetRoute: string;
    screenshot: string;
  }[];
};

const dispensingScreenshotExpectations = {
  dispensing: {
    pickupTitle: "设备出货中",
    reminderCopy: "请稍候，商品正在送往取货口",
    noticeTitle: "出货完成后请取货",
  },
  "dispensing-pickup-15s": {
    pickupTitle: "请及时取走商品",
    reminderCopy: "取货倒计时进行中，请尽快取走商品",
    noticeTitle: "请尽快完成取货",
  },
  "dispensing-pickup-25s": {
    pickupTitle: "请立即取走商品",
    reminderCopy: "取货倒计时进行中，请尽快取走商品",
    noticeTitle: "取货口即将关闭",
  },
} as const;

test.beforeAll(async () => {
  await rm(artifactRoot, { force: true, recursive: true });
  await mkdir(screenshotsDir, { recursive: true });
});

test.afterAll(async () => {
  const manifest: ScreenshotManifest = {
    generatedAt: new Date().toISOString(),
    viewport: { width: 1080, height: 1920 },
    scenarios: selectedScenarios.map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      category: scenario.category,
      targetRoute: scenario.targetRoute,
      screenshot: `screenshots/${scenario.id}.png`,
    })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
});

for (const scenario of selectedScenarios) {
  test(`captures ${scenario.name} Machine Runtime Console screenshot`, async ({
    page,
  }) => {
    await loadMachineRuntimeScreenshotScenario(page, scenario);

    await expect(page).toHaveURL(new RegExp(`#${scenario.targetRoute}$`));
    await expectKioskMainFrame(page);
    await expectCoreElements(page, scenario);

    const screenshotPath = join(screenshotsDir, `${scenario.id}.png`);
    await page.screenshot({
      path: screenshotPath,
      clip: { x: 0, y: 0, width: 1080, height: 1920 },
      animations: "disabled",
    });
    await expectPngDimensions(screenshotPath, 1080, 1920);
  });
}

async function expectCoreElements(
  page: Page,
  scenario: MachineRuntimeScenario,
): Promise<void> {
  switch (scenario.id) {
    case "ready-catalog":
      await expect(page.getByRole("img", { name: "唐诗村" })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "请选择商品类别" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /T恤/ })).toBeVisible();
      break;
    case "sold-out-catalog":
      await expect(
        page.getByRole("heading", { name: "请选择商品类别" }),
      ).toBeVisible();
      await expect(page.getByText("暂时售罄")).toHaveCount(3);
      await expect(
        page.getByText("暂无可售商品，请稍后再来或联系工作人员。"),
      ).toBeVisible();
      break;
    case "product-list":
      await expect(
        page.getByRole("img", { name: "商品列表，请点击选择您需要的商品" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /基础短袖/ }),
      ).toBeVisible();
      await expect(page.getByText("¥59.00").first()).toBeVisible();
      break;
    case "product-detail":
      await expect(
        page.getByRole("heading", { name: "基础短袖" }),
      ).toBeVisible();
      await expect(page.locator(".detail-price")).toHaveText("¥59.00");
      await expect(page.getByText("商品库存")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /立即购买 ¥59.00/ }),
      ).toBeVisible();
      break;
    case "checkout-payment-options":
      await expect(
        page.getByRole("heading", { name: "确认购买" }),
      ).toBeVisible();
      await expect(page.getByText("商品信息")).toBeVisible();
      await expect(page.getByText("基础短袖")).toBeVisible();
      await expect(page.getByText("选择支付方式")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /支付宝扫码/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /支付宝付款码/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "确认并生成支付二维码" }),
      ).toBeVisible();
      break;
    case "payment-qr":
      await expect(page.getByText("请使用微信 / 支付宝扫码支付")).toBeVisible();
      await expect(page.getByText("应付金额")).toBeVisible();
      await expect(page.getByText("¥69.00")).toBeVisible();
      await expectPaymentQrVisual(page);
      break;
    case "payment-code":
      await expect(
        page.getByText("请将付款码靠近扫码窗口完成支付"),
      ).toBeVisible();
      await expect(
        page.getByText("请打开支付宝或微信付款码，靠近设备扫码窗口。"),
      ).toBeVisible();
      await expect(page.getByText("应付金额")).toBeVisible();
      await expect(page.getByText("¥69.00")).toBeVisible();
      await expect(page.locator(".payment-code-panel")).toBeVisible();
      await expect(page.getByText("手动扫码测试")).toHaveCount(0);
      await expect(page.getByText("支付状态已失效")).toHaveCount(0);
      break;
    case "result-payment-failed":
      await expect(
        page.getByRole("heading", { name: "支付失败" }),
      ).toBeVisible();
      await expect(
        page.getByText("本次订单已取消，未完成扣款。"),
      ).toBeVisible();
      await expect(page.getByText("感谢您的使用")).toBeVisible();
      break;
    case "dispensing":
    case "dispensing-pickup-15s":
    case "dispensing-pickup-25s":
      await expectDispensingReminderScreenshot(page, scenario.id);
      break;
    case "result-dispense-failed":
      await expect(
        page.getByRole("heading", { name: "出货失败" }),
      ).toBeVisible();
      await expect(page.getByText("商品未能正常出货")).toBeVisible();
      await expect(page.getByText("订单凭证 UI-DEBUG-ORDER")).toBeVisible();
      break;
    case "result-manual-handling":
      await expect(
        page.getByRole("heading", { name: "等待人工处理" }),
      ).toBeVisible();
      await expect(page.getByText("订单凭证 UI-DEBUG-ORDER")).toBeVisible();
      await expect(
        page.getByText(
          /(?:订单已进入人工处理|出货结果待确认)，请凭订单凭证联系工作人员(?:处理)?。/,
        ),
      ).toBeVisible();
      break;
    case "result-refund-pending":
      await expect(
        page.getByRole("heading", { name: "退款处理中" }),
      ).toBeVisible();
      await expect(page.getByText("订单凭证 UI-DEBUG-ORDER")).toBeVisible();
      await expect(
        page.getByText("出货异常已进入退款流程，请留意原支付渠道通知。"),
      ).toBeVisible();
      break;
    case "result-refunded":
      await expect(page.getByRole("heading", { name: "已退款" })).toBeVisible();
      await expect(page.getByText("订单凭证 UI-DEBUG-ORDER")).toBeVisible();
      await expect(page.getByText("款项已按原支付渠道退回。")).toBeVisible();
      break;
    case "offline":
      await expect(
        page.getByRole("heading", { name: "设备离线" }),
      ).toBeVisible();
      await expect(
        page.getByText("设备需要工作人员检查后才能继续售卖"),
      ).toBeVisible();
      await expect(page.getByText("客服提示：设备维护")).toBeVisible();
      await expect(page.getByText("WHOLE_MACHINE_HARDWARE_FAULT")).toHaveCount(
        0,
      );
      break;
    case "maintenance":
      await expectMaintenanceConsoleScreenshot(page);
      break;
    case "bring-up-console":
      await expectBringUpConsoleScreenshot(page);
      break;
    default:
      throw new Error(
        `No core screenshot assertion defined for scenario ${scenario.id}`,
      );
  }
}

async function expectDispensingReminderScreenshot(
  page: Page,
  scenarioId: keyof typeof dispensingScreenshotExpectations,
): Promise<void> {
  const expectation = dispensingScreenshotExpectations[scenarioId];
  await expect(page.getByRole("heading", { name: "正在出货" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: expectation.pickupTitle }),
  ).toBeVisible();
  await expect(page.getByText("基础短袖")).toBeVisible();
  await expect(page.getByText("订单凭证 UI-DEBUG-ORDER")).toBeVisible();
  await expect(page.locator(".pickup-subtitle")).toHaveText(
    expectation.reminderCopy,
  );
  await expect(page.getByText("剩余取货时间")).toHaveCount(0);
  await expect(page.locator(".pickup-time")).toHaveCount(0);
  await expect(page.getByText(/60 秒|01:00/)).toHaveCount(0);
  await expect(page.locator(".pickup-illustration")).toBeVisible();
  await expect(page.locator(".pickup-notice")).toContainText(
    expectation.noticeTitle,
  );
  await expect(page.getByAltText("让温柔贴近 让善意发生")).toBeVisible();
}

async function expectMaintenanceConsoleScreenshot(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "生产维护" })).toBeVisible();
  await expect(page.getByText("维护控制台")).toBeVisible();
  await expect(page.getByText("本地服务", { exact: true })).toBeVisible();
  await expect(page.getByText("同步", { exact: true })).toBeVisible();
  await expect(page.getByText("下位机", { exact: true })).toBeVisible();
  await expect(page.getByText("扫码器", { exact: true })).toBeVisible();
  await expect(page.getByText("视觉运行状态", { exact: true })).toBeVisible();
  await expect(page.getByText("远程运维", { exact: true })).toBeVisible();

  const currentBlockers = page.getByLabel("当前阻塞项");
  await expect(
    currentBlockers.getByText("整机维护锁", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认解除整机锁" }),
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("填写现场处理、复位和自检结果"),
  ).toBeVisible();

  await expect(page.getByText("销售就绪阻塞项")).toBeVisible();
  await expect(page.getByText("Admin Operations Console")).toHaveCount(0);
}

async function expectBringUpConsoleScreenshot(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "首次部署控制台" }),
  ).toBeVisible();
  await expect(page.getByText("本机状态已由 daemon 确认")).toBeVisible();
  await expect(page.getByText("当前任务：正在确认本机状态")).toBeVisible();
  await expect(page.getByLabel("首次部署进度")).toBeVisible();

  await expect(page.getByText("货道拓扑不匹配")).toHaveCount(0);
  await expect(
    page.getByText("平台货道拓扑与本机下位机返回不一致"),
  ).toHaveCount(0);
  await expect(page.getByText("Bring-Up Console")).toHaveCount(0);
  await expect(page.getByText("Runtime Acceptance")).toHaveCount(0);
  await expect(page.getByText("Protected Maintenance Mode")).toHaveCount(0);
  await expect(page.getByText("PROVISIONING")).toHaveCount(0);
  await expect(page.getByText("Diagnostics")).toHaveCount(0);
}

async function loadMachineRuntimeScreenshotScenario(
  page: Page,
  scenario: MachineRuntimeScenario,
): Promise<void> {
  await seedRuntimeScreenshotMode(page);

  if (scenario.id === "product-list") {
    await loadMachineRuntimeScenario(page, scenario);
    await page.getByRole("button", { name: /T恤/ }).click();
    return;
  }

  if (scenario.id === "checkout-payment-options") {
    await loadMachineRuntimeScenario(page, {
      ...scenario,
      targetRoute: "/catalog",
    });
    await page.getByRole("button", { name: /T恤/ }).click();
    await page.getByRole("button", { name: /基础短袖/ }).click();
    await page.getByRole("button", { name: /立即购买 ¥59.00/ }).click();
    return;
  }

  await loadMachineRuntimeScenario(page, scenario);
}

async function seedRuntimeScreenshotMode(page: Page): Promise<void> {
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "1");
  }, runtimeScreenshotStorageKey);
}

async function expectPaymentQrVisual(page: Page): Promise<void> {
  const qrImage = page.getByRole("img", { name: "支付二维码" });
  await expect(qrImage).toBeVisible();
  await expect(qrImage).toHaveAttribute("src", /^data:image\/png;base64,/);

  const visual = await qrImage.evaluate((element) => {
    if (!(element instanceof HTMLImageElement)) {
      return {
        complete: false,
        naturalWidth: 0,
        naturalHeight: 0,
        darkPixels: 0,
        lightPixels: 0,
      };
    }

    const { complete, naturalWidth, naturalHeight } = element;
    if (!complete || naturalWidth === 0 || naturalHeight === 0) {
      return {
        complete,
        naturalWidth,
        naturalHeight,
        darkPixels: 0,
        lightPixels: 0,
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = naturalWidth;
    canvas.height = naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return {
        complete,
        naturalWidth,
        naturalHeight,
        darkPixels: 0,
        lightPixels: 0,
      };
    }

    context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, naturalWidth, naturalHeight).data;
    let darkPixels = 0;
    let lightPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] ?? 0;
      if (alpha === 0) continue;
      const red = pixels[index] ?? 0;
      const green = pixels[index + 1] ?? 0;
      const blue = pixels[index + 2] ?? 0;
      const brightness = (red + green + blue) / 3;
      if (brightness < 80) {
        darkPixels += 1;
      } else if (brightness > 220) {
        lightPixels += 1;
      }
    }

    return { complete, naturalWidth, naturalHeight, darkPixels, lightPixels };
  });

  expect(visual.complete, "QR image should finish loading").toBe(true);
  expect(visual.naturalWidth, "QR image natural width").toBeGreaterThanOrEqual(
    300,
  );
  expect(
    visual.naturalHeight,
    "QR image natural height",
  ).toBeGreaterThanOrEqual(300);
  expect(
    visual.darkPixels,
    "QR image should contain dark modules",
  ).toBeGreaterThan(500);
  expect(
    visual.lightPixels,
    "QR image should contain a light background",
  ).toBeGreaterThan(500);
}

async function expectPngDimensions(
  path: string,
  expectedWidth: number,
  expectedHeight: number,
): Promise<void> {
  const header = await readFile(path);
  expect(header.subarray(0, 8).toString("hex"), "PNG signature").toBe(
    "89504e470d0a1a0a",
  );
  expect(header.readUInt32BE(16), "PNG width").toBe(expectedWidth);
  expect(header.readUInt32BE(20), "PNG height").toBe(expectedHeight);
}
