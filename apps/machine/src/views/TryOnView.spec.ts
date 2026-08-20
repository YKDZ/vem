// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  getSaleViewMock,
  openAttemptMock,
  openAdjustMock,
  submitNavigationMock,
} = vi.hoisted(() => ({
  getSaleViewMock: vi.fn(),
  openAttemptMock: vi.fn(),
  openAdjustMock: vi.fn(),
  submitNavigationMock: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({
    query: {
      catalogKey: "product:550e8400-e29b-41d4-a716-446655440128",
      variantId: "550e8400-e29b-41d4-a716-446655440125",
    },
  }),
}));
vi.mock("@/layouts/KioskLayout.vue", () => ({
  default: { template: "<main><slot /></main>" },
}));
vi.mock("@/router/transaction-route-authority", () => ({
  submitMachineNavigationIntent: submitNavigationMock,
}));
vi.mock("@/daemon/client", () => ({
  daemonClient: { getSaleView: getSaleViewMock, refreshCatalog: vi.fn() },
}));
vi.mock("@/native/vision", () => ({
  openVisionTryOnAttempt: openAttemptMock,
  openVisionGarmentAdjustment: openAdjustMock,
}));

import type { VisionTryOnAttemptEvent } from "@/native/vision";

import { useCatalogStore } from "@/stores/catalog";
import { useTryOnStore } from "@/stores/try-on";
import { useVisionStore } from "@/stores/vision";

import TryOnView from "./TryOnView.vue";

const productId = "550e8400-e29b-41d4-a716-446655440128";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
const attemptId = "550e8400-e29b-41d4-a716-446655440124";
let mountedApp: App<Element> | null = null;
let pinia: ReturnType<typeof createPinia>;

function saleView() {
  return {
    items: [
      {
        machineCode: "M001",
        slotId: "550e8400-e29b-41d4-a716-446655440123",
        slotDisplayLabel: "R1C1",
        rowNo: 1,
        cellNo: 1,
        inventoryId: "550e8400-e29b-41d4-a716-446655440127",
        variantId,
        productId,
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

function ready() {
  return {
    serverName: "vision",
    serverVersion: "1",
    schemaVersion: "vem-vision-v2-contract-bundle/v1",
    bundleVersion: "1",
    contractDigest: "a".repeat(64),
    cameraReady: true,
    tryOnReady: true,
    visionBusinessReady: true,
    businessReadinessDiagnostic: "ready" as const,
    capabilities: ["try_on"],
  };
}

function event(type: VisionTryOnAttemptEvent["type"], payload: object) {
  return { type, payload } as VisionTryOnAttemptEvent;
}

function acquisition(holdRemainingMs = 3_000): VisionTryOnAttemptEvent {
  return event("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: {
      reference:
        "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
      streamType: "mjpeg",
    },
    occupancy: "single",
    guidance: "counting_down",
    manualCaptureAllowed: true,
    holdRemainingMs,
  });
}

function captured(): VisionTryOnAttemptEvent {
  return event("vision.try_on.attempt.captured", {
    attemptId,
    captured: {
      reference:
        "http://127.0.0.1:7892/v2/try-on/captured/frame.png?token=captured-token",
      digest: `sha256:${"b".repeat(64)}`,
      contentType: "image/png",
      byteSize: 2048,
      width: 512,
      height: 768,
      frameId: "front-42",
    },
  });
}

function completed(): Extract<
  VisionTryOnAttemptEvent,
  { type: "vision.try_on.attempt.completed" }
> {
  return event("vision.try_on.attempt.completed", {
    attemptId,
    result: {
      reference: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`,
      digest: `sha256:${"c".repeat(64)}`,
      contentType: "image/png",
      byteSize: 2048,
      width: 512,
      height: 768,
    },
  }) as Extract<
    VisionTryOnAttemptEvent,
    { type: "vision.try_on.attempt.completed" }
  >;
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedApp = createApp(TryOnView);
  mountedApp.use(pinia);
  mountedApp.mount(host);
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return host;
}

describe("TryOnView single-path acquisition UI", () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.clearAllMocks();
    getSaleViewMock.mockResolvedValue(saleView());
    useCatalogStore().applySnapshot(saleView());
    useVisionStore().applyVisionReady(ready());
    openAdjustMock.mockResolvedValue({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed().payload.result,
    });
  });

  afterEach(() => {
    mountedApp?.unmount();
    mountedApp = null;
    document.body.innerHTML = "";
  });

  it("renders one live preview, forwards one manual capture, retains captured identity, then renders the result", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    const capture = vi.fn(() => true);
    openAttemptMock.mockImplementation((_connection, _input, onEvent) => {
      emit = (next) =>
        onEvent(next, {
          attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({ close: vi.fn(), capture, cancel: vi.fn() });
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledOnce();
    });
    if (!emit) throw new Error("expected native try-on event callback");

    emit(event("vision.try_on.attempt.accepted", { attemptId }));
    emit(acquisition());
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-acquisition-preview"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-test="try-on-countdown"]')?.textContent,
    ).toBe("3");

    host
      .querySelector('[data-test="try-on-manual-capture"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(capture).toHaveBeenCalledOnce();

    emit(captured());
    await nextTick();
    expect(useTryOnStore().captured?.frameId).toBe("front-42");
    expect(
      host.querySelector('[data-test="try-on-acquisition-preview"]'),
    ).toBeNull();

    emit(
      event("vision.try_on.attempt.generating", {
        attemptId,
        stage: "generating",
      }),
    );
    emit(completed());
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-result-image"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-test="try-on-garment-scale"]'),
    ).not.toBeNull();
  });

  it("shows a recoverable preview error and uses the same single path for retry and return", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    openAttemptMock.mockImplementation((_connection, _input, onEvent) => {
      emit = (next) =>
        onEvent(next, {
          attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      });
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledOnce();
    });
    if (!emit) throw new Error("expected native try-on event callback");
    emit(event("vision.try_on.attempt.accepted", { attemptId }));
    emit(acquisition(2_000));
    await nextTick();
    host
      .querySelector('[data-test="try-on-acquisition-preview"]')
      ?.dispatchEvent(new Event("error"));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-acquisition-stream-error"]'),
    ).not.toBeNull();

    emit(
      event("vision.try_on.attempt.canceled", { attemptId, reason: "timeout" }),
    );
    await nextTick();
    host
      .querySelector('[data-test="try-on-retry"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledTimes(2);
    });

    host
      .querySelector('[data-test="try-on-return"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(submitNavigationMock).toHaveBeenCalledWith({
      type: "customer.navigate",
      target: {
        name: "product-detail",
        params: { catalogKey: "product:550e8400-e29b-41d4-a716-446655440128" },
        query: { variantId },
      },
    });
  });

  it("requests an absolute garment-scale adjustment only after completion", async () => {
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    const store = useTryOnStore();
    store.context = {
      catalogKey: `product:${productId}`,
      productId,
      variantId,
    };
    store.attemptId = attemptId;
    store.phase = "completed";
    store.result = completed().payload.result;
    const host = await mount();

    host
      .querySelector('[data-test="try-on-scale-up"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(openAdjustMock).toHaveBeenCalledOnce();
    });
    expect(openAdjustMock).toHaveBeenCalledWith(expect.anything(), {
      attemptId,
      garmentScale: 1.05,
    });
    await nextTick();
    expect(
      host
        .querySelector('[data-test="try-on-scale-value"]')
        ?.textContent?.trim(),
    ).toBe("105%");
  });
});
