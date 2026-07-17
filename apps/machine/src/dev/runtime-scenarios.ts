import type { UiDebugScenarioId } from "./ui-debug-fixtures";

export type MachineRuntimeScenarioCategory =
  | "ready_catalog"
  | "product"
  | "checkout"
  | "payment"
  | "dispensing"
  | "result"
  | "offline"
  | "maintenance";

export type MachineRuntimeScenarioScreenshotStatus = "included" | "deferred";

export type MachineRuntimeScenarioCiTier = "smoke" | "full";

export type MachineRuntimeScenario = {
  id: string;
  name: string;
  category: MachineRuntimeScenarioCategory;
  targetRoute: string;
  fixtureScenarioId: UiDebugScenarioId;
  setup: readonly string[];
  visualChecks: readonly string[];
  touchChecks: readonly string[];
  screenshot: MachineRuntimeScenarioScreenshotStatus;
  ciTier: MachineRuntimeScenarioCiTier;
};

export const machineRuntimeScenarios = [
  {
    id: "ready-catalog",
    name: "可售目录",
    category: "ready_catalog",
    targetRoute: "/catalog",
    fixtureScenarioId: "ready",
    setup: ["启用 UI debug daemon", "装载 ready fixture"],
    visualChecks: ["展示唐诗村品牌", "展示商品类别入口", "展示可售商品列表"],
    touchChecks: ["类别按钮满足触屏尺寸", "点击 T恤 类别进入商品列表"],
    screenshot: "included",
    ciTier: "smoke",
  },
  {
    id: "sold-out-catalog",
    name: "售罄目录",
    category: "ready_catalog",
    targetRoute: "/catalog",
    fixtureScenarioId: "sold_out",
    setup: ["启用 UI debug daemon", "装载售罄 sale view fixture"],
    visualChecks: ["展示商品类别入口", "展示暂时售罄", "展示稍后再来提示"],
    touchChecks: ["售罄类别按钮保持触屏尺寸但不可购买"],
    screenshot: "included",
    ciTier: "smoke",
  },
  {
    id: "product-list",
    name: "商品列表",
    category: "product",
    targetRoute: "/catalog",
    fixtureScenarioId: "ready",
    setup: ["启用 UI debug daemon", "装载 ready fixture", "进入 T恤 商品列表"],
    visualChecks: ["展示商品列表标题", "展示基础短袖商品卡", "展示商品价格"],
    touchChecks: ["商品卡满足触屏尺寸", "点击商品卡可进入详情"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "product-detail",
    name: "商品详情",
    category: "product",
    targetRoute: "/products/product:550e8400-e29b-41d4-a716-446655440303",
    fixtureScenarioId: "ready",
    setup: ["启用 UI debug daemon", "装载 ready fixture", "进入基础短袖详情页"],
    visualChecks: ["展示基础短袖详情", "展示规格选择", "展示立即购买入口"],
    touchChecks: ["规格选择和购买按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "checkout-payment-options",
    name: "支付方式选择",
    category: "checkout",
    targetRoute: "/checkout",
    fixtureScenarioId: "ready",
    setup: [
      "启用 UI debug daemon",
      "装载 ready fixture",
      "选择基础短袖进入确认购买",
    ],
    visualChecks: ["展示商品信息", "展示选择支付方式", "展示可用支付渠道"],
    touchChecks: ["支付方式按钮和确认按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "payment-qr",
    name: "扫码支付",
    category: "payment",
    targetRoute: "/payment",
    fixtureScenarioId: "payment_qr",
    setup: ["装载待支付交易 fixture"],
    visualChecks: ["展示订单凭证", "展示支付二维码区域", "展示支付倒计时"],
    touchChecks: ["取消订单按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "payment-code",
    name: "付款码支付",
    category: "payment",
    targetRoute: "/payment",
    fixtureScenarioId: "payment_code",
    setup: ["装载付款码支付交易 fixture", "装载扫码器在线状态"],
    visualChecks: ["展示扫码器就绪", "提示顾客出示付款码", "展示支付倒计时"],
    touchChecks: ["取消订单按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "result-payment-failed",
    name: "支付失败结果",
    category: "result",
    targetRoute: "/result/payment_failed",
    fixtureScenarioId: "payment_failed",
    setup: ["装载支付取消或失败交易 fixture"],
    visualChecks: [
      "展示支付失败标题",
      "展示订单取消说明",
      "不展示内部支付错误",
    ],
    touchChecks: ["返回首页按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "smoke",
  },
  {
    id: "dispensing",
    name: "正在出货",
    category: "dispensing",
    targetRoute: "/dispensing",
    fixtureScenarioId: "dispensing",
    setup: ["装载支付成功且 nextAction=dispensing 的交易 fixture"],
    visualChecks: [
      "展示正在出货标题",
      "展示出货初始状态",
      "展示取货提示",
      "展示订单上下文",
    ],
    touchChecks: ["维护入口隐藏点击区不影响出货主画面"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "dispensing-pickup-15s",
    name: "出货 15 秒取货提醒",
    category: "dispensing",
    targetRoute: "/dispensing",
    fixtureScenarioId: "dispensing_pickup_15s",
    setup: ["装载支付成功且 pickupReminder=warning 的交易 fixture"],
    visualChecks: [
      "展示正在出货标题",
      "展示 15 秒取货提醒",
      "展示订单上下文",
      "展示状态区域",
    ],
    touchChecks: ["维护入口隐藏点击区不影响出货主画面"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "dispensing-pickup-25s",
    name: "出货 25 秒取货提醒",
    category: "dispensing",
    targetRoute: "/dispensing",
    fixtureScenarioId: "dispensing_pickup_25s",
    setup: ["装载支付成功且 pickupReminder=urgent 的交易 fixture"],
    visualChecks: [
      "展示正在出货标题",
      "展示 25 秒取货提醒",
      "展示订单上下文",
      "展示状态区域",
    ],
    touchChecks: ["维护入口隐藏点击区不影响出货主画面"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "result-dispense-failed",
    name: "出货失败结果",
    category: "result",
    targetRoute: "/result/dispense_failed",
    fixtureScenarioId: "dispense_failed",
    setup: ["装载出货失败交易 fixture", "装载维护拦截 ready fixture"],
    visualChecks: ["展示出货失败标题", "展示订单凭证", "展示维护复核提示"],
    touchChecks: ["返回或处理按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "result-manual-handling",
    name: "结果未知人工处理",
    category: "result",
    targetRoute: "/result/manual_handling",
    fixtureScenarioId: "manual_handling",
    setup: ["装载出货结果未知交易 fixture", "装载维护拦截 ready fixture"],
    visualChecks: [
      "展示等待人工处理标题",
      "展示订单凭证",
      "展示联系工作人员下一步",
    ],
    touchChecks: ["保持结果页，不提供继续购买入口"],
    screenshot: "included",
    ciTier: "smoke",
  },
  {
    id: "result-refund-pending",
    name: "退款处理中",
    category: "result",
    targetRoute: "/result/refund_pending",
    fixtureScenarioId: "refund_pending",
    setup: ["装载退款处理中交易 fixture", "装载维护拦截 ready fixture"],
    visualChecks: ["展示退款处理中标题", "展示订单凭证", "提示留意原支付渠道"],
    touchChecks: ["保持结果页，不提供继续购买入口"],
    screenshot: "included",
    ciTier: "smoke",
  },
  {
    id: "result-refunded",
    name: "退款完成",
    category: "result",
    targetRoute: "/result/refunded",
    fixtureScenarioId: "refunded",
    setup: ["装载退款完成交易 fixture"],
    visualChecks: ["展示已退款标题", "展示订单凭证", "展示可返回首页下一步"],
    touchChecks: ["返回首页按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "smoke",
  },
  {
    id: "offline",
    name: "设备离线",
    category: "offline",
    targetRoute: "/offline",
    fixtureScenarioId: "blocked",
    setup: ["装载不可售 ready fixture", "装载故障 health fixture"],
    visualChecks: ["展示设备离线标题", "展示阻塞原因", "展示客服提示"],
    touchChecks: ["刷新重试按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "full",
  },
  {
    id: "maintenance",
    name: "维护控制台",
    category: "maintenance",
    targetRoute: "/maintenance",
    fixtureScenarioId: "blocked",
    setup: ["装载维护拦截 fixture", "装载诊断状态 fixture"],
    visualChecks: ["展示维护控制台", "展示销售阻塞原因", "展示诊断区域"],
    touchChecks: ["诊断刷新或返回售卖入口按钮满足触屏尺寸"],
    screenshot: "included",
    ciTier: "smoke",
  },
] as const satisfies readonly MachineRuntimeScenario[];

export type MachineRuntimeScenarioId =
  (typeof machineRuntimeScenarios)[number]["id"];

export function getMachineRuntimeScenario(
  id: MachineRuntimeScenarioId,
): MachineRuntimeScenario {
  return machineRuntimeScenarios.find((scenario) => scenario.id === id)!;
}

export const screenshotMachineRuntimeScenarios = machineRuntimeScenarios.filter(
  (scenario) => scenario.screenshot === "included",
);

export const touchscreenMachineRuntimeScenarios =
  machineRuntimeScenarios.filter((scenario) => scenario.ciTier === "smoke");

export function selectScreenshotMachineRuntimeScenarios(
  scenarioList: string | undefined,
): readonly MachineRuntimeScenario[] {
  const requestedIds =
    scenarioList
      ?.split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0) ?? [];
  if (requestedIds.length === 0) {
    return screenshotMachineRuntimeScenarios;
  }

  const scenariosById = new Map<string, MachineRuntimeScenario>(
    screenshotMachineRuntimeScenarios.map((scenario) => [
      scenario.id,
      scenario,
    ]),
  );
  const selected = requestedIds.flatMap((id) => {
    const scenario = scenariosById.get(id);
    return scenario === undefined ? [] : [scenario];
  });
  const unknownIds = requestedIds.filter((id) => !scenariosById.has(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `Unknown Machine Runtime Console screenshot scenario(s): ${unknownIds.join(", ")}`,
    );
  }
  return selected;
}
