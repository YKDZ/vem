import { expect, test, type Page } from "@playwright/test";

import {
  getMachineRuntimeScenario,
  type MachineRuntimeScenario,
} from "../src/dev/runtime-scenarios";
import {
  expectKioskMainFrame,
  expectReasonableTouchTarget,
  tapLocator,
} from "./support/touchscreen";
import {
  loadMachineRuntimeScenario,
  seedUiDebugMode,
} from "./support/ui-debug";

const readyCatalogScenario = getMachineRuntimeScenario("ready-catalog");
const paymentScenario = getMachineRuntimeScenario("payment-qr");
const paymentCodeScenario = getMachineRuntimeScenario("payment-code");
const dispensingScenario = getMachineRuntimeScenario("dispensing");
const dispensingPickup15sScenario = getMachineRuntimeScenario(
  "dispensing-pickup-15s",
);
const dispensingPickup25sScenario = getMachineRuntimeScenario(
  "dispensing-pickup-25s",
);
const failedResultScenario = getMachineRuntimeScenario(
  "result-dispense-failed",
);
const soldOutScenario = getMachineRuntimeScenario("sold-out-catalog");
const paymentFailedScenario = getMachineRuntimeScenario(
  "result-payment-failed",
);
const manualHandlingScenario = getMachineRuntimeScenario(
  "result-manual-handling",
);
const refundPendingScenario = getMachineRuntimeScenario(
  "result-refund-pending",
);
const refundedScenario = getMachineRuntimeScenario("result-refunded");
const offlineScenario = getMachineRuntimeScenario("offline");
const maintenanceScenario = getMachineRuntimeScenario("maintenance");
const UI_DEBUG_ENABLED_STORAGE_KEY = "vem.machine.uiDebug.enabled";
const UI_DEBUG_SCENARIO_STORAGE_KEY = "vem.machine.uiDebug.scenario";
const UI_DEBUG_TEST_SCENARIO_STORAGE_KEY = "vem.machine.uiDebug.testScenario";
const UI_DEBUG_TRANSACTION_STORAGE_KEY = "vem.machine.uiDebug.transaction";
const UI_DEBUG_PAYMENT_RESULT_STORAGE_KEY = "vem.machine.uiDebug.paymentResult";
const UI_DEBUG_DISPENSE_RESULT_STORAGE_KEY =
  "vem.machine.uiDebug.dispenseResult";
const TRY_ON_PREVIEW_DIAGNOSTIC_URL =
  "http://127.0.0.1:7892/try-on/e2e-maintenance.mjpeg";

async function installMockVisionTryOnWebSocket(page: Page): Promise<void> {
  await page.addInitScript((previewUrl) => {
    const NativeWebSocket = window.WebSocket;
    class MockVisionTryOnWebSocket extends EventTarget {
      static readonly CONNECTING = NativeWebSocket.CONNECTING;
      static readonly OPEN = NativeWebSocket.OPEN;
      static readonly CLOSING = NativeWebSocket.CLOSING;
      static readonly CLOSED = NativeWebSocket.CLOSED;
      readonly CONNECTING = NativeWebSocket.CONNECTING;
      readonly OPEN = NativeWebSocket.OPEN;
      readonly CLOSING = NativeWebSocket.CLOSING;
      readonly CLOSED = NativeWebSocket.CLOSED;
      binaryType: BinaryType = "blob";
      bufferedAmount = 0;
      extensions = "";
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      protocol = "";
      readyState = NativeWebSocket.CONNECTING;
      url: string;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = NativeWebSocket.OPEN;
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.(event);
        }, 0);
      }

      close(): void {
        if (this.readyState === NativeWebSocket.CLOSED) return;
        this.readyState = NativeWebSocket.CLOSED;
        const event = new CloseEvent("close", { code: 1000, reason: "mock" });
        this.dispatchEvent(event);
        this.onclose?.(event);
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        const message = JSON.parse(this.messageText(data)) as {
          type?: string;
          payload?: { sessionId?: string };
        };
        if (message.type === "vision.hello") {
          this.emitServerMessage({
            protocol: "vem.vision.v1",
            type: "vision.ready",
            messageId: "ready-e2e",
            timestamp: new Date().toISOString(),
            payload: {
              serverName: "vision-e2e",
              serverVersion: "0.0.0-test",
              service: "vision-e2e",
              cameraReady: true,
              modelReady: true,
              capabilities: ["try_on_session"],
            },
          });
          return;
        }
        if (message.type === "vision.try_on.start") {
          this.emitServerMessage({
            protocol: "vem.vision.v1",
            type: "vision.try_on.started",
            messageId: "try-on-started-e2e",
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: message.payload?.sessionId ?? "try-on-e2e",
              previewUrl,
              streamType: "mjpeg",
            },
          });
        }
      }

      private messageText(
        data: string | ArrayBufferLike | Blob | ArrayBufferView,
      ): string {
        if (typeof data === "string") {
          return data;
        }
        if (data instanceof Blob) {
          throw new Error(
            "mock vision websocket does not accept Blob messages",
          );
        }
        const buffer = ArrayBuffer.isView(data)
          ? data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            )
          : data;
        return new TextDecoder().decode(buffer);
      }

      private emitServerMessage(payload: unknown): void {
        window.setTimeout(() => {
          const event = new MessageEvent("message", {
            data: JSON.stringify(payload),
          });
          this.dispatchEvent(event);
          this.onmessage?.(event);
        }, 0);
      }
    }
    window.WebSocket = MockVisionTryOnWebSocket as typeof WebSocket;
  }, TRY_ON_PREVIEW_DIAGNOSTIC_URL);
}

async function createStoredQrPaymentFromReadyCatalog(
  page: Page,
): Promise<string> {
  await expect(page).toHaveURL(/#\/catalog$/);

  await tapLocator(page, page.getByRole("button", { name: /T恤/ }));
  const productTile = page.getByRole("button", { name: /基础短袖/ }).first();
  await tapLocator(page, productTile);
  await tapLocator(page, page.getByRole("button", { name: /立即购买 ¥59.00/ }));
  await tapLocator(
    page,
    page.getByRole("button", { name: "确认并生成支付二维码" }),
  );

  await expect(page).toHaveURL(/#\/payment$/);
  await expect(page.getByRole("heading", { name: "订单支付" })).toBeVisible();
  const storedTransaction = await page.evaluate((transactionKey) => {
    return window.localStorage.getItem(transactionKey);
  }, UI_DEBUG_TRANSACTION_STORAGE_KEY);
  expect(storedTransaction).not.toBeNull();
  return storedTransaction ?? "";
}

async function installMutableUiDebugScenarioInit(
  page: Page,
  initialScenarioId: string,
): Promise<void> {
  await page.addInitScript(
    ({ enabledKey, scenarioKey, controlKey, initialScenario }) => {
      window.localStorage.setItem(enabledKey, "1");
      window.localStorage.setItem(
        scenarioKey,
        window.localStorage.getItem(controlKey) ?? initialScenario,
      );
    },
    {
      enabledKey: UI_DEBUG_ENABLED_STORAGE_KEY,
      scenarioKey: UI_DEBUG_SCENARIO_STORAGE_KEY,
      controlKey: UI_DEBUG_TEST_SCENARIO_STORAGE_KEY,
      initialScenario: initialScenarioId,
    },
  );
}

async function switchRuntimeScenario(
  page: Page,
  scenario: MachineRuntimeScenario,
  storedTransaction: string,
): Promise<void> {
  await page.evaluate(
    ({
      controlKey,
      transactionKey,
      paymentResultKey,
      dispenseResultKey,
      next,
      transaction,
    }) => {
      window.localStorage.setItem(controlKey, next);
      window.localStorage.setItem(transactionKey, transaction);
      window.localStorage.setItem(paymentResultKey, "success");
      window.localStorage.setItem(dispenseResultKey, "success");
    },
    {
      controlKey: UI_DEBUG_TEST_SCENARIO_STORAGE_KEY,
      transactionKey: UI_DEBUG_TRANSACTION_STORAGE_KEY,
      paymentResultKey: UI_DEBUG_PAYMENT_RESULT_STORAGE_KEY,
      dispenseResultKey: UI_DEBUG_DISPENSE_RESULT_STORAGE_KEY,
      next: scenario.fixtureScenarioId,
      transaction: storedTransaction,
    },
  );
  await page.goto(`/?runtimeScenario=${scenario.id}#${scenario.targetRoute}`);
}

async function expectUiDebugTransactionStorageCleared(
  page: Page,
): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(
        ({ transactionKey, paymentResultKey, dispenseResultKey }) => ({
          transaction: window.localStorage.getItem(transactionKey),
          paymentResult: window.localStorage.getItem(paymentResultKey),
          dispenseResult: window.localStorage.getItem(dispenseResultKey),
        }),
        {
          transactionKey: UI_DEBUG_TRANSACTION_STORAGE_KEY,
          paymentResultKey: UI_DEBUG_PAYMENT_RESULT_STORAGE_KEY,
          dispenseResultKey: UI_DEBUG_DISPENSE_RESULT_STORAGE_KEY,
        },
      ),
    )
    .toEqual({
      transaction: null,
      paymentResult: null,
      dispenseResult: null,
    });
}

async function expectMaintenanceDiagnosticRow(
  page: Page,
  label: string,
  valuePattern: RegExp,
): Promise<void> {
  const row = page.locator("dl > div", {
    has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }),
  });
  await expect(row).toHaveCount(1);
  await expect(row).toBeVisible();
  const value = row.locator("dd").first();
  await expect(value).toBeVisible();
  await expect
    .poll(async () => (await value.innerText()).trim())
    .toMatch(valuePattern);
}

async function expectRuntimeScenarioClearsStoredDebugTransaction(
  page: Page,
  scenario: MachineRuntimeScenario,
  storedTransaction: string,
): Promise<void> {
  await switchRuntimeScenario(page, scenario, storedTransaction);
  const escapedTargetRoute = scenario.targetRoute.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  await expect(page).toHaveURL(new RegExp(`#${escapedTargetRoute}$`));
  await expect(page).not.toHaveURL(/#\/(payment|dispensing)$/);
  await expectUiDebugTransactionStorageCleared(page);
}

test("touchscreen customer can enter the visible catalog list", async ({
  page,
}) => {
  await loadMachineRuntimeScenario(page, readyCatalogScenario);

  await expectKioskMainFrame(page);
  await expect(page.getByRole("img", { name: "唐诗村" })).toBeVisible();
  await expect(page.getByRole("img", { name: "轮播展示" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "请选择商品类别" }),
  ).toBeVisible();

  const tshirtCategory = page.getByRole("button", { name: /T恤/ });
  await tapLocator(page, tshirtCategory);

  await expect(
    page.getByRole("img", { name: "商品列表，请点击选择您需要的商品" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /基础短袖/ })).toBeVisible();
});

test("home carousel auto mode removes buttons and supports swipe navigation", async ({
  page,
}) => {
  await loadMachineRuntimeScenario(page, readyCatalogScenario);

  const carousel = page.getByRole("region", { name: "首页展示轮播" });
  await expect(carousel).toBeVisible();
  await expect(page.getByRole("button", { name: "上一张" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一张" })).toHaveCount(0);

  const image = page.getByRole("img", { name: "轮播展示" });
  const initialSrc = await image.getAttribute("src");
  await carousel.dispatchEvent("pointerdown", { clientX: 500 });
  await carousel.dispatchEvent("pointerup", { clientX: 100 });

  await expect.poll(async () => image.getAttribute("src")).not.toBe(initialSrc);
});

test("touchscreen customer can complete a successful purchase journey", async ({
  page,
}) => {
  await loadMachineRuntimeScenario(page, readyCatalogScenario);

  await expectKioskMainFrame(page);
  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(page.getByRole("img", { name: "唐诗村" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "请选择商品类别" }),
  ).toBeVisible();

  const tshirtCategory = page.getByRole("button", { name: /T恤/ });
  await tapLocator(page, tshirtCategory);

  await expect(
    page.getByRole("img", { name: "商品列表，请点击选择您需要的商品" }),
  ).toBeVisible();
  const productTile = page.getByRole("button", { name: /基础短袖/ }).first();
  await expectReasonableTouchTarget(productTile);
  await expect(productTile).toContainText("¥59.00");
  await tapLocator(page, productTile);

  await expect(page).toHaveURL(/#\/products\/product:/);
  await expect(page.getByRole("heading", { name: "基础短袖" })).toBeVisible();
  await expect(page.locator(".detail-price")).toHaveText("¥59.00");
  await expect(page.getByText("商品库存")).toBeVisible();
  const buyButton = page.getByRole("button", { name: /立即购买 ¥59.00/ });
  await expectReasonableTouchTarget(buyButton);
  await tapLocator(page, buyButton);

  await expect(page).toHaveURL(/#\/checkout$/);
  await expect(page.getByRole("heading", { name: "确认购买" })).toBeVisible();
  await expect(page.getByText("商品信息")).toBeVisible();
  await expect(page.getByText("基础短袖")).toBeVisible();
  await expect(page.getByText("应付金额")).toBeVisible();
  await expect(page.locator(".checkout-amount strong")).toHaveText("¥59.00");
  const qrPaymentOption = page.getByRole("button", { name: /支付宝扫码/ });
  await expectReasonableTouchTarget(qrPaymentOption);
  const submitOrderButton = page.getByRole("button", {
    name: "确认并生成支付二维码",
  });
  await expectReasonableTouchTarget(submitOrderButton);
  await tapLocator(page, submitOrderButton);

  await expect(page).toHaveURL(/#\/payment$/);
  await expect(page.getByRole("heading", { name: "订单支付" })).toBeVisible();
  await expect(page.getByText("应付金额")).toBeVisible();
  await expect(page.locator(".payment-amount")).toHaveText("¥59.00");
  await expect(page.getByText("请使用微信 / 支付宝扫码支付")).toBeVisible();
  await expect(page.locator("canvas, .qr-shell").first()).toBeVisible();
  const cancelOrderButton = page.getByRole("button", { name: "取消订单" });
  await expectReasonableTouchTarget(cancelOrderButton);

  await page.goto("/");
  await expect(page).toHaveURL(/#\/payment$/);
  await expect(page.getByRole("heading", { name: "订单支付" })).toBeVisible();
  await expect(page.locator(".payment-amount")).toHaveText("¥59.00");

  await page.evaluate(() => {
    window.localStorage.setItem("vem.machine.uiDebug.paymentResult", "success");
  });

  await expect(page).toHaveURL(/#\/dispensing$/);
  await expect(page.getByRole("heading", { name: "正在出货" })).toBeVisible();
  await expect(page.getByText("设备出货中")).toBeVisible();
  await expect(page.getByText("请稍候，商品正在送往取货口")).toBeVisible();
  await expect(page.getByText("请取走您的商品")).toHaveCount(0);
  await expect(page.getByText("剩余取货时间")).toHaveCount(0);
  await expect(page.locator(".pickup-time")).toHaveCount(0);
  await expect(page.getByText("出货完成后请取货")).toBeVisible();

  await page.evaluate(() => {
    window.localStorage.setItem(
      "vem.machine.uiDebug.dispenseResult",
      "success",
    );
  });

  await expect(page).toHaveURL(/#\/result\/success$/);
  await expect(page.getByRole("heading", { name: "出货成功" })).toBeVisible();
  await expect(page.getByText("请及时取走商品，欢迎再次使用。")).toBeVisible();
  await expect(page.getByText(/秒后自动返回首页。/)).toBeVisible();
  await expect(page.getByText("感谢您的使用")).toBeVisible();
  const returnHomeButton = page.getByRole("button", { name: "返回首页" });
  await expectReasonableTouchTarget(returnHomeButton);
});

test("transaction-less blocked runtime scenarios clear stored debug transactions", async ({
  page,
}) => {
  await installMutableUiDebugScenarioInit(
    page,
    readyCatalogScenario.fixtureScenarioId,
  );
  await page.goto(
    `/?runtimeScenario=${readyCatalogScenario.id}#${readyCatalogScenario.targetRoute}`,
  );
  const storedTransaction = await createStoredQrPaymentFromReadyCatalog(page);

  await expectRuntimeScenarioClearsStoredDebugTransaction(
    page,
    offlineScenario,
    storedTransaction,
  );
  await expectRuntimeScenarioClearsStoredDebugTransaction(
    page,
    maintenanceScenario,
    storedTransaction,
  );
});

test("runtime matrix can directly load payment state", async ({ page }) => {
  await loadMachineRuntimeScenario(page, paymentScenario);

  await expect(page).toHaveURL(/#\/payment$/);
  await expectKioskMainFrame(page);
  await expect(page.getByText("请使用微信 / 支付宝扫码支付")).toBeVisible();
  await expect(page.getByText("应付金额")).toBeVisible();
  await expect(page.getByText("¥69.00")).toBeVisible();
  await expect(page.getByRole("button", { name: "取消订单" })).toBeVisible();
  await expect(page.getByText("手动扫码测试")).toHaveCount(0);
  await expect(page.getByText("支付状态已失效")).toHaveCount(0);
});

test("runtime matrix can directly load payment code scanner state", async ({
  page,
}) => {
  await loadMachineRuntimeScenario(page, paymentCodeScenario);

  await expect(page).toHaveURL(/#\/payment$/);
  await expectKioskMainFrame(page);
  await expect(page.getByText("请将付款码靠近扫码窗口完成支付")).toBeVisible();
  await expect(page.getByText("请出示付款码")).toBeVisible();
  await expect(
    page.getByText("请打开支付宝或微信付款码，靠近设备扫码窗口。"),
  ).toBeVisible();
  await expect(page.getByText("应付金额")).toBeVisible();
  await expect(page.getByText("¥69.00")).toBeVisible();
  await expect(page.getByRole("button", { name: "取消订单" })).toBeVisible();
  await expect(page.getByText("支付状态已失效")).toHaveCount(0);
});

test("runtime matrix can directly load dispensing state", async ({ page }) => {
  await loadMachineRuntimeScenario(page, dispensingScenario);

  await expect(page).toHaveURL(/#\/dispensing$/);
  await expectKioskMainFrame(page);
  await expect(page.getByRole("heading", { name: "正在出货" })).toBeVisible();
  await expect(page.getByText("设备出货中")).toBeVisible();
  await expect(page.getByText("请稍候，商品正在送往取货口")).toBeVisible();
  await expect(page.getByText("请取走您的商品")).toHaveCount(0);
  await expect(page.getByText("剩余取货时间")).toHaveCount(0);
  await expect(page.locator(".pickup-time")).toHaveCount(0);
  await expect(page.getByText("取货状态已失效")).toHaveCount(0);
});

const dispensingStateExpectations: readonly {
  scenario: MachineRuntimeScenario;
  pickupTitle: string;
  reminderCopy: string;
  noticeTitle: string;
  noticeCopy: string;
}[] = [
  {
    scenario: dispensingScenario,
    pickupTitle: "设备出货中",
    reminderCopy: "请稍候，商品正在送往取货口",
    noticeTitle: "出货完成后请取货",
    noticeCopy: "取货口打开后，请及时取走商品。",
  },
  {
    scenario: dispensingPickup15sScenario,
    pickupTitle: "请及时取走商品",
    reminderCopy: "取货倒计时进行中，请尽快取走商品",
    noticeTitle: "请尽快完成取货",
    noticeCopy: "商品已在取货口等待，请及时取走。",
  },
  {
    scenario: dispensingPickup25sScenario,
    pickupTitle: "请立即取走商品",
    reminderCopy: "取货倒计时进行中，请尽快取走商品",
    noticeTitle: "取货口即将关闭",
    noticeCopy: "请立即取走商品，避免取货口超时关闭。",
  },
];

for (const expectation of dispensingStateExpectations) {
  test(`runtime matrix renders ${expectation.scenario.name} dispensing reminder state`, async ({
    page,
  }) => {
    await loadMachineRuntimeScenario(page, expectation.scenario);

    await expect(page).toHaveURL(/#\/dispensing$/);
    await expectKioskMainFrame(page);
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
    await expect(page.locator(".pickup-illustration")).toBeVisible();
    await expect(page.locator(".pickup-notice")).toContainText(
      expectation.noticeTitle,
    );
    await expect(page.locator(".pickup-notice")).toContainText(
      expectation.noticeCopy,
    );
    await expect(page.getByText("取货状态已失效")).toHaveCount(0);
  });
}

test("runtime matrix can directly load failure result state", async ({
  page,
}) => {
  await loadMachineRuntimeScenario(page, failedResultScenario);

  await expect(page).toHaveURL(/#\/result\/dispense_failed$/);
  await expectKioskMainFrame(page);
  await expect(page.getByRole("heading", { name: "出货失败" })).toBeVisible();
  await expect(page.getByText("商品未能正常出货")).toBeVisible();
  await expect(page.getByText("订单凭证 UI-DEBUG-ORDER")).toBeVisible();
  await expect(page.getByText("设备需要维护检查")).toBeVisible();
});

test("runtime matrix covers customer-visible sold out catalog state", async ({
  page,
}) => {
  await loadMachineRuntimeScenario(page, soldOutScenario);

  await expect(page).toHaveURL(/#\/catalog$/);
  await expectKioskMainFrame(page);
  await expect(
    page.getByRole("heading", { name: "请选择商品类别" }),
  ).toBeVisible();
  await expect(page.getByText("暂时售罄")).toHaveCount(3);
  await expect(
    page.getByText("暂无可售商品，请稍后再来或联系工作人员。"),
  ).toBeVisible();
  const tshirtCategory = page.getByRole("button", { name: /T恤/ });
  await expectReasonableTouchTarget(tshirtCategory);
  await expect(tshirtCategory).toBeDisabled();
  await tapLocator(page, tshirtCategory);
  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(
    page.getByRole("img", { name: "商品列表，请点击选择您需要的商品" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/MQTT|sync|debug trace|UI-DEBUG-CMD/i),
  ).toHaveCount(0);
});

const terminalResultExpectations: readonly {
  scenario: MachineRuntimeScenario;
  route: RegExp;
  heading: string;
  visible: readonly string[];
  hidden: RegExp;
  returnHome: boolean;
}[] = [
  {
    scenario: paymentFailedScenario,
    route: /#\/result\/payment_failed$/,
    heading: "支付失败",
    visible: ["本次订单已取消，未完成扣款。", "感谢您的使用"],
    hidden: /订单凭证|MQTT|sync|debug trace|UI-DEBUG-CMD/i,
    returnHome: true,
  },
  {
    scenario: manualHandlingScenario,
    route: /#\/result\/manual_handling$/,
    heading: "等待人工处理",
    visible: [
      "支付成功但出货状态异常，请联系现场运维或客服。",
      "订单凭证 UI-DEBUG-ORDER",
    ],
    hidden: /MQTT|sync|debug trace|UI-DEBUG-CMD|result_unknown/i,
    returnHome: false,
  },
  {
    scenario: refundPendingScenario,
    route: /#\/result\/refund_pending$/,
    heading: "退款处理中",
    visible: [
      "出货异常已进入退款流程，请留意原支付渠道通知。",
      "订单凭证 UI-DEBUG-ORDER",
    ],
    hidden: /MQTT|sync|debug trace|UI-DEBUG-CMD|refund requested/i,
    returnHome: false,
  },
  {
    scenario: refundedScenario,
    route: /#\/result\/refunded$/,
    heading: "已退款",
    visible: [
      "款项已按原支付渠道退回。",
      "订单凭证 UI-DEBUG-ORDER",
      "感谢您的使用",
    ],
    hidden: /MQTT|sync|debug trace|UI-DEBUG-CMD/i,
    returnHome: true,
  },
];

for (const expectation of terminalResultExpectations) {
  test(`runtime matrix covers customer-visible ${expectation.scenario.name}`, async ({
    page,
  }) => {
    await loadMachineRuntimeScenario(page, expectation.scenario);

    await expect(page).toHaveURL(expectation.route);
    await expectKioskMainFrame(page);
    await expect(
      page.getByRole("heading", { name: expectation.heading }),
    ).toBeVisible();
    await Promise.all(
      expectation.visible.map(async (text) => {
        await expect(page.getByText(text)).toBeVisible();
      }),
    );
    if (expectation.scenario.id === "result-manual-handling") {
      await expect(
        page.getByText(
          /(?:订单已进入人工处理|出货结果待确认)，请凭订单凭证联系工作人员(?:处理)?。/,
        ),
      ).toBeVisible();
    }
    await expect(page.getByText(expectation.hidden)).toHaveCount(0);

    const returnHomeButton = page.getByRole("button", { name: "返回首页" });
    if (expectation.returnHome) {
      await expectReasonableTouchTarget(returnHomeButton);
    } else {
      await expect(returnHomeButton).toHaveCount(0);
    }
  });
}

test("runtime startup restores customer-visible transaction recovery result", async ({
  page,
}) => {
  await seedUiDebugMode(page, {
    scenario: refundPendingScenario.fixtureScenarioId,
  });
  await page.goto("/");

  await expect(page).toHaveURL(/#\/result\/refund_pending$/);
  await expectKioskMainFrame(page);
  await expect(page.getByRole("heading", { name: "退款处理中" })).toBeVisible();
  await expect(page.getByText("订单凭证 UI-DEBUG-ORDER")).toBeVisible();
  await expect(
    page.getByText(/MQTT|sync|debug trace|UI-DEBUG-CMD/i),
  ).toHaveCount(0);
});

test("runtime matrix can directly load offline state", async ({ page }) => {
  await loadMachineRuntimeScenario(page, offlineScenario);

  await expect(page).toHaveURL(/#\/offline$/);
  await expectKioskMainFrame(page);
  await expect(page.getByRole("heading", { name: "设备离线" })).toBeVisible();
  await expect(
    page.getByText("设备需要工作人员检查后才能继续售卖"),
  ).toBeVisible();
  await expect(page.getByText("客服提示：设备维护")).toBeVisible();
  await expect(page.getByText("WHOLE_MACHINE_LOCKED")).toHaveCount(0);
});

test("runtime matrix can directly load maintenance state", async ({ page }) => {
  await loadMachineRuntimeScenario(page, maintenanceScenario);

  await expect(page).toHaveURL(/#\/maintenance\?source=operator$/);
  await expectKioskMainFrame(page);
  await expect(page.getByRole("heading", { name: "运行状态" })).toBeVisible();

  await expectMaintenanceDiagnosticRow(
    page,
    "本地服务",
    /^(正常|就绪|健康|降级|离线|维护|启动中|未知)$/,
  );
  await expectMaintenanceDiagnosticRow(
    page,
    "后端",
    /^(在线|不可用)\s+·\s+(正常|就绪|健康|降级|离线|维护|启动中|未知)$/,
  );
  await expectMaintenanceDiagnosticRow(
    page,
    "销售启动能力",
    /^(可开始销售|不可开始)$/,
  );
  await expectMaintenanceDiagnosticRow(
    page,
    "平台同步",
    /^(已连接|连接中|未连接|未知)\s+·\s+待发队列\s+\d+$/,
  );
  await expectMaintenanceDiagnosticRow(page, "下位机", /^(在线|不可用)$/);
  await expectMaintenanceDiagnosticRow(page, "扫码器", /^(在线|不可用)$/);
  await expectMaintenanceDiagnosticRow(page, "视觉运行状态", /^(在线|不可用)$/);

  await expect(page.getByText("整机维护锁", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "当前阻塞项" })).toHaveCount(0);
  await tapLocator(page, page.getByRole("button", { name: /设备检查/ }));
  await expect(page.getByRole("button", { name: "重新检查" })).toBeVisible();
  await tapLocator(page, page.getByRole("button", { name: /诊断工具/ }));
  await expect(page.getByRole("button", { name: "刷新状态" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出日志" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "返回商品目录" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "回到 Windows 桌面" }),
  ).toHaveCount(0);
  await expect(page.getByText("Admin Operations Console")).toHaveCount(0);
});

test("maintenance can start and release the vision try-on preview diagnostic", async ({
  page,
}) => {
  await installMockVisionTryOnWebSocket(page);
  await loadMachineRuntimeScenario(page, maintenanceScenario);

  await expect(page).toHaveURL(/#\/maintenance\?source=operator$/);
  await tapLocator(page, page.getByRole("button", { name: /声音与视觉/ }));
  await expect(page.getByText("视觉试衣预览诊断")).toBeVisible();

  await tapLocator(page, page.getByRole("button", { name: "启动试衣预览" }));

  const preview = page.locator("[data-test='try-on-camera-preview']");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("src", TRY_ON_PREVIEW_DIAGNOSTIC_URL);
  await expect(page.getByText("mjpeg", { exact: true })).toBeVisible();
  await expect(page.getByText(TRY_ON_PREVIEW_DIAGNOSTIC_URL)).toBeVisible();

  await tapLocator(page, page.getByRole("button", { name: "释放试衣预览" }));
  await expect(preview).toHaveCount(0);
  await expect(page.getByText("试衣预览诊断已释放。")).toBeVisible();
});

test("maintenance route recovers to catalog when the machine can sell", async ({
  page,
}) => {
  await seedUiDebugMode(page, {
    scenario: readyCatalogScenario.fixtureScenarioId,
  });
  await page.goto("/#/maintenance");

  await expect(page).toHaveURL(/#\/catalog$/);
  await expectKioskMainFrame(page);
  await expect(
    page.getByRole("heading", { name: "请选择商品类别" }),
  ).toBeVisible();
});

test("operator-entered maintenance can return to the catalog route", async ({
  page,
}) => {
  await seedUiDebugMode(page, {
    scenario: readyCatalogScenario.fixtureScenarioId,
  });
  await page.goto("/#/maintenance?source=operator");

  await expect(page).toHaveURL(/#\/maintenance\?source=operator$/);
  await expect(page.getByRole("heading", { name: "运行状态" })).toBeVisible();
  const returnToCatalogButton = page.getByRole("button", {
    name: "返回商品目录",
  });
  await expectReasonableTouchTarget(returnToCatalogButton);
  await tapLocator(page, returnToCatalogButton);

  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(
    page.getByRole("heading", { name: "请选择商品类别" }),
  ).toBeVisible();
});

test("customer catalog touch flow does not expose protected maintenance actions", async ({
  page,
}) => {
  await loadMachineRuntimeScenario(page, readyCatalogScenario);

  await expect(page).toHaveURL(/#\/catalog$/);
  await tapLocator(page, page.getByRole("img", { name: "唐诗村" }));

  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(page.getByRole("heading", { name: "运行状态" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "回到 Windows 桌面" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存并重启" })).toHaveCount(0);
});
