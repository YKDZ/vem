// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const { submitNavigationMock } = vi.hoisted(() => ({
  submitNavigationMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({
    params: { catalogKey: "product:550e8400-e29b-41d4-a716-446655440128" },
    query: { variantId: "550e8400-e29b-41d4-a716-446655440125" },
  }),
}));
vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));
vi.mock("@/components/KioskHeader.vue", () => ({
  default: { template: "<header />" },
}));
vi.mock("@/components/catalog/ManagedMediaImage.vue", () => ({
  default: { template: '<img data-test="managed-media" />' },
}));
vi.mock("@/router/transaction-route-authority", () => ({
  submitMachineNavigationIntent: submitNavigationMock,
}));
vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleView: vi.fn(),
    refreshCatalog: vi.fn(),
    getSaleStartCapability: vi.fn(),
  },
}));

import { useCatalogStore } from "@/stores/catalog";
import { useTryOnStore } from "@/stores/try-on";
import { useVisionStore } from "@/stores/vision";

import ProductDetailView from "./ProductDetailView.vue";

let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function saleView() {
  return {
    items: [
      {
        machineCode: "M001",
        slotId: "550e8400-e29b-41d4-a716-446655440124",
        slotDisplayLabel: "R1C1",
        rowNo: 1,
        cellNo: 1,
        inventoryId: "550e8400-e29b-41d4-a716-446655440127",
        variantId: "550e8400-e29b-41d4-a716-446655440125",
        productId: "550e8400-e29b-41d4-a716-446655440128",
        productName: "蓝色 T 恤",
        productDescription: null,
        coverImageUrl: null,
        tryOnGarmentMedia: {
          id: "550e8400-e29b-41d4-a716-446655440126",
          reference: "/api/media-assets/garment/content",
          digest: `sha256:${"a".repeat(64)}`,
          contentType: "image/png" as const,
          byteSize: 2048,
          purpose: "try_on_garment" as const,
          revision: { catalogRevision: "catalog-2", assetRevision: "asset-2" },
        },
        tryOnGarmentReadyUrl: `http://127.0.0.1:65000/media/sha256:${"a".repeat(64)}?grant=abcdefghijklmnop`,
        tryOnGarmentTemplate: "tshirt_short_sleeve" as const,
        categoryId: null,
        categoryName: "T恤",
        sku: "TEE-1",
        size: "M",
        color: "蓝色",
        priceCents: 1000,
        productSortOrder: 1,
        targetGender: null,
        capacity: 1,
        parLevel: 1,
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready" as const,
      },
    ],
    source: "backend" as const,
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function ready(tryOnReady = true) {
  return {
    serverName: "vision",
    serverVersion: "1",
    schemaVersion: "vem-vision-v2-contract-bundle/v1",
    bundleVersion: "1",
    contractDigest: "a".repeat(64),
    cameraReady: true,
    tryOnReady,
    visionBusinessReady: true,
    businessReadinessDiagnostic: "ready" as const,
    capabilities: ["try_on"],
  };
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(ProductDetailView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return host;
}

describe("ProductDetailView virtual try-on entry", () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.clearAllMocks();
    useCatalogStore().applySnapshot(saleView());
  });

  afterEach(() => {
    mountedApp?.unmount();
    mountedApp = null;
    document.body.innerHTML = "";
  });

  it("only exposes one ready single-path entry", async () => {
    useVisionStore().applyVisionReady(ready());
    const host = await mount();

    expect(host.querySelectorAll('[data-test="try-on"]')).toHaveLength(1);
    expect(host.querySelector('[data-test="try-on"]')?.textContent).toContain(
      "虚拟试衣",
    );
    expect(host.querySelectorAll("button.try-on-entry-button")).toHaveLength(1);
  });

  it("prepares the active item and navigates without a mode query", async () => {
    useVisionStore().applyVisionReady(ready());
    const host = await mount();
    host
      .querySelector('[data-test="try-on"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    expect(submitNavigationMock).toHaveBeenCalledExactlyOnceWith({
      type: "customer.navigate",
      target: {
        name: "try-on",
        query: {
          catalogKey: "product:550e8400-e29b-41d4-a716-446655440128",
          variantId: "550e8400-e29b-41d4-a716-446655440125",
        },
      },
    });
    expect(useTryOnStore().context).toMatchObject({
      catalogKey: "product:550e8400-e29b-41d4-a716-446655440128",
      variantId: "550e8400-e29b-41d4-a716-446655440125",
    });
  });

  it("withholds the entry when Vision does not publish the single capability", async () => {
    useVisionStore().applyVisionReady(ready(false));
    const host = await mount();
    expect(host.querySelector('[data-test="try-on"]')).toBeNull();
  });
});
