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
import { MIN_CAPTURED_FRAME_VISIBLE_MS } from "@/stores/try-on";
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

function acquisition(
  holdRemainingMs = 3_000,
  eventAttemptId = attemptId,
): VisionTryOnAttemptEvent {
  return event("vision.try_on.attempt.acquiring", {
    attemptId: eventAttemptId,
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

function captured(
  eventAttemptId = attemptId,
  capturedToken = "captured-token",
): VisionTryOnAttemptEvent {
  return event("vision.try_on.attempt.captured", {
    attemptId: eventAttemptId,
    captured: {
      reference: `http://127.0.0.1:7892/v2/try-on/captured/frame.png?token=${capturedToken}`,
      digest: `sha256:${"b".repeat(64)}`,
      contentType: "image/png",
      byteSize: 2048,
      width: 512,
      height: 768,
      frameId: "front-42",
    },
  });
}

function completed(
  eventAttemptId = attemptId,
): Extract<
  VisionTryOnAttemptEvent,
  { type: "vision.try_on.attempt.completed" }
> {
  return event("vision.try_on.attempt.completed", {
    attemptId: eventAttemptId,
    result: {
      reference: `http://127.0.0.1:7892/v2/try-on/results/${eventAttemptId}?token=result-token`,
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

async function confirmCapturedImageDisplayed(host: HTMLElement): Promise<void> {
  const image = host.querySelector<HTMLImageElement>(
    '[data-test="try-on-captured-image"]',
  );
  if (!image) throw new Error("预期存在已验证的捕获帧图像");
  Object.defineProperties(image, {
    naturalHeight: { configurable: true, value: 768 },
    naturalWidth: { configurable: true, value: 512 },
  });
  vi.useFakeTimers();
  try {
    image.dispatchEvent(new Event("load"));
    await nextTick();
    await vi.advanceTimersByTimeAsync(MIN_CAPTURED_FRAME_VISIBLE_MS);
  } finally {
    vi.useRealTimers();
  }
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
    let emittedAttemptId = attemptId;
    const capture = vi.fn(() => true);
    const close = vi.fn();
    openAttemptMock.mockImplementation((_connection, _input, onEvent) => {
      const localAttemptId = _input.attemptId;
      emittedAttemptId = localAttemptId;
      emit = (next) =>
        onEvent(
          { ...next, payload: { ...next.payload, attemptId: localAttemptId } },
          {
            attemptId: localAttemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          },
        );
      return Promise.resolve({ close, capture, cancel: vi.fn() });
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
    emit(acquisition(2_000));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-acquisition-preview"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-test="try-on-countdown"]')?.textContent,
    ).toBe("2");
    emit(acquisition(1_000));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-acquisition-preview"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-test="try-on-countdown"]')?.textContent,
    ).toBe("1");
    emit(acquisition(0));
    await nextTick();
    expect(host.querySelector('[data-test="try-on-countdown"]')).toBeNull();
    expect(
      host.querySelector('[data-test="try-on-guidance"]')?.textContent,
    ).not.toContain("0");
    emit(
      event("vision.try_on.attempt.acquiring", {
        attemptId,
        preview: {
          reference:
            "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "align",
        manualCaptureAllowed: false,
      }),
    );
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-acquisition-preview"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-test="try-on-countdown"]')).toBeNull();
    expect(
      host.querySelector('[data-test="try-on-guidance"]')?.textContent,
    ).toContain("请面向镜头并调整站位");
    emit(acquisition());
    await nextTick();

    host
      .querySelector('[data-test="try-on-manual-capture"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(capture).toHaveBeenCalledOnce();

    emit(captured());
    await nextTick();
    expect(useTryOnStore().captured?.frameId).toBe("front-42");
    expect(
      host.querySelector('[data-test="try-on-captured-image"]'),
    ).not.toBeNull();
    expect(
      host.querySelector<HTMLImageElement>(
        '[data-test="try-on-captured-image"]',
      )?.src,
    ).toContain("/v2/try-on/captured/frame.png?token=captured-token");
    expect(
      host.querySelector<HTMLImageElement>(
        '[data-test="try-on-captured-image"]',
      )?.width,
    ).toBe(512);
    expect(
      host
        .querySelector('[data-test="try-on-captured-image"]')
        ?.classList.contains("try-on-media"),
    ).toBe(true);
    await confirmCapturedImageDisplayed(host);

    emit(
      event("vision.try_on.attempt.generating", {
        attemptId,
        stage: "generating",
      }),
    );
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-captured-image"]'),
    ).not.toBeNull();
    emit(completed(emittedAttemptId));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-captured-image"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-test="try-on-result-image"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-test="try-on-garment-scale"]'),
    ).not.toBeNull();
    expect(close).not.toHaveBeenCalled();

    mountedApp?.unmount();
    mountedApp = null;
    expect(close).toHaveBeenCalledOnce();
  });

  it("结果同 tick 到达时，已验证捕获帧加载后仍保持最小可见窗口", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    let emittedAttemptId = attemptId;
    openAttemptMock.mockImplementation((_connection, input, onEvent) => {
      emittedAttemptId = input.attemptId;
      emit = (next) =>
        onEvent(
          { ...next, payload: { ...next.payload, attemptId: input.attemptId } },
          {
            attemptId: input.attemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          },
        );
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      });
    });
    try {
      const host = await mount();
      await vi.waitFor(() => {
        expect(openAttemptMock).toHaveBeenCalledOnce();
      });
      if (!emit) throw new Error("预期收到原生试衣事件回调");

      emit(event("vision.try_on.attempt.accepted", { attemptId }));
      emit(acquisition());
      emit(captured());
      emit(
        event("vision.try_on.attempt.generating", {
          attemptId,
          stage: "generating",
        }),
      );
      emit(completed(emittedAttemptId));
      await nextTick();

      expect(useTryOnStore().phase).toBe("generating");

      const capturedImage = host.querySelector<HTMLImageElement>(
        '[data-test="try-on-captured-image"]',
      );
      expect(capturedImage).not.toBeNull();
      expect(
        host.querySelector('[data-test="try-on-result-image"]'),
      ).toBeNull();

      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(2_000);
      await nextTick();
      expect(
        host.querySelector('[data-test="try-on-captured-image"]'),
      ).not.toBeNull();
      expect(
        host.querySelector('[data-test="try-on-result-image"]'),
      ).toBeNull();

      Object.defineProperties(capturedImage!, {
        naturalHeight: { configurable: true, value: 768 },
        naturalWidth: { configurable: true, value: 512 },
      });
      capturedImage?.dispatchEvent(new Event("load"));
      await nextTick();

      await vi.advanceTimersByTimeAsync(999);
      await nextTick();
      expect(
        host.querySelector('[data-test="try-on-captured-image"]'),
      ).not.toBeNull();
      expect(
        host.querySelector('[data-test="try-on-result-image"]'),
      ).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      await nextTick();
      expect(
        host.querySelector('[data-test="try-on-captured-image"]'),
      ).toBeNull();
      expect(
        host.querySelector('[data-test="try-on-result-image"]'),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("在捕获和生成期间保持同一公开图像展示面显示真实捕获帧", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    openAttemptMock.mockImplementation((_connection, input, onEvent) => {
      emit = (next) =>
        onEvent(
          { ...next, payload: { ...next.payload, attemptId: input.attemptId } },
          {
            attemptId: input.attemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          },
        );
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
    if (!emit) throw new Error("预期收到原生试衣事件回调");

    emit(event("vision.try_on.attempt.accepted", { attemptId }));
    emit(acquisition());
    await nextTick();
    expect(
      host.querySelector<HTMLImageElement>(
        '[data-test="try-on-acquisition-preview"]',
      )?.src,
    ).toContain("/v2/try-on/acquisition/preview.mjpeg?token=preview-token");
    emit(captured());
    await nextTick();
    expect(
      host.querySelector<HTMLImageElement>(
        '[data-test="try-on-captured-image"]',
      )?.src,
    ).toContain("/v2/try-on/captured/frame.png?token=captured-token");
    const capturedImage = host.querySelector<HTMLImageElement>(
      '[data-test="try-on-captured-image"]',
    );
    expect(capturedImage?.getAttribute("data-image-state")).toBe("loading");
    Object.defineProperties(capturedImage!, {
      naturalHeight: { configurable: true, value: 768 },
      naturalWidth: { configurable: true, value: 512 },
    });
    capturedImage?.dispatchEvent(new Event("load"));
    await nextTick();
    expect(capturedImage?.getAttribute("data-image-state")).toBe("ready");

    emit(
      event("vision.try_on.attempt.generating", {
        attemptId,
        stage: "generating",
      }),
    );
    await nextTick();
    expect(
      host.querySelector<HTMLImageElement>(
        '[data-test="try-on-captured-image"]',
      )?.src,
    ).toContain("/v2/try-on/captured/frame.png?token=captured-token");
  });

  it("捕获帧无法加载时说明可恢复路径，并在新尝试的资源引用到达后恢复展示", async () => {
    const callbacks: Array<(next: VisionTryOnAttemptEvent) => void> = [];
    openAttemptMock.mockImplementation((_connection, input, onEvent) => {
      callbacks.push((next) =>
        onEvent(
          { ...next, payload: { ...next.payload, attemptId: input.attemptId } },
          {
            attemptId: input.attemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          },
        ),
      );
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

    callbacks[0]?.(event("vision.try_on.attempt.accepted", { attemptId }));
    callbacks[0]?.(acquisition());
    callbacks[0]?.(captured());
    await nextTick();
    host
      .querySelector('[data-test="try-on-captured-image"]')
      ?.dispatchEvent(new Event("error"));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-captured-image"]'),
    ).toBeNull();
    expect(useTryOnStore().phase).toBe("failed");
    expect(host.querySelector('[data-test="try-on-failure"]')).not.toBeNull();
    host
      .querySelector('[data-test="try-on-retry"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledTimes(2);
    });
    callbacks[1]?.(event("vision.try_on.attempt.accepted", { attemptId }));
    callbacks[1]?.(acquisition());
    callbacks[1]?.(captured(attemptId, "replacement-captured-token"));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-captured-error"]'),
    ).toBeNull();
    expect(
      host.querySelector<HTMLImageElement>(
        '[data-test="try-on-captured-image"]',
      )?.src,
    ).toContain("replacement-captured-token");
    expect(
      host
        .querySelector('[data-test="try-on-captured-image"]')
        ?.getAttribute("data-image-state"),
    ).toBe("loading");
  });

  it("完成结果持有连接断开后隐藏不可读结果并显示明确提示", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    let completedResourceOwnerLost: (() => void) | undefined;
    let emittedAttemptId = attemptId;
    openAttemptMock.mockImplementation(
      (_connection, input, onEvent, _signal, onOwnerLost) => {
        emittedAttemptId = input.attemptId;
        emit = (next) =>
          onEvent(
            {
              ...next,
              payload: { ...next.payload, attemptId: input.attemptId },
            },
            {
              attemptId: input.attemptId,
              visionSocketUrl: "ws://127.0.0.1:7892/ws",
            },
          );
        completedResourceOwnerLost = () =>
          onOwnerLost({
            attemptId: input.attemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          });
        return Promise.resolve({
          close: vi.fn(),
          capture: vi.fn(),
          cancel: vi.fn(),
        });
      },
    );
    const host = await mount();
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledOnce();
    });
    if (!emit) throw new Error("预期收到原生试衣事件回调");

    emit(event("vision.try_on.attempt.accepted", { attemptId }));
    emit(acquisition());
    emit(captured());
    await nextTick();
    await confirmCapturedImageDisplayed(host);
    emit(
      event("vision.try_on.attempt.generating", {
        attemptId,
        stage: "generating",
      }),
    );
    emit(completed(emittedAttemptId));
    await nextTick();
    expect(
      host.querySelector('[data-test="try-on-result-image"]'),
    ).not.toBeNull();

    if (!completedResourceOwnerLost)
      throw new Error("预期收到完成结果持有连接丢失回调");
    completedResourceOwnerLost();
    emit(completed(emittedAttemptId));
    await nextTick();

    expect(host.querySelector('[data-test="try-on-result-image"]')).toBeNull();
    expect(useTryOnStore().phase).toBe("completed");
    expect(
      host.querySelector('[data-test="try-on-result-error"]')?.textContent,
    ).toContain("结果连接已断开");
    expect(host.querySelector('[data-test="try-on-retry"]')).not.toBeNull();
  });

  it("超时后提供可重试和返回商品的恢复路径", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    openAttemptMock.mockImplementation((_connection, _input, onEvent) => {
      const localAttemptId = _input.attemptId;
      emit = (next) =>
        onEvent(
          { ...next, payload: { ...next.payload, attemptId: localAttemptId } },
          {
            attemptId: localAttemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          },
        );
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

  it("失败状态支持重试并在返回商品时取消活动尝试", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    const cancel = vi.fn(() => true);
    openAttemptMock.mockImplementation((_connection, _input, onEvent) => {
      const localAttemptId = _input.attemptId;
      emit = (next) =>
        onEvent(
          { ...next, payload: { ...next.payload, attemptId: localAttemptId } },
          {
            attemptId: localAttemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          },
        );
      return Promise.resolve({ close: vi.fn(), capture: vi.fn(), cancel });
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledOnce();
    });
    if (!emit) throw new Error("预期收到原生试衣事件回调");

    emit(
      event("vision.try_on.attempt.failed", {
        attemptId,
        reason: "try_on_failed",
      }),
    );
    await nextTick();
    expect(host.querySelector('[data-test="try-on-retry"]')).not.toBeNull();

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
    expect(cancel).toHaveBeenCalledWith("route_leave");
  });

  it("取消按钮向当前尝试提交顾客取消", async () => {
    const cancel = vi.fn(() => true);
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel,
    });
    const host = await mount();
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledOnce();
    });

    host
      .querySelector('[data-test="try-on-cancel"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    expect(cancel).toHaveBeenCalledWith("user");
    expect(useTryOnStore().phase).toBe("canceled");
  });

  it("路由离开时取消仍在运行的尝试", async () => {
    const cancel = vi.fn(() => true);
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel,
    });
    await mount();
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledOnce();
    });

    mountedApp?.unmount();
    mountedApp = null;

    expect(cancel).toHaveBeenCalledWith("route_leave");
  });

  it("顾客离场会通过既有导航接口自动返回商品", async () => {
    let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
    openAttemptMock.mockImplementation((_connection, _input, onEvent) => {
      const localAttemptId = _input.attemptId;
      emit = (next) =>
        onEvent(
          { ...next, payload: { ...next.payload, attemptId: localAttemptId } },
          {
            attemptId: localAttemptId,
            visionSocketUrl: "ws://127.0.0.1:7892/ws",
          },
        );
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      });
    });
    await mount();
    await vi.waitFor(() => {
      expect(openAttemptMock).toHaveBeenCalledOnce();
    });
    if (!emit) throw new Error("预期收到原生试衣事件回调");

    emit(
      event("vision.try_on.attempt.canceled", {
        attemptId,
        reason: "departure",
      }),
    );
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
    const catalog = useCatalogStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    await store.start();
    const activeAttemptId = store.attemptId!;
    const context = {
      attemptId: activeAttemptId,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(
      activeAttemptId,
      event("vision.try_on.attempt.accepted", {
        attemptId: activeAttemptId,
      }),
      context,
    );
    store.applyEvent(
      activeAttemptId,
      acquisition(3_000, activeAttemptId),
      context,
    );
    store.applyEvent(activeAttemptId, captured(activeAttemptId), context);
    const capturedReference = store.captured?.reference;
    if (!capturedReference) throw new Error("预期存在已验证的捕获帧");
    vi.useFakeTimers();
    store.reportCapturedImageLoad(capturedReference);
    await vi.advanceTimersByTimeAsync(MIN_CAPTURED_FRAME_VISIBLE_MS);
    vi.useRealTimers();
    store.applyEvent(
      activeAttemptId,
      event("vision.try_on.attempt.generating", {
        attemptId: activeAttemptId,
        stage: "generating",
      }),
      context,
    );
    store.applyEvent(activeAttemptId, completed(activeAttemptId), context);
    openAdjustMock.mockResolvedValue({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(activeAttemptId).payload.result,
    });
    const host = await mount();

    host
      .querySelector('[data-test="try-on-scale-up"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(openAdjustMock).toHaveBeenCalledOnce();
    });
    expect(openAdjustMock).toHaveBeenCalledWith(
      expect.anything(),
      { attemptId: activeAttemptId, garmentScale: 1.05 },
      expect.any(AbortSignal),
    );
    await nextTick();
    expect(
      host
        .querySelector('[data-test="try-on-scale-value"]')
        ?.textContent?.trim(),
    ).toBe("105%");
  });
});
