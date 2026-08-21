import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSaleViewMock, refreshCatalogMock, openAttemptMock, openAdjustMock } =
  vi.hoisted(() => ({
    getSaleViewMock: vi.fn(),
    refreshCatalogMock: vi.fn(),
    openAttemptMock: vi.fn(),
    openAdjustMock: vi.fn(),
  }));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleView: getSaleViewMock,
    refreshCatalog: refreshCatalogMock,
  },
}));
vi.mock("@/native/vision", () => ({
  openVisionTryOnAttempt: openAttemptMock,
  openVisionGarmentAdjustment: openAdjustMock,
}));

import type { VisionTryOnAttemptEvent } from "@/native/vision";

import { useCatalogStore } from "./catalog";
import { useTryOnStore } from "./try-on";
import { useVisionStore } from "./vision";

const productId = "550e8400-e29b-41d4-a716-446655440128";
const variantId = "550e8400-e29b-41d4-a716-446655440125";
const firstAttemptId = "550e8400-e29b-41d4-a716-446655440124";

function saleView(
  template:
    | "tshirt_short_sleeve"
    | "tshirt_long_sleeve"
    | null = "tshirt_short_sleeve",
) {
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
        productName: "定制上衣",
        productDescription: null,
        coverImageUrl: null,
        tryOnGarmentMedia: template
          ? {
              id: "550e8400-e29b-41d4-a716-446655440126",
              reference: "/api/media-assets/garment/content",
              digest: `sha256:${"a".repeat(64)}`,
              contentType: "image/png" as const,
              byteSize: 2048,
              purpose: "try_on_garment" as const,
              revision: {
                catalogRevision: "catalog-2",
                assetRevision: "asset-2",
              },
            }
          : null,
        tryOnGarmentReadyUrl: template
          ? `http://127.0.0.1:65000/media/sha256:${"a".repeat(64)}?grant=abcdefghijklmnop`
          : null,
        tryOnGarmentTemplate: template,
        categoryId: null,
        categoryName: "自定义分类",
        sku: "CUSTOM-1",
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

function accepted(attemptId: string): VisionTryOnAttemptEvent {
  return event("vision.try_on.attempt.accepted", { attemptId });
}

function acquiring(attemptId: string, guidance = "counting_down") {
  const isCountdown = guidance === "counting_down";
  return event("vision.try_on.attempt.acquiring", {
    attemptId,
    preview: {
      reference:
        "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
      streamType: "mjpeg",
    },
    occupancy: isCountdown ? "single" : "none",
    guidance,
    manualCaptureAllowed: isCountdown,
    ...(isCountdown ? { holdRemainingMs: 1_200 } : {}),
  });
}

function captured(attemptId: string): VisionTryOnAttemptEvent {
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

function generating(
  attemptId: string,
  stage = "generating",
): VisionTryOnAttemptEvent {
  return event("vision.try_on.attempt.generating", { attemptId, stage });
}

function completed(
  attemptId: string,
): Extract<
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

function captureStoreAttempt(
  store: ReturnType<typeof useTryOnStore>,
  attemptId = firstAttemptId,
) {
  const context = {
    attemptId,
    visionSocketUrl: "ws://127.0.0.1:7892/ws",
  };
  store.attemptId = attemptId;
  store.phase = "starting";
  store.applyEvent(attemptId, accepted(attemptId), context);
  store.applyEvent(attemptId, acquiring(attemptId), context);
  store.applyEvent(attemptId, captured(attemptId), context);
  expect(store.captured?.frameId).toBe("front-42");
  return context;
}

async function startCompletedStoreAttempt(close = vi.fn()) {
  const catalog = useCatalogStore();
  let emit: ((next: VisionTryOnAttemptEvent) => void) | undefined;
  let completedResourceOwnerLost: (() => void) | undefined;
  openAttemptMock.mockImplementationOnce(
    (_connection, input, onEvent, _signal, onOwnerLost) => {
      const resultContext = {
        attemptId: input.attemptId,
        visionSocketUrl: "ws://127.0.0.1:7892/ws",
      };
      emit = (next) => onEvent(next, resultContext);
      completedResourceOwnerLost = () => onOwnerLost(resultContext);
      return Promise.resolve({ close, capture: vi.fn(), cancel: vi.fn() });
    },
  );
  const store = useTryOnStore();
  store.prepare(
    catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
  );
  await store.start();
  const activeAttemptId = store.attemptId!;
  if (!emit || !completedResourceOwnerLost) {
    throw new Error("预期收到原生试衣事件和完成结果持有连接回调");
  }
  emit(accepted(activeAttemptId));
  emit(acquiring(activeAttemptId));
  emit(captured(activeAttemptId));
  emit(generating(activeAttemptId));
  emit(completed(activeAttemptId));
  return {
    activeAttemptId,
    close,
    completedResourceOwnerLost,
    emit,
    store,
  };
}

describe("try-on store catalog boundary", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    refreshCatalogMock.mockResolvedValue(undefined);
    getSaleViewMock.mockResolvedValue(saleView());
    useVisionStore().applyVisionReady(ready());
  });

  it("refreshes the current sale view before opening the only public native attempt", async () => {
    getSaleViewMock
      .mockResolvedValueOnce(saleView("tshirt_short_sleeve"))
      .mockResolvedValueOnce(saleView("tshirt_long_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });

    await expect(store.start()).resolves.toBe(true);
    expect(openAttemptMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        variantId,
        garment: expect.objectContaining({ template: "tshirt_long_sleeve" }),
      }),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("fails without opening Vision when the current catalog association is withdrawn", async () => {
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    getSaleViewMock.mockResolvedValueOnce(saleView(null));

    await expect(store.start()).resolves.toBe(false);
    expect(openAttemptMock).not.toHaveBeenCalled();
    expect(store.phase).toBe("failed");
    expect(store.failureReason).toBe("try_on_unavailable");
  });
});

describe("try-on store lifecycle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    getSaleViewMock.mockResolvedValue(saleView());
    useCatalogStore().applySnapshot(saleView());
    useVisionStore().applyVisionReady(ready());
  });

  it("preserves acquisition facts, captures the signed identity, and completes only after generating", async () => {
    const store = useTryOnStore();
    store.attemptId = firstAttemptId;
    store.phase = "starting";
    const context = {
      attemptId: firstAttemptId,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };

    store.applyEvent(firstAttemptId, accepted(firstAttemptId), context);
    store.applyEvent(firstAttemptId, acquiring(firstAttemptId), context);
    expect(store.phase).toBe("acquiring");
    expect(store.previewUrl).toContain("preview.mjpeg");
    expect(store.manualCaptureAllowed).toBe(true);

    store.applyEvent(firstAttemptId, captured(firstAttemptId), context);
    expect(store.phase).toBe("captured");
    expect(store.captured?.frameId).toBe("front-42");
    expect(store.previewUrl).toContain("preview.mjpeg");

    store.applyEvent(firstAttemptId, completed(firstAttemptId), context);
    expect(store.phase).toBe("captured");
    store.applyEvent(firstAttemptId, generating(firstAttemptId), context);
    store.applyEvent(firstAttemptId, completed(firstAttemptId), context);
    expect(store.phase).toBe("completed");
    expect(store.result?.reference).toContain(`/results/${firstAttemptId}`);
  });

  it.each([
    ["失败", "vision.try_on.attempt.failed", { reason: "try_on_failed" }],
    ["取消", "vision.try_on.attempt.canceled", { reason: "timeout" }],
  ] as const)("%s终态会清理捕获帧", (_name, type, terminalPayload) => {
    const store = useTryOnStore();
    const context = captureStoreAttempt(store);

    store.applyEvent(
      firstAttemptId,
      event(type, { attemptId: firstAttemptId, ...terminalPayload }),
      context,
    );

    expect(store.captured).toBeNull();
  });

  it("显式清理、重试和替换尝试都会丢弃旧捕获帧", async () => {
    const catalog = useCatalogStore();
    const item = catalog.saleableVariantItemFor(
      `product:${productId}`,
      variantId,
    )!;
    const store = useTryOnStore();
    store.prepare(item);
    captureStoreAttempt(store);
    store.clear();
    expect(store.captured).toBeNull();

    store.prepare(item);
    captureStoreAttempt(store);
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    await store.retry();
    expect(store.captured).toBeNull();

    captureStoreAttempt(store, store.attemptId!);
    const replacedAttemptId = store.attemptId;
    await store.start();
    expect(store.attemptId).not.toBe(replacedAttemptId);
    expect(store.captured).toBeNull();
    store.clear();
  });

  it("完成结果在显式清理前持续持有原尝试资源连接", async () => {
    const { activeAttemptId, close, store } =
      await startCompletedStoreAttempt();

    expect(store.phase).toBe("completed");
    expect(store.result?.reference).toContain(`/results/${activeAttemptId}`);
    expect(close).not.toHaveBeenCalled();

    openAdjustMock.mockResolvedValue({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(activeAttemptId).payload.result,
    });
    await expect(store.requestGarmentScale(1.05)).resolves.toBe(true);
    expect(close).not.toHaveBeenCalled();

    let resolveAdjustment!: (value: unknown) => void;
    let adjustmentSignal: AbortSignal | undefined;
    openAdjustMock.mockImplementation(
      (_connection, _input, signal) =>
        new Promise((resolve) => {
          adjustmentSignal = signal;
          resolveAdjustment = resolve;
        }),
    );
    const pendingAdjustment = store.requestGarmentScale(1.1);
    await vi.waitFor(() => {
      expect(openAdjustMock).toHaveBeenCalledTimes(2);
    });
    store.clear();
    expect(adjustmentSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    resolveAdjustment({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(activeAttemptId).payload.result,
    });
    await expect(pendingAdjustment).resolves.toBe(false);
  });

  it("重试只释放旧完成态资源连接，不释放新尝试连接", async () => {
    const oldClose = vi.fn();
    const newClose = vi.fn();
    const { store } = await startCompletedStoreAttempt(oldClose);
    openAttemptMock.mockResolvedValueOnce({
      close: newClose,
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    expect(oldClose).not.toHaveBeenCalled();

    await store.retry();

    expect(oldClose).toHaveBeenCalledOnce();
    expect(newClose).not.toHaveBeenCalled();
    store.clear();
    expect(newClose).toHaveBeenCalledOnce();
  });

  it("完成结果持有连接断开后移除不可读结果且不接收迟到完成", async () => {
    const { activeAttemptId, close, completedResourceOwnerLost, emit, store } =
      await startCompletedStoreAttempt();
    let resolveAdjustment!: (value: unknown) => void;
    let adjustmentSignal: AbortSignal | undefined;
    openAdjustMock.mockImplementation(
      (_connection, _input, signal) =>
        new Promise((resolve) => {
          adjustmentSignal = signal;
          resolveAdjustment = resolve;
        }),
    );
    const pendingAdjustment = store.requestGarmentScale(1.05);
    await vi.waitFor(() => {
      expect(openAdjustMock).toHaveBeenCalledOnce();
    });
    completedResourceOwnerLost();
    emit(completed(activeAttemptId));
    expect(adjustmentSignal?.aborted).toBe(true);
    resolveAdjustment({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(activeAttemptId).payload.result,
    });
    await expect(pendingAdjustment).resolves.toBe(false);

    expect(store.phase).toBe("completed");
    expect(store.failureReason).toBeNull();
    expect(store.result).toBeNull();
    expect(store.resultUnavailable).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("捕获资源属于其他尝试时保持拒绝状态", () => {
    const store = useTryOnStore();
    store.attemptId = firstAttemptId;
    store.phase = "acquiring";
    const context = {
      attemptId: firstAttemptId,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    const lateCaptured = captured("550e8400-e29b-41d4-a716-446655440129");

    store.applyEvent(firstAttemptId, lateCaptured, context);

    expect(store.phase).toBe("acquiring");
    expect(store.captured).toBeNull();
    expect(store.previewUrl).toBeNull();
  });

  it("submits manual capture once and rejects cross-origin current-attempt resources", async () => {
    const store = useTryOnStore();
    const capture = vi.fn(() => true);
    store.attemptId = firstAttemptId;
    store.phase = "acquiring";
    store.manualCaptureAllowed = true;
    // 通过公开入口启动操作，以建立采集资源持有连接。
    const catalog = useCatalogStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture,
      cancel: vi.fn(),
    });
    await store.start();
    const currentAttempt = store.attemptId;
    const currentContext = {
      attemptId: currentAttempt,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(currentAttempt, accepted(currentAttempt), currentContext);
    store.applyEvent(currentAttempt, acquiring(currentAttempt), currentContext);
    expect(store.requestManualCapture()).toBe(true);
    expect(store.requestManualCapture()).toBe(false);
    expect(capture).toHaveBeenCalledOnce();

    const unsafe = acquiring(currentAttempt) as Extract<
      VisionTryOnAttemptEvent,
      { type: "vision.try_on.attempt.acquiring" }
    >;
    unsafe.payload.preview.reference =
      "http://127.0.0.1:7893/v2/try-on/acquisition/preview.mjpeg?token=preview-token";
    store.applyEvent(currentAttempt, unsafe, currentContext);
    expect(store.phase).toBe("failed");
    expect(store.failureReason).toBe("try_on_failed");
  });

  it("手动采集不会绕过无人、多人或未对齐资格", async () => {
    const catalog = useCatalogStore();
    const capture = vi.fn(() => true);
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture,
      cancel: vi.fn(),
    });
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    await store.start();
    const currentAttempt = store.attemptId!;
    const context = {
      attemptId: currentAttempt,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(currentAttempt, accepted(currentAttempt), context);

    for (const [occupancy, guidance] of [
      ["none", "no_person"],
      ["multiple", "multiple_people"],
      ["single", "align"],
    ] as const) {
      store.applyEvent(
        currentAttempt,
        event("vision.try_on.attempt.acquiring", {
          attemptId: currentAttempt,
          preview: {
            reference:
              "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
            streamType: "mjpeg",
          },
          occupancy,
          guidance,
          manualCaptureAllowed: true,
        }),
        context,
      );

      expect(store.requestManualCapture()).toBe(false);
    }

    expect(capture).not.toHaveBeenCalled();
  });

  it("重试后隔离旧尝试的迟到终态并发送绝对成衣缩放", async () => {
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    const callbacks: Array<(next: VisionTryOnAttemptEvent) => void> = [];
    openAttemptMock.mockImplementation((_connection, _input, onEvent) => {
      const localAttemptId = _input.attemptId;
      callbacks.push((next) =>
        onEvent(next, {
          attemptId: localAttemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        }),
      );
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(() => true),
      });
    });
    await store.start();
    const oldAttempt = store.attemptId!;
    store.cancelCurrentAttempt();
    callbacks[0]?.(completed(oldAttempt));
    expect(store.phase).toBe("canceled");
    await store.retry();
    const currentAttempt = store.attemptId!;
    callbacks[1]?.(accepted(currentAttempt));
    callbacks[1]?.(acquiring(currentAttempt));
    const currentPreview = store.previewUrl;
    callbacks[0]?.(accepted(oldAttempt));
    callbacks[0]?.(captured(oldAttempt));
    callbacks[0]?.(generating(oldAttempt));
    callbacks[0]?.(completed(oldAttempt));
    expect(store.attemptId).toBe(currentAttempt);
    expect(store.phase).toBe("acquiring");
    expect(store.previewUrl).toBe(currentPreview);
    expect(store.result).toBeNull();
    callbacks[1]?.(captured(currentAttempt));
    callbacks[1]?.(generating(currentAttempt));
    callbacks[1]?.(completed(currentAttempt));
    expect(store.phase).toBe("completed");

    openAdjustMock.mockResolvedValue({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(currentAttempt).payload.result,
    });
    await expect(store.requestGarmentScale(1.05)).resolves.toBe(true);
    expect(openAdjustMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        attemptId: currentAttempt,
        garmentScale: 1.05,
      },
      expect.any(AbortSignal),
    );
  });

  it("每次重试都将成衣缩放重置到绝对的百分之百基线", async () => {
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    await store.start();
    const activeAttemptId = store.attemptId!;
    const context = {
      attemptId: activeAttemptId,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(activeAttemptId, accepted(activeAttemptId), context);
    store.applyEvent(activeAttemptId, acquiring(activeAttemptId), context);
    store.applyEvent(activeAttemptId, captured(activeAttemptId), context);
    store.applyEvent(activeAttemptId, generating(activeAttemptId), context);
    store.applyEvent(activeAttemptId, completed(activeAttemptId), context);
    store.garmentScale = 1.6;

    await store.retry();

    expect(store.garmentScale).toBe(1);
  });

  it("只接受百分之八十至一百六十范围内绝对的百分之五成衣缩放步进", async () => {
    const catalog = useCatalogStore();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    await store.start();
    const activeAttemptId = store.attemptId!;
    const context = {
      attemptId: activeAttemptId,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(activeAttemptId, accepted(activeAttemptId), context);
    store.applyEvent(activeAttemptId, acquiring(activeAttemptId), context);
    store.applyEvent(activeAttemptId, captured(activeAttemptId), context);
    store.applyEvent(activeAttemptId, generating(activeAttemptId), context);
    store.applyEvent(activeAttemptId, completed(activeAttemptId), context);

    await expect(store.requestGarmentScale(1.03)).resolves.toBe(false);
    await expect(store.requestGarmentScale(1.65)).resolves.toBe(false);
    expect(openAdjustMock).not.toHaveBeenCalled();

    openAdjustMock.mockResolvedValue({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(activeAttemptId).payload.result,
    });
    await expect(store.requestGarmentScale(1.1)).resolves.toBe(true);
    expect(openAdjustMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { attemptId: activeAttemptId, garmentScale: 1.1 },
      expect.any(AbortSignal),
    );
  });

  it("重试后不让旧结果调整覆盖新尝试", async () => {
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    const resolveAdjustment = vi.fn();
    let adjustmentSignal: AbortSignal | undefined;
    openAdjustMock.mockImplementation(
      (_connection, _input, signal) =>
        new Promise((resolve) => {
          adjustmentSignal = signal;
          resolveAdjustment.mockImplementation(resolve);
        }),
    );
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    await store.start();
    const oldAttemptId = store.attemptId!;
    const oldContext = {
      attemptId: oldAttemptId,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(oldAttemptId, accepted(oldAttemptId), oldContext);
    store.applyEvent(oldAttemptId, acquiring(oldAttemptId), oldContext);
    store.applyEvent(oldAttemptId, captured(oldAttemptId), oldContext);
    store.applyEvent(oldAttemptId, generating(oldAttemptId), oldContext);
    store.applyEvent(oldAttemptId, completed(oldAttemptId), oldContext);

    const pendingAdjustment = store.requestGarmentScale(1.05);
    await vi.waitFor(() => {
      expect(openAdjustMock).toHaveBeenCalledOnce();
    });
    await store.retry();
    const currentAttempt = store.attemptId;
    expect(adjustmentSignal?.aborted).toBe(true);
    resolveAdjustment({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(oldAttemptId).payload.result,
    });

    await expect(pendingAdjustment).resolves.toBe(false);
    expect(store.attemptId).toBe(currentAttempt);
    expect(store.result).toBeNull();
    expect(store.garmentScale).toBe(1);
  });

  it("旧调整完成时不清除新尝试的调整状态", async () => {
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    const resolveAdjustments: Array<(value: unknown) => void> = [];
    openAdjustMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAdjustments.push(resolve);
        }),
    );
    openAttemptMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    await store.start();
    const oldAttempt = store.attemptId!;
    const oldContext = {
      attemptId: oldAttempt,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(oldAttempt, accepted(oldAttempt), oldContext);
    store.applyEvent(oldAttempt, acquiring(oldAttempt), oldContext);
    store.applyEvent(oldAttempt, captured(oldAttempt), oldContext);
    store.applyEvent(oldAttempt, generating(oldAttempt), oldContext);
    store.applyEvent(oldAttempt, completed(oldAttempt), oldContext);

    const oldAdjustment = store.requestGarmentScale(1.05);
    await vi.waitFor(() => {
      expect(openAdjustMock).toHaveBeenCalledOnce();
    });

    await store.retry();
    const newAttempt = store.attemptId!;
    const newContext = {
      attemptId: newAttempt,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.applyEvent(newAttempt, accepted(newAttempt), newContext);
    store.applyEvent(newAttempt, acquiring(newAttempt), newContext);
    store.applyEvent(newAttempt, captured(newAttempt), newContext);
    store.applyEvent(newAttempt, generating(newAttempt), newContext);
    store.applyEvent(newAttempt, completed(newAttempt), newContext);

    const newAdjustment = store.requestGarmentScale(1.1);
    await vi.waitFor(() => {
      expect(openAdjustMock).toHaveBeenCalledTimes(2);
    });
    expect(store.adjusting).toBe(true);

    resolveAdjustments[0]?.({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(oldAttempt).payload.result,
    });

    await expect(oldAdjustment).resolves.toBe(false);
    expect(store.attemptId).toBe(newAttempt);
    expect(store.adjusting).toBe(true);

    resolveAdjustments[1]?.({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(newAttempt).payload.result,
    });
    await expect(newAdjustment).resolves.toBe(true);
    expect(store.adjusting).toBe(false);
    expect(store.result).toEqual(completed(newAttempt).payload.result);
    expect(store.garmentScale).toBe(1.1);
  });
});
