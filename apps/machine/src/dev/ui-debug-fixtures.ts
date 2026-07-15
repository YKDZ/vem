import type { MachinePaymentOptionsResponse } from "@/types/checkout";

import {
  machinePaymentOptionsResponseSchema,
  machineSaleViewSnapshotSchema,
  type ConfigSummary,
  type HealthSnapshot,
  type MachineSaleReadiness,
  type ReadySnapshot,
  type RemoteOpsStatus,
  type SaleViewSnapshot,
  type ScannerStatus,
  type SyncStatus,
  type TransactionSnapshot,
  type VisionStatus,
} from "@/daemon/schemas";

export const UI_DEBUG_ENABLED_STORAGE_KEY = "vem.machine.uiDebug.enabled";
export const UI_DEBUG_SCENARIO_STORAGE_KEY = "vem.machine.uiDebug.scenario";
const UI_DEBUG_SALE_VIEW_OVERRIDE_PREFIX =
  "vem.machine.uiDebug.saleViewOverride.";

export type UiDebugScenarioId =
  | "ready"
  | "sold_out"
  | "blocked"
  | "payment_qr"
  | "payment_code"
  | "payment_failed"
  | "dispensing"
  | "dispensing_pickup_15s"
  | "dispensing_pickup_25s"
  | "dispense_failed"
  | "manual_handling"
  | "refund_pending"
  | "refunded"
  | "success";

export type UiDebugScenario = {
  id: UiDebugScenarioId;
  name: string;
  description: string;
  health: HealthSnapshot;
  ready: ReadySnapshot;
  config: ConfigSummary;
  saleReadiness: MachineSaleReadiness;
  saleView: SaleViewSnapshot;
  paymentOptions: MachinePaymentOptionsResponse;
  transaction: TransactionSnapshot;
  sync: SyncStatus;
  scanner: ScannerStatus;
  vision: VisionStatus;
  remoteOps: RemoteOpsStatus;
};

const UPDATED_AT = "2026-06-14T08:00:00.000Z";
const EXPIRES_AT = new Date(Date.now() + 5 * 60_000).toISOString();

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function component(componentName: string, ready: boolean, message: string) {
  return {
    component: componentName,
    level: ready ? "ok" : "error",
    code: ready
      ? `${componentName.toUpperCase()}_READY`
      : `${componentName.toUpperCase()}_BLOCKED`,
    message,
    updatedAt: UPDATED_AT,
  };
}

const config: ConfigSummary = {
  public: {
    machineCode: "UI-DEBUG-001",
    apiBaseUrl: "http://ui-debug.local/api",
    mqttUrl: "mqtt://ui-debug.local:1883",
    mqttUsername: null,
    hardwareAdapter: "mock",
    serialPortPath: null,
    lowerControllerUsbIdentity: null,
    scannerAdapter: "disabled",
    scannerSerialPortPath: null,
    scannerUsbIdentity: null,
    scannerBaudRate: 9600,
    scannerFrameSuffix: "crlf",
    visionEnabled: true,
    visionWsUrl: "ws://ui-debug.local/vision",
    visionRequestTimeoutMs: 8000,
    machineAudioVolume: 0.7,
    machineAudioOutputBinding: null,
    audioCueSettings: {
      enabled: true,
      categories: {
        presence: true,
        transaction: true,
      },
    },
    kioskMode: false,
    stockMovementRetentionDays: 30,
  },
  machineSecretConfigured: true,
  mqttSigningSecretConfigured: true,
  mqttPasswordConfigured: false,
  maintenancePinConfigured: false,
  provisioned: true,
  provisioningIssues: [],
};

const readyHealth: HealthSnapshot = {
  status: "healthy",
  process: component("process", true, "UI debug daemon ready"),
  components: [
    component("backend", true, "mock backend reachable"),
    component("mqtt", true, "mock MQTT connected"),
    component("hardware", true, "mock hardware ready"),
  ],
  configConfigured: true,
  databaseOnline: true,
  backendOnline: true,
  mqttConnected: true,
  outboxSize: 0,
  outboxMax: 1000,
  hardwareOnline: true,
  scannerOnline: true,
  visionOnline: true,
  remoteOpsActive: false,
  currentTransaction: null,
  operatorReason: "UI debug mock hardware ready",
  updatedAt: UPDATED_AT,
};

const blockedHealth: HealthSnapshot = {
  ...readyHealth,
  status: "maintenance",
  hardwareOnline: false,
  currentTransaction: null,
  operatorReason: "模拟下位机维护锁定",
  components: [
    component("backend", true, "mock backend reachable"),
    component("mqtt", false, "MQTT disconnected by scenario"),
    component("hardware", false, "lower controller fault"),
  ],
};

const readySnapshot: ReadySnapshot = {
  ready: true,
  canSell: true,
  mode: "catalog",
  blockingCodes: [],
  blockingReasons: [],
  degradedReasons: [],
  suggestedRoute: "catalog",
  updatedAt: UPDATED_AT,
};

const blockedReady: ReadySnapshot = {
  ready: false,
  canSell: false,
  mode: "maintenance",
  blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
  blockingReasons: [
    {
      code: "WHOLE_MACHINE_HARDWARE_FAULT",
      component: "hardware",
      message: "模拟下位机故障，售卖入口被屏蔽",
    },
  ],
  degradedReasons: [],
  suggestedRoute: "maintenance",
  updatedAt: UPDATED_AT,
};

function saleReadiness(ready: boolean): MachineSaleReadiness {
  return {
    canStartNetworkAuthorizedSale: ready,
    blockingCodes: ready ? [] : ["WHOLE_MACHINE_HARDWARE_FAULT"],
    components: {
      platformReachability: {
        ready: true,
        code: "PLATFORM_REACHABLE",
        message: "mock backend reachable",
      },
      machineAuthentication: {
        ready: true,
        code: "MACHINE_AUTH_READY",
        message: "machine code configured",
      },
      activePlanogram: {
        ready: true,
        code: "ACTIVE_PLANOGRAM_READY",
        message: "UI-DEBUG-PLAN",
      },
      paymentOptions: {
        ready: true,
        code: "PAYMENT_OPTIONS_READY",
        message: "mock payment options available",
        methods: [
          {
            method: "mock",
            optionKey: "mock:mock",
            providerCode: "mock",
            ready: true,
            disabledReason: null,
          },
          {
            method: "qr_code",
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            ready: true,
            disabledReason: null,
          },
          {
            method: "payment_code",
            optionKey: "payment_code:alipay",
            providerCode: "alipay",
            ready,
            disabledReason: ready ? null : "scanner blocked by scenario",
          },
        ],
      },
      scannerCapability: {
        ready,
        code: ready ? "SCANNER_READY" : "SCANNER_BLOCKED",
        message: ready ? "mock scanner ready" : "mock scanner blocked",
      },
      syncHealth: {
        ready,
        code: ready ? "SYNC_READY" : "SYNC_BLOCKED",
        message: ready ? "mock sync connected" : "mock sync disconnected",
      },
      wholeMachineBlockers: {
        ready,
        code: ready ? "WHOLE_MACHINE_READY" : "WHOLE_MACHINE_HARDWARE_FAULT",
        message: ready ? "mock machine ready" : "mock hardware fault",
      },
      slotSaleSafety: {
        ready,
        code: ready ? "SLOTS_READY" : "SLOTS_BLOCKED",
        message: ready ? "all slots saleable" : "slot state blocked",
        blockedSlots: ready
          ? []
          : [
              {
                slotId: "550e8400-e29b-41d4-a716-446655440001",
                slotCode: "A1",
                slotSalesState: "frozen",
              },
            ],
      },
    },
  };
}

const baseSaleView = machineSaleViewSnapshotSchema.parse({
  items: [
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440101",
      variantId: "550e8400-e29b-41d4-a716-446655440201",
      productId: "550e8400-e29b-41d4-a716-446655440301",
      productName: "商务中筒袜",
      productDescription: "袜子类目，适合通勤搭配的中筒袜。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "袜子 / 商务中筒袜",
      sku: "SOCK-BIZ-M-BLACK",
      size: "M",
      color: "黑色",
      priceCents: 1900,
      capacity: 12,
      parLevel: 8,
      physicalStock: 8,
      saleableStock: 8,
      slotSalesState: "sale_ready",
      productSortOrder: 1,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440002",
      slotCode: "A2",
      layerNo: 1,
      cellNo: 2,
      inventoryId: "550e8400-e29b-41d4-a716-446655440102",
      variantId: "550e8400-e29b-41d4-a716-446655440202",
      productId: "550e8400-e29b-41d4-a716-446655440301",
      productName: "商务中筒袜",
      productDescription: "袜子类目，适合通勤搭配的中筒袜。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "袜子 / 商务中筒袜",
      sku: "SOCK-BIZ-L-NAVY",
      size: "L",
      color: "藏青色",
      priceCents: 1900,
      capacity: 12,
      parLevel: 8,
      physicalStock: 6,
      saleableStock: 6,
      slotSalesState: "sale_ready",
      productSortOrder: 1,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440003",
      slotCode: "B1",
      layerNo: 2,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440103",
      variantId: "550e8400-e29b-41d4-a716-446655440203",
      productId: "550e8400-e29b-41d4-a716-446655440302",
      productName: "男士平角裤",
      productDescription: "内裤类目，日常穿着的弹力平角裤。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "内裤 / 男士平角裤",
      sku: "UNDERWEAR-BOXER-M-BLACK",
      size: "M",
      color: "黑色",
      priceCents: 3900,
      capacity: 10,
      parLevel: 6,
      physicalStock: 5,
      saleableStock: 5,
      slotSalesState: "sale_ready",
      productSortOrder: 2,
      targetGender: "male",
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440004",
      slotCode: "B2",
      layerNo: 2,
      cellNo: 2,
      inventoryId: "550e8400-e29b-41d4-a716-446655440104",
      variantId: "550e8400-e29b-41d4-a716-446655440204",
      productId: "550e8400-e29b-41d4-a716-446655440303",
      productName: "基础短袖",
      productDescription: "T恤类目，基础版型短袖上衣。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "T恤 / 基础短袖",
      sku: "TEE-BASIC-M-WHITE",
      size: "M",
      color: "白色",
      priceCents: 5900,
      capacity: 10,
      parLevel: 6,
      physicalStock: 4,
      saleableStock: 4,
      slotSalesState: "sale_ready",
      productSortOrder: 3,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440005",
      slotCode: "C1",
      layerNo: 3,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440105",
      variantId: "550e8400-e29b-41d4-a716-446655440205",
      productId: "550e8400-e29b-41d4-a716-446655440304",
      productName: "运动船袜",
      productDescription: "袜子类目，低帮运动船袜。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "袜子 / 运动船袜",
      sku: "SOCK-SPORT-M-WHITE",
      size: "M",
      color: "白色",
      priceCents: 1600,
      capacity: 12,
      parLevel: 8,
      physicalStock: 7,
      saleableStock: 7,
      slotSalesState: "sale_ready",
      productSortOrder: 4,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440006",
      slotCode: "C2",
      layerNo: 3,
      cellNo: 2,
      inventoryId: "550e8400-e29b-41d4-a716-446655440106",
      variantId: "550e8400-e29b-41d4-a716-446655440206",
      productId: "550e8400-e29b-41d4-a716-446655440304",
      productName: "运动船袜",
      productDescription: "袜子类目，低帮运动船袜。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "袜子 / 运动船袜",
      sku: "SOCK-SPORT-L-GRAY",
      size: "L",
      color: "浅灰色",
      priceCents: 1600,
      capacity: 12,
      parLevel: 8,
      physicalStock: 6,
      saleableStock: 6,
      slotSalesState: "sale_ready",
      productSortOrder: 4,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440007",
      slotCode: "D1",
      layerNo: 4,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440107",
      variantId: "550e8400-e29b-41d4-a716-446655440207",
      productId: "550e8400-e29b-41d4-a716-446655440302",
      productName: "男士平角裤",
      productDescription: "内裤类目，日常穿着的弹力平角裤。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "内裤 / 男士平角裤",
      sku: "UNDERWEAR-BOXER-L-BLUE",
      size: "L",
      color: "雾蓝色",
      priceCents: 3900,
      capacity: 10,
      parLevel: 6,
      physicalStock: 5,
      saleableStock: 5,
      slotSalesState: "sale_ready",
      productSortOrder: 2,
      targetGender: "male",
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440008",
      slotCode: "D2",
      layerNo: 4,
      cellNo: 2,
      inventoryId: "550e8400-e29b-41d4-a716-446655440108",
      variantId: "550e8400-e29b-41d4-a716-446655440208",
      productId: "550e8400-e29b-41d4-a716-446655440305",
      productName: "女士无痕内裤",
      productDescription: "内裤类目，贴身无痕版型。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "内裤 / 女士无痕内裤",
      sku: "UNDERWEAR-SEAMLESS-M-SKIN",
      size: "M",
      color: "肤色",
      priceCents: 3600,
      capacity: 10,
      parLevel: 6,
      physicalStock: 4,
      saleableStock: 4,
      slotSalesState: "sale_ready",
      productSortOrder: 5,
      targetGender: "female",
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440009",
      slotCode: "E1",
      layerNo: 5,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440109",
      variantId: "550e8400-e29b-41d4-a716-446655440209",
      productId: "550e8400-e29b-41d4-a716-446655440303",
      productName: "基础短袖",
      productDescription: "T恤类目，基础版型短袖上衣。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "T恤 / 基础短袖",
      sku: "TEE-BASIC-L-BLACK",
      size: "L",
      color: "黑色",
      priceCents: 5900,
      capacity: 10,
      parLevel: 6,
      physicalStock: 3,
      saleableStock: 3,
      slotSalesState: "sale_ready",
      productSortOrder: 3,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440010",
      slotCode: "E2",
      layerNo: 5,
      cellNo: 2,
      inventoryId: "550e8400-e29b-41d4-a716-446655440110",
      variantId: "550e8400-e29b-41d4-a716-446655440210",
      productId: "550e8400-e29b-41d4-a716-446655440306",
      productName: "运动背心",
      productDescription: "T恤类目，适合轻运动的无袖背心。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "T恤 / 运动背心",
      sku: "TEE-TANK-M-GRAY",
      size: "M",
      color: "石墨灰",
      priceCents: 4900,
      capacity: 10,
      parLevel: 6,
      physicalStock: 5,
      saleableStock: 5,
      slotSalesState: "sale_ready",
      productSortOrder: 6,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440011",
      slotCode: "F1",
      layerNo: 6,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440111",
      variantId: "550e8400-e29b-41d4-a716-446655440211",
      productId: "550e8400-e29b-41d4-a716-446655440305",
      productName: "女士无痕内裤",
      productDescription: "内裤类目，贴身无痕版型。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "内裤 / 女士无痕内裤",
      sku: "UNDERWEAR-SEAMLESS-L-BLACK",
      size: "L",
      color: "黑色",
      priceCents: 3600,
      capacity: 10,
      parLevel: 6,
      physicalStock: 0,
      saleableStock: 0,
      slotSalesState: "frozen",
      productSortOrder: 8,
      targetGender: "female",
    },
  ],
  source: "ui_debug",
  planogramVersion: "UI-DEBUG-PLAN",
  lastUpdatedAt: UPDATED_AT,
});

const soldOutSaleView = machineSaleViewSnapshotSchema.parse({
  ...baseSaleView,
  items: baseSaleView.items.map((item) => ({
    ...item,
    physicalStock: 0,
    saleableStock: 0,
    slotSalesState: "frozen",
  })),
});

const paymentOptions = machinePaymentOptionsResponseSchema.parse({
  options: [
    {
      optionKey: "qr_code:alipay",
      providerCode: "alipay",
      method: "qr_code",
      displayName: "支付宝扫码",
      description: "展示二维码支付界面",
      icon: "alipay",
      recommended: true,
      disabled: false,
      disabledReason: null,
    },
    {
      optionKey: "payment_code:alipay",
      providerCode: "alipay",
      method: "payment_code",
      displayName: "支付宝付款码",
      description: "展示付款码扫码界面",
      icon: "alipay",
      recommended: false,
      disabled: false,
      disabledReason: null,
    },
  ],
  defaultOptionKey: "qr_code:alipay",
  defaultProviderCode: "alipay",
  serverTime: UPDATED_AT,
});

const emptyTransaction: TransactionSnapshot = {
  orderId: null,
  orderNo: null,
  productSummary: null,
  paymentId: null,
  paymentNo: null,
  paymentMethod: null,
  paymentProvider: null,
  paymentUrl: null,
  paymentStatus: null,
  orderStatus: null,
  totalAmountCents: null,
  vending: null,
  nextAction: null,
  maskedAuthCode: null,
  paymentCodeAttempt: null,
  expiresAt: null,
  errorCode: null,
  errorMessage: null,
  operatorHint: null,
  updatedAt: UPDATED_AT,
};

function transaction(
  overrides: Partial<TransactionSnapshot>,
): TransactionSnapshot {
  return {
    ...emptyTransaction,
    orderId: "550e8400-e29b-41d4-a716-446655440901",
    orderNo: "UI-DEBUG-ORDER",
    productSummary: { name: "基础短袖", sku: "TEE-BASIC-L-BLACK" },
    paymentId: null,
    paymentNo: "UI-DEBUG-PAY",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example.test/ui-debug",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 6900,
    expiresAt: EXPIRES_AT,
    nextAction: "wait_payment",
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

const sync: SyncStatus = {
  mqttRunning: true,
  mqttConnected: true,
  brokerUrlMasked: "mqtt://ui-debug.local:1883",
  lastHeartbeatAt: UPDATED_AT,
  lastCommandNo: "UI-DEBUG-CMD",
  outboxSize: 0,
  outboxMax: 1000,
  outboxUsage: 0,
  nextRetryAt: null,
  lastError: null,
  tlsAuthStatus: "mock",
};

const scanner: ScannerStatus = {
  online: true,
  adapter: "ui_debug",
  port: "mock-scanner",
  level: "ok",
  code: "SCANNER_READY",
  message: "mock scanner ready",
  updatedAt: UPDATED_AT,
};

const vision: VisionStatus = {
  enabled: true,
  online: true,
  message: "UI debug vision profile ready",
  updatedAt: UPDATED_AT,
  latestDiagnosticPayload: {
    type: "vision.profile_result",
    payload: {
      eventId: "UI-DEBUG-VISION-001",
      detectedAt: UPDATED_AT,
      profile: {
        personPresent: true,
        heightCm: 172,
      },
      quality: {
        overall: "good",
        warnings: [],
      },
    },
  },
};

const remoteOps: RemoteOpsStatus = {
  lastPolledAt: UPDATED_AT,
  pending: 0,
  lastError: null,
  processing: null,
};

export const uiDebugScenarios: readonly UiDebugScenario[] = [
  {
    id: "ready",
    name: "可售目录",
    description: "健康机器、可售目录、多尺码样式商品。",
    health: readyHealth,
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: emptyTransaction,
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "blocked",
    name: "维护拦截",
    description: "模拟下位机故障，验证不可售卖和维护入口。",
    health: blockedHealth,
    ready: blockedReady,
    config,
    saleReadiness: saleReadiness(false),
    saleView: baseSaleView,
    paymentOptions,
    transaction: emptyTransaction,
    sync: { ...sync, mqttConnected: false, lastError: "mock MQTT offline" },
    scanner: { ...scanner, online: false, level: "error" },
    vision,
    remoteOps,
  },
  {
    id: "sold_out",
    name: "售罄目录",
    description: "健康机器但全部商品暂时售罄，验证顾客可见下一步。",
    health: readyHealth,
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: soldOutSaleView,
    paymentOptions,
    transaction: emptyTransaction,
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "payment_qr",
    name: "等待扫码支付",
    description: "进入支付页，展示二维码和倒计时。",
    health: {
      ...readyHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "pending_payment",
        nextAction: "wait_payment",
        updatedAt: UPDATED_AT,
      },
    },
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({}),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "payment_code",
    name: "等待付款码",
    description: "进入支付页，展示设备扫码器扫用户手机付款码。",
    health: {
      ...readyHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "pending_payment",
        nextAction: "wait_payment",
        updatedAt: UPDATED_AT,
      },
    },
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentMethod: "payment_code",
      paymentProvider: "alipay",
      paymentUrl: null,
      paymentStatus: "processing",
      operatorHint: "请出示付款码",
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "payment_failed",
    name: "支付失败",
    description: "支付未完成或顾客取消后进入终态结果页。",
    health: {
      ...readyHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "canceled",
        nextAction: "payment_failed",
        updatedAt: UPDATED_AT,
      },
    },
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "canceled",
      orderStatus: "canceled",
      nextAction: "payment_failed",
      paymentUrl: null,
      expiresAt: null,
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "dispensing",
    name: "正在出货",
    description: "支付成功后进入出货进度页，尚未触发取货提醒。",
    health: readyHealth,
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "succeeded",
      orderStatus: "dispensing",
      nextAction: "dispensing",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "sent",
        lastError: null,
        pickupReminder: null,
      },
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "dispensing_pickup_15s",
    name: "出货 15s 提醒",
    description: "商品已到取货口 15 秒，展示第一次取货提醒。",
    health: readyHealth,
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "succeeded",
      orderStatus: "dispensing",
      nextAction: "dispensing",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "sent",
        lastError: null,
        pickupReminder: {
          stage: "pickup_timeout_warning",
          level: "warning",
          message: "请及时取走商品",
          warningNo: 1,
          reportedAt: UPDATED_AT,
        },
      },
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "dispensing_pickup_25s",
    name: "出货 25s 提醒",
    description: "商品已到取货口 25 秒，展示更强的取货提醒。",
    health: readyHealth,
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "succeeded",
      orderStatus: "dispensing",
      nextAction: "dispensing",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "sent",
        lastError: null,
        pickupReminder: {
          stage: "pickup_timeout_warning",
          level: "urgent",
          message: "取货口即将关闭，请立即取走商品",
          warningNo: 2,
          reportedAt: UPDATED_AT,
        },
      },
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "dispense_failed",
    name: "出货失败",
    description: "支付成功但硬件出货失败，验证结果页和维护提示。",
    health: {
      ...blockedHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "dispense_failed",
        nextAction: "dispense_failed",
        updatedAt: UPDATED_AT,
      },
    },
    ready: blockedReady,
    config,
    saleReadiness: saleReadiness(false),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "succeeded",
      orderStatus: "dispense_failed",
      nextAction: "dispense_failed",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "failed",
        lastError: "mock: motor timeout",
      },
      errorCode: "MOTOR_TIMEOUT",
      errorMessage: "mock: motor timeout",
      operatorHint: "请检查下位机和货道",
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "manual_handling",
    name: "人工处理",
    description: "支付成功但出货结果未知，需要顾客保留订单凭证。",
    health: {
      ...blockedHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "manual_handling",
        nextAction: "manual_handling",
        updatedAt: UPDATED_AT,
      },
    },
    ready: blockedReady,
    config,
    saleReadiness: saleReadiness(false),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "succeeded",
      orderStatus: "manual_handling",
      nextAction: "manual_handling",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "result_unknown",
        lastError: "mock: dispense result unknown",
      },
      errorCode: "DISPENSE_RESULT_UNKNOWN",
      errorMessage: "mock: dispense result unknown",
      operatorHint: "请人工复核出货结果",
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "refund_pending",
    name: "退款处理中",
    description: "出货异常已发起退款，顾客需要保留订单凭证等待原路通知。",
    health: {
      ...blockedHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "refund_pending",
        nextAction: "refund_pending",
        updatedAt: UPDATED_AT,
      },
    },
    ready: blockedReady,
    config,
    saleReadiness: saleReadiness(false),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "refund_pending",
      orderStatus: "refund_pending",
      nextAction: "refund_pending",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "failed",
        lastError: "refund requested after dispense failure",
      },
      errorCode: "REFUND_PENDING",
      errorMessage: "refund requested after dispense failure",
      operatorHint: "退款处理中",
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "refunded",
    name: "退款完成",
    description: "出货异常退款已完成，顾客可返回首页。",
    health: {
      ...readyHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "refunded",
        nextAction: "refunded",
        updatedAt: UPDATED_AT,
      },
    },
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "refunded",
      orderStatus: "refunded",
      nextAction: "refunded",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "failed",
        lastError: "mock: dispense failed before refund",
      },
      errorCode: "REFUNDED",
      errorMessage: "mock: refund completed",
      operatorHint: "退款已完成",
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
  {
    id: "success",
    name: "出货成功",
    description: "支付成功且出货完成，展示成功结果页。",
    health: {
      ...readyHealth,
      currentTransaction: {
        orderNo: "UI-DEBUG-ORDER",
        status: "completed",
        nextAction: "success",
        updatedAt: UPDATED_AT,
      },
    },
    ready: readySnapshot,
    config,
    saleReadiness: saleReadiness(true),
    saleView: baseSaleView,
    paymentOptions,
    transaction: transaction({
      paymentStatus: "succeeded",
      orderStatus: "fulfilled",
      nextAction: "success",
      vending: {
        commandId: null,
        commandNo: "UI-DEBUG-CMD",
        status: "succeeded",
        lastError: null,
      },
    }),
    sync,
    scanner,
    vision,
    remoteOps,
  },
];

export function getUiDebugScenario(id: string | null): UiDebugScenario {
  return (
    uiDebugScenarios.find((scenario) => scenario.id === id) ??
    uiDebugScenarios[0]
  );
}

export function getActiveUiDebugScenarioId(): UiDebugScenarioId {
  const stored = localStorageOrNull()?.getItem(UI_DEBUG_SCENARIO_STORAGE_KEY);
  return getUiDebugScenario(stored ?? null).id;
}

export function setActiveUiDebugScenarioId(id: UiDebugScenarioId): void {
  localStorageOrNull()?.setItem(UI_DEBUG_SCENARIO_STORAGE_KEY, id);
}

export function getActiveUiDebugScenario(): UiDebugScenario {
  return getUiDebugScenario(getActiveUiDebugScenarioId());
}

export function saleViewOverrideKey(id: UiDebugScenarioId): string {
  return `${UI_DEBUG_SALE_VIEW_OVERRIDE_PREFIX}${id}`;
}

export function getSaleViewForScenario(
  id: UiDebugScenarioId,
): SaleViewSnapshot {
  const scenario = getUiDebugScenario(id);
  const storage = localStorageOrNull();
  const raw = storage?.getItem(saleViewOverrideKey(id));
  if (!raw) return scenario.saleView;
  try {
    return machineSaleViewSnapshotSchema.parse(JSON.parse(raw));
  } catch {
    storage?.removeItem(saleViewOverrideKey(id));
    return scenario.saleView;
  }
}

export function saveSaleViewOverride(
  id: UiDebugScenarioId,
  value: SaleViewSnapshot,
): void {
  localStorageOrNull()?.setItem(
    saleViewOverrideKey(id),
    JSON.stringify(machineSaleViewSnapshotSchema.parse(value)),
  );
}

export function clearSaleViewOverride(id: UiDebugScenarioId): void {
  localStorageOrNull()?.removeItem(saleViewOverrideKey(id));
}

export function enableUiDebugMode(): void {
  localStorageOrNull()?.setItem(UI_DEBUG_ENABLED_STORAGE_KEY, "1");
}

export function disableUiDebugMode(): void {
  localStorageOrNull()?.removeItem(UI_DEBUG_ENABLED_STORAGE_KEY);
}

export function isUiDebugModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const storage = localStorageOrNull();
  if (storage?.getItem(UI_DEBUG_ENABLED_STORAGE_KEY) === "1") return true;
  const params = new URLSearchParams(window.location.search);
  return params.get("uiDebug") === "1";
}
