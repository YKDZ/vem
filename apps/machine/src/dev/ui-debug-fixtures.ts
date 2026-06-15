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
  | "blocked"
  | "payment_qr"
  | "dispensing"
  | "dispense_failed";

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
const EXPIRES_AT = "2026-06-14T08:05:00.000Z";

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
    kioskMode: false,
    stockMovementRetentionDays: 30,
  },
  machineSecretConfigured: true,
  mqttSigningSecretConfigured: true,
  mqttPasswordConfigured: false,
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
      productName: "城市机能 T 恤",
      productDescription: "本地 UI 调试商品，包含多个尺码和样式。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "服饰",
      sku: "TEE-M-BLACK",
      size: "M",
      color: "黑色",
      priceCents: 6900,
      capacity: 8,
      parLevel: 6,
      physicalStock: 4,
      saleableStock: 4,
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
      productName: "城市机能 T 恤",
      productDescription: "本地 UI 调试商品，包含多个尺码和样式。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "服饰",
      sku: "TEE-L-BLACK",
      size: "L",
      color: "黑色",
      priceCents: 6900,
      capacity: 8,
      parLevel: 6,
      physicalStock: 3,
      saleableStock: 3,
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
      productId: "550e8400-e29b-41d4-a716-446655440301",
      productName: "城市机能 T 恤",
      productDescription: "本地 UI 调试商品，包含多个尺码和样式。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "服饰",
      sku: "TEE-L-WHITE",
      size: "L",
      color: "白色",
      priceCents: 7200,
      capacity: 8,
      parLevel: 6,
      physicalStock: 2,
      saleableStock: 2,
      slotSalesState: "sale_ready",
      productSortOrder: 1,
      targetGender: null,
    },
    {
      machineCode: "UI-DEBUG-001",
      slotId: "550e8400-e29b-41d4-a716-446655440004",
      slotCode: "B2",
      layerNo: 2,
      cellNo: 2,
      inventoryId: "550e8400-e29b-41d4-a716-446655440104",
      variantId: "550e8400-e29b-41d4-a716-446655440204",
      productId: "550e8400-e29b-41d4-a716-446655440302",
      productName: "冰镇气泡水",
      productDescription: "用于验证普通单规格商品展示。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "饮料",
      sku: "SODA-330",
      size: "330ml",
      color: null,
      priceCents: 1200,
      capacity: 10,
      parLevel: 8,
      physicalStock: 6,
      saleableStock: 6,
      slotSalesState: "sale_ready",
      productSortOrder: 2,
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
      productId: "550e8400-e29b-41d4-a716-446655440303",
      productName: "库存异常商品",
      productDescription: "用于验证售罄和安全拦截态。",
      coverImageUrl: null,
      categoryId: null,
      categoryName: "测试",
      sku: "BLOCKED-001",
      size: null,
      color: null,
      priceCents: 9900,
      capacity: 4,
      parLevel: 4,
      physicalStock: 1,
      saleableStock: 0,
      slotSalesState: "frozen",
      productSortOrder: 9,
      targetGender: null,
    },
  ],
  source: "ui_debug",
  planogramVersion: "UI-DEBUG-PLAN",
  lastUpdatedAt: UPDATED_AT,
});

const paymentOptions = machinePaymentOptionsResponseSchema.parse({
  options: [
    {
      optionKey: "mock:mock",
      providerCode: "mock",
      method: "mock",
      displayName: "模拟支付",
      description: "本地 UI 调试，不连接真实支付",
      icon: "mock",
      recommended: true,
      disabled: false,
      disabledReason: null,
    },
    {
      optionKey: "qr_code:alipay",
      providerCode: "alipay",
      method: "qr_code",
      displayName: "支付宝扫码",
      description: "展示二维码支付界面",
      icon: "alipay",
      recommended: false,
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
  defaultOptionKey: "mock:mock",
  defaultProviderCode: "mock",
  serverTime: UPDATED_AT,
});

const emptyTransaction: TransactionSnapshot = {
  orderId: null,
  orderNo: null,
  productSummary: null,
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
    productSummary: { name: "城市机能 T 恤", sku: "TEE-L-BLACK" },
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
    id: "dispensing",
    name: "正在出货",
    description: "支付成功后进入出货进度页。",
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
        commandNo: "UI-DEBUG-CMD",
        status: "sent",
        lastError: null,
        pickupReminder: {
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
