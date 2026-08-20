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
    expect(store.previewUrl).toBeNull();

    store.applyEvent(firstAttemptId, completed(firstAttemptId), context);
    expect(store.phase).toBe("captured");
    store.applyEvent(firstAttemptId, generating(firstAttemptId), context);
    store.applyEvent(firstAttemptId, completed(firstAttemptId), context);
    expect(store.phase).toBe("completed");
    expect(store.result?.reference).toContain(`/results/${firstAttemptId}`);
  });

  it("submits manual capture once and rejects cross-origin current-attempt resources", async () => {
    const store = useTryOnStore();
    const capture = vi.fn(() => true);
    store.attemptId = firstAttemptId;
    store.phase = "acquiring";
    store.manualCaptureAllowed = true;
    // Start the operation through its public seam so the capture owner exists.
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

  it("fences an old attempt after retry and sends absolute garment-scale adjustments", async () => {
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
    await store.retry();
    const currentAttempt = store.attemptId!;
    callbacks[0]?.(accepted(oldAttempt));
    expect(store.attemptId).toBe(currentAttempt);
    callbacks[1]?.(accepted(currentAttempt));
    callbacks[1]?.(acquiring(currentAttempt));
    callbacks[1]?.(captured(currentAttempt));
    callbacks[1]?.(generating(currentAttempt));
    callbacks[1]?.(completed(currentAttempt));
    expect(store.phase).toBe("completed");

    openAdjustMock.mockResolvedValue({
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
      result: completed(currentAttempt).payload.result,
    });
    await expect(store.requestGarmentScale(1.05)).resolves.toBe(true);
    expect(openAdjustMock).toHaveBeenCalledWith(expect.anything(), {
      attemptId: currentAttempt,
      garmentScale: 1.05,
    });
  });
});
