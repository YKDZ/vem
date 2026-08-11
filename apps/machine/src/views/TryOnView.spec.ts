// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  getSaleViewMock,
  openFastMock,
  openAiMock,
  submitNavigationMock,
  routeMode,
} = vi.hoisted(() => ({
  getSaleViewMock: vi.fn(),
  openFastMock: vi.fn(),
  openAiMock: vi.fn(),
  submitNavigationMock: vi.fn(),
  routeMode: { value: undefined as "fast" | "ai" | undefined },
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({
    query: {
      catalogKey: "product:550e8400-e29b-41d4-a716-446655440128",
      variantId: "550e8400-e29b-41d4-a716-446655440125",
      ...(routeMode.value ? { mode: routeMode.value } : {}),
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
  openVisionFastAttempt: openFastMock,
  openVisionTryOnAttempt: openAiMock,
}));

import { useCatalogStore } from "@/stores/catalog";
import { useTryOnStore } from "@/stores/try-on";
import { useVisionStore } from "@/stores/vision";

import TryOnView from "./TryOnView.vue";

const productId = "550e8400-e29b-41d4-a716-446655440128";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
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

function attemptEvent<T extends { attemptId: string }>(
  type: string,
  payload: T,
) {
  return { type, payload };
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

describe("TryOnView acquisition UI", () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    vi.clearAllMocks();
    routeMode.value = undefined;
    getSaleViewMock.mockResolvedValue(saleView());
    openAiMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    useCatalogStore().applySnapshot(saleView());
    useVisionStore().applyVisionReady({
      serverName: "vision",
      serverVersion: "1",
      schemaVersion: "vem-vision-v2-contract-bundle/v1",
      bundleVersion: "1",
      contractDigest: "a".repeat(64),
      cameraReady: true,
      fastReady: true,
      aiReady: false,
      aiReadinessDiagnostic: "model_pack_missing",
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["try_on_fast"],
    });
  });

  afterEach(() => {
    mountedApp?.unmount();
    mountedApp = null;
    document.body.innerHTML = "";
  });

  it("takes the customer through preview, one manual intent, generation, result and recoverable image errors", async () => {
    let emit:
      | ((event: {
          type: string;
          payload: { attemptId: string } & object;
        }) => void)
      | undefined;
    const capture = vi.fn(() => true);
    const cancel = vi.fn(() => true);
    openFastMock.mockImplementation((_connection, _input, onEvent) => {
      emit = (event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({ close: vi.fn(), capture, cancel });
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledOnce();
    });
    const attemptId = useTryOnStore().attemptId!;
    if (!emit) throw new Error("expected Vision event boundary");

    emit(attemptEvent("vision.try_on.attempt.accepted", { attemptId }));
    emit(
      attemptEvent("vision.try_on.attempt.acquiring", {
        attemptId,
        preview: {
          reference:
            "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "hold_still",
        manualCaptureAllowed: true,
      }),
    );
    await nextTick();
    const preview = host.querySelector(
      '[data-test="try-on-acquisition-preview"]',
    );
    expect(preview).toBeInstanceOf(HTMLImageElement);
    expect(preview?.getAttribute("src")).toContain("preview.mjpeg?token=");
    preview?.dispatchEvent(new Event("error"));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-acquisition-stream-error"]'),
    ).not.toBeNull();
    const manual = host.querySelector('[data-test="try-on-manual-capture"]');
    manual?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(capture).toHaveBeenCalledOnce();
    expect((manual as HTMLButtonElement).disabled).toBe(true);

    emit(
      attemptEvent("vision.try_on.attempt.generating", {
        attemptId,
        stage: "rendering",
      }),
    );
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-acquisition-preview"]'),
    ).toBeNull();
    expect(host.textContent).toContain("正在生成试衣效果");
    emit(
      attemptEvent("vision.try_on.attempt.completed", {
        attemptId,
        result: {
          reference: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`,
          digest: `sha256:${"b".repeat(64)}`,
          contentType: "image/png",
          byteSize: 2048,
          width: 512,
          height: 768,
        },
      }),
    );
    await nextTick();
    const result = host.querySelector('[data-test="try-on-result-image"]');
    expect(result).toBeInstanceOf(HTMLImageElement);
    result?.dispatchEvent(new Event("error"));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-result-error"]'),
    ).not.toBeNull();
  });

  it("runs the AI route through truthful coarse stages, result, retry, and never opens Fast", async () => {
    routeMode.value = "ai";
    useVisionStore().applyVisionReady({
      serverName: "vision",
      serverVersion: "1",
      schemaVersion: "vem-vision-v2-contract-bundle/v1",
      bundleVersion: "1",
      contractDigest: "a".repeat(64),
      cameraReady: true,
      fastReady: true,
      aiReady: true,
      aiReadinessDiagnostic: "ready",
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["try_on_fast", "try_on_ai"],
    });
    const callbacks: Array<(event: { type: string; payload: object }) => void> =
      [];
    openAiMock.mockImplementation((_connection, _input, onEvent) => {
      callbacks.push((event) =>
        onEvent(event, {
          attemptId: (event.payload as { attemptId: string }).attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        }),
      );
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      });
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openAiMock).toHaveBeenCalledOnce();
    });
    expect(openFastMock).not.toHaveBeenCalled();
    expect(openAiMock.mock.calls[0][1]).toMatchObject({ mode: "ai" });
    const attemptId = useTryOnStore().attemptId!;

    callbacks[0]?.(
      attemptEvent("vision.try_on.attempt.accepted", {
        attemptId,
        mode: "ai",
      }),
    );
    callbacks[0]?.(
      attemptEvent("vision.try_on.attempt.acquiring", {
        attemptId,
        preview: {
          reference:
            "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "hold_still",
        manualCaptureAllowed: true,
      }),
    );
    callbacks[0]?.(
      attemptEvent("vision.try_on.attempt.generating", {
        attemptId,
        stage: "preparing",
      }),
    );
    await nextTick();
    expect(host.textContent).toContain("正在准备试衣效果");
    callbacks[0]?.(
      attemptEvent("vision.try_on.attempt.generating", {
        attemptId,
        stage: "generating",
      }),
    );
    await nextTick();
    expect(host.textContent).toContain("正在生成试衣效果");
    callbacks[0]?.(
      attemptEvent("vision.try_on.attempt.completed", {
        attemptId,
        result: {
          reference: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`,
          digest: `sha256:${"b".repeat(64)}`,
          contentType: "image/png",
          byteSize: 2048,
          width: 512,
          height: 768,
        },
      }),
    );
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-result-image"]'),
    ).not.toBeNull();

    host
      .querySelector('[data-test="try-on-retry"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(openAiMock).toHaveBeenCalledTimes(2);
    });
    expect(openFastMock).not.toHaveBeenCalled();
    expect(openAiMock.mock.calls[1][1]).toMatchObject({ mode: "ai" });
    expect(openAiMock.mock.calls[1][1].attemptId).not.toBe(attemptId);
  });

  it("sends one explicit user cancellation", async () => {
    const cancel = vi.fn(() => true);
    openFastMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel,
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledOnce();
    });
    const cancelButton = host.querySelector('[data-test="try-on-cancel"]');
    cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(cancel).toHaveBeenCalledWith("user");
    expect(host.querySelector('[data-test="try-on-cancel"]')).toBeNull();
  });

  it("sends route_leave once when an active try-on route unmounts", async () => {
    const cancel = vi.fn(() => true);
    openFastMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel,
    });
    await mount();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledOnce();
    });

    mountedApp?.unmount();
    mountedApp = null;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("route_leave");
  });

  it("returns a departed customer to the exact selected variant without a second route_leave", async () => {
    let emit:
      | ((event: {
          type: string;
          payload: { attemptId: string } & object;
        }) => void)
      | undefined;
    const cancel = vi.fn(() => true);
    openFastMock.mockImplementation((_connection, _input, onEvent) => {
      emit = (event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({ close: vi.fn(), capture: vi.fn(), cancel });
    });
    await mount();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledOnce();
    });
    if (!emit) throw new Error("expected Vision event boundary");
    emit(
      attemptEvent("vision.try_on.attempt.canceled", {
        attemptId: useTryOnStore().attemptId!,
        reason: "departure",
      }),
    );
    await nextTick();

    expect(submitNavigationMock).toHaveBeenCalledExactlyOnceWith({
      type: "customer.navigate",
      target: {
        name: "product-detail",
        params: { catalogKey: `product:${productId}` },
        query: { variantId },
      },
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("retries failed, canceled, and completed attempts through distinct native sockets", async () => {
    const callbacks: Array<(event: { type: string; payload: object }) => void> =
      [];
    openFastMock.mockImplementation((_connection, _input, onEvent) => {
      callbacks.push((event) =>
        onEvent(event, {
          attemptId: (event.payload as { attemptId: string }).attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        }),
      );
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      });
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledOnce();
    });
    const terminal = async (type: string, payload: object): Promise<void> => {
      if (type === "vision.try_on.attempt.completed") {
        const attemptId = (payload as { attemptId: string }).attemptId;
        callbacks[callbacks.length - 1]?.({
          type: "vision.try_on.attempt.accepted",
          payload: { attemptId },
        });
        callbacks[callbacks.length - 1]?.({
          type: "vision.try_on.attempt.acquiring",
          payload: {
            attemptId,
            preview: {
              reference:
                "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
              streamType: "mjpeg",
            },
            occupancy: "single",
            guidance: "hold_still",
            manualCaptureAllowed: true,
          },
        });
        callbacks[callbacks.length - 1]?.({
          type: "vision.try_on.attempt.generating",
          payload: {
            attemptId,
            stage: "preparing",
          },
        });
      }
      callbacks[callbacks.length - 1]?.({ type, payload });
      await nextTick();
      const retry = host.querySelector('[data-test="try-on-retry"]');
      expect(retry).not.toBeNull();
      const expectedStarts = openFastMock.mock.calls.length + 1;
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => {
        expect(openFastMock).toHaveBeenCalledTimes(expectedStarts);
      });
    };
    const first = useTryOnStore().attemptId!;
    await terminal("vision.try_on.attempt.failed", {
      attemptId: first,
      reason: "fast_failed",
    });
    const second = useTryOnStore().attemptId!;
    await terminal("vision.try_on.attempt.canceled", {
      attemptId: second,
      reason: "user",
    });
    const third = useTryOnStore().attemptId!;
    await terminal("vision.try_on.attempt.completed", {
      attemptId: third,
      result: {
        reference: `http://127.0.0.1:7892/v2/try-on/results/${third}?token=result-token`,
        digest: `sha256:${"b".repeat(64)}`,
        contentType: "image/png",
        byteSize: 2048,
        width: 512,
        height: 768,
      },
    });

    expect(openFastMock).toHaveBeenCalledTimes(4);
    expect(
      new Set(openFastMock.mock.calls.map((call) => call[1].attemptId)),
    ).toHaveLength(4);
  });

  it("uses route_leave once for a current return and never cancels a completed return", async () => {
    let emit:
      | ((event: {
          type: string;
          payload: { attemptId: string } & object;
        }) => void)
      | undefined;
    const cancel = vi.fn(() => true);
    openFastMock.mockImplementation((_connection, _input, onEvent) => {
      emit = (event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({ close: vi.fn(), capture: vi.fn(), cancel });
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledOnce();
    });
    host
      .querySelector('[data-test="try-on-return"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("route_leave");
    await useTryOnStore().retry();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledTimes(2);
    });
    if (!emit) throw new Error("expected Vision event boundary");
    emit(
      attemptEvent("vision.try_on.attempt.accepted", {
        attemptId: useTryOnStore().attemptId!,
      }),
    );
    emit(
      attemptEvent("vision.try_on.attempt.acquiring", {
        attemptId: useTryOnStore().attemptId!,
        preview: {
          reference:
            "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "hold_still",
        manualCaptureAllowed: true,
      }),
    );
    emit(
      attemptEvent("vision.try_on.attempt.generating", {
        attemptId: useTryOnStore().attemptId!,
        stage: "preparing",
      }),
    );
    emit(
      attemptEvent("vision.try_on.attempt.completed", {
        attemptId: useTryOnStore().attemptId!,
        result: {
          reference: `http://127.0.0.1:7892/v2/try-on/results/${useTryOnStore().attemptId}?token=result-token`,
          digest: `sha256:${"b".repeat(64)}`,
          contentType: "image/png",
          byteSize: 2048,
          width: 512,
          height: 768,
        },
      }),
    );
    await nextTick();
    host
      .querySelector('[data-test="try-on-return"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not navigate from profile signals while the try-on customer route is active", async () => {
    openFastMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    await mount();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledOnce();
    });
    useVisionStore().applyRecommendationProfileResult({
      source: "front",
      eventId: "VISION-PROFILE-TRY-ON",
      detectedAt: "2026-08-10T00:00:00.000Z",
      occupancy: { state: "single", confidence: 0.9 },
      profile: { personPresent: true, confidence: 0.9 },
      quality: { overall: "good", warnings: [], profileUsable: true },
    });
    await nextTick();
    expect(submitNavigationMock).not.toHaveBeenCalled();
  });
});
