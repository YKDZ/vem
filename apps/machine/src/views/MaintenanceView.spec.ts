// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  routerReplaceMock,
  getSaleViewMock,
  recordStockMovementMock,
  runHardwareSelfCheckMock,
  saveConfigMock,
} = vi.hoisted(() => ({
  routerReplaceMock: vi.fn(),
  getSaleViewMock: vi.fn(),
  recordStockMovementMock: vi.fn(),
  runHardwareSelfCheckMock: vi.fn(),
  saveConfigMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: routerReplaceMock }),
}));

vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));

vi.mock("@/components/MockHardwareControls.vue", () => ({
  default: { template: "<div />" },
}));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleView: getSaleViewMock,
    recordStockMovement: recordStockMovementMock,
    runHardwareSelfCheck: runHardwareSelfCheckMock,
    saveConfig: saveConfigMock,
  },
}));

import { useMachineStore } from "@/stores/machine";

import MaintenanceView from "./MaintenanceView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function saleViewFixture() {
  return {
    items: [
      {
        machineCode: "M001",
        slotId: "550e8400-e29b-41d4-a716-446655440001",
        slotCode: "A1",
        layerNo: 1,
        cellNo: 1,
        inventoryId: "550e8400-e29b-41d4-a716-446655440002",
        variantId: "550e8400-e29b-41d4-a716-446655440003",
        productId: "550e8400-e29b-41d4-a716-446655440004",
        productName: "Mineral Water",
        productDescription: null,
        coverImageUrl: null,
        categoryId: null,
        categoryName: null,
        sku: "WATER-001",
        size: null,
        color: null,
        priceCents: 100,
        capacity: 8,
        parLevel: 6,
        physicalStock: 2,
        saleableStock: 2,
        slotSalesState: "sale_ready",
        productSortOrder: 1,
        targetGender: null,
      },
    ],
    source: "local_stock",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-06-05T00:00:00.000Z",
  };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  getSaleViewMock.mockResolvedValue(saleViewFixture());
  recordStockMovementMock.mockResolvedValue(saleViewFixture());
  runHardwareSelfCheckMock.mockResolvedValue({
    online: true,
    message: "ok",
    candidates: [],
    configUpdated: false,
    portPath: null,
    resolutionSource: null,
    boundUsbIdentity: null,
  });
  saveConfigMock.mockResolvedValue({});
  useMachineStore().$patch({ configLoaded: true });
});

afterEach(() => {
  mountedApp?.unmount();
  mountedApp = null;
  document.body.innerHTML = "";
});

async function mountView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(MaintenanceView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await vi.waitFor(() => {
    expect(getSaleViewMock).toHaveBeenCalled();
  });
  await nextTick();
  return host;
}

function submitButton(host: HTMLElement): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((item) =>
    item.textContent?.includes("记录库存动作"),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("submit button not found");
  }
  return button;
}

function hardwareAdapterSelect(host: HTMLElement): HTMLSelectElement {
  const select = Array.from(host.querySelectorAll("select")).find((item) =>
    Array.from(item.options).some((option) => option.value === "serial"),
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("hardware adapter select not found");
  }
  return select;
}

function movementTypeSelect(host: HTMLElement): HTMLSelectElement {
  const select = Array.from(host.querySelectorAll("select")).find((item) =>
    Array.from(item.options).some(
      (option) => option.value === "stock_count_correction",
    ),
  );
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("movement type select not found");
  }
  return select;
}

describe("MaintenanceView hardware config", () => {
  it("only exposes planned hardware adapters", async () => {
    const host = await mountView();
    const select = hardwareAdapterSelect(host);

    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "mock",
      "serial",
    ]);
    expect(host.textContent).not.toContain("bluetooth");
    expect(host.textContent).not.toContain("vendor_sdk");
  });
});

describe("MaintenanceView stock maintenance", () => {
  it("does not expose trusted stock movement sources", async () => {
    const host = await mountView();

    expect(host.textContent).not.toContain("field_service");
    expect(host.textContent).not.toContain("approved_count");
  });

  it("records no-login planned refill as local maintenance with attribution", async () => {
    const host = await mountView();

    submitButton(host).click();

    await vi.waitFor(() => {
      expect(recordStockMovementMock).toHaveBeenCalledWith(
        expect.objectContaining({
          planogramVersion: "PLAN-1",
          slotId: "550e8400-e29b-41d4-a716-446655440001",
          movementType: "planned_refill",
          source: "local_maintenance",
          attributedTo: "front-panel",
        }),
      );
    });
  });

  it("records no-login stock count as local maintenance with attribution", async () => {
    const host = await mountView();
    const select = movementTypeSelect(host);
    select.value = "stock_count_correction";
    select.dispatchEvent(new Event("change"));
    await nextTick();

    submitButton(host).click();

    await vi.waitFor(() => {
      expect(recordStockMovementMock).toHaveBeenCalledWith(
        expect.objectContaining({
          movementType: "stock_count_correction",
          source: "local_maintenance",
          attributedTo: "front-panel",
        }),
      );
    });
  });
});
