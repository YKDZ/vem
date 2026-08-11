import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSaleViewMock, refreshCatalogMock, openFastMock, openAiMock } =
  vi.hoisted(() => ({
    getSaleViewMock: vi.fn(),
    refreshCatalogMock: vi.fn(),
    openFastMock: vi.fn(),
    openAiMock: vi.fn(),
  }));

vi.mock("@/daemon/client", () => ({
  daemonClient: {
    getSaleView: getSaleViewMock,
    refreshCatalog: refreshCatalogMock,
  },
}));

vi.mock("@/native/vision", () => ({
  openVisionFastAttempt: openFastMock,
  openVisionTryOnAttempt: openAiMock,
}));

import { useCatalogStore } from "./catalog";
import { useTryOnStore } from "./try-on";
import { useVisionStore } from "./vision";

const productId = "550e8400-e29b-41d4-a716-446655440128";
const variantId = "550e8400-e29b-41d4-a716-446655440125";

function saleView(template: string | null) {
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
        productName: "定制上衣",
        productDescription: null,
        coverImageUrl: null,
        tryOnGarmentMedia: template
          ? {
              id: "550e8400-e29b-41d4-a716-446655440126",
              reference:
                "/api/media-assets/550e8400-e29b-41d4-a716-446655440126/content",
              digest: `sha256:${"a".repeat(64)}`,
              contentType: "image/png",
              byteSize: 2048,
              purpose: "try_on_garment",
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
        slotSalesState: "sale_ready",
      },
    ],
    source: "backend",
    planogramVersion: "PLAN-1",
    lastUpdatedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("try-on store current catalog boundary", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    refreshCatalogMock.mockResolvedValue(undefined);
    openFastMock.mockResolvedValue({ close: vi.fn() });
    useVisionStore().applyVisionReady({
      serverName: "vision",
      serverVersion: "1",
      schemaVersion: "vem-vision-v2-contract-bundle/v1",
      bundleVersion: "1",
      contractDigest: "a".repeat(64),
      cameraReady: true,
      fastReady: true,
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["try_on_fast"],
    });
  });

  it("does not reuse a route snapshot after its active association is withdrawn", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const selected = catalog.saleableVariantItemFor(
      `product:${productId}`,
      variantId,
    );
    expect(selected).not.toBeNull();
    useTryOnStore().prepare(selected!);

    getSaleViewMock.mockResolvedValueOnce(saleView(null));
    await expect(useTryOnStore().startFast()).resolves.toBe(false);

    expect(openFastMock).not.toHaveBeenCalled();
    expect(useTryOnStore().phase).toBe("failed");
    expect(useTryOnStore().context).toEqual({
      catalogKey: `product:${productId}`,
      productId,
      variantId,
    });
  });

  it("resolves the current descriptor and template again for retry", async () => {
    getSaleViewMock
      .mockResolvedValueOnce(saleView("tshirt_short_sleeve"))
      .mockResolvedValueOnce(saleView("tshirt_long_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    await expect(useTryOnStore().startFast()).resolves.toBe(true);

    expect(openFastMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        variantId,
        garment: expect.objectContaining({ template: "tshirt_long_sleeve" }),
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });

  it("starts exactly one selected AI attempt without opening Fast", async () => {
    getSaleViewMock.mockResolvedValue(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    useVisionStore().aiReady = true;
    openAiMock.mockResolvedValue({
      close: vi.fn(),
      capture: vi.fn(),
      cancel: vi.fn(),
    });

    await expect(store.startAi()).resolves.toBe(true);

    expect(openAiMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "ai", variantId }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(openFastMock).not.toHaveBeenCalled();
    expect(store.mode).toBe("ai");
  });

  it("clear during a blocked daemon refresh prevents any future Vision start", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    const refresh = deferred<ReturnType<typeof saleView>>();
    getSaleViewMock.mockReturnValueOnce(refresh.promise);
    const starting = useTryOnStore().startFast();
    useTryOnStore().clear();
    refresh.resolve(saleView("tshirt_short_sleeve"));

    await expect(starting).resolves.toBe(false);
    expect(openFastMock).not.toHaveBeenCalled();
    expect(useTryOnStore().phase).toBe("idle");
    expect(useTryOnStore().attemptId).toBeNull();
  });

  it("keeps concurrent start and retry single-flight with one current Vision socket", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    const refresh = deferred<ReturnType<typeof saleView>>();
    const close = vi.fn();
    getSaleViewMock.mockReturnValueOnce(refresh.promise);
    openFastMock.mockResolvedValueOnce({ close });

    const first = useTryOnStore().startFast();
    const second = useTryOnStore().retry();
    refresh.resolve(saleView("tshirt_short_sleeve"));
    await expect(second).resolves.toBe(true);

    await expect(first).resolves.toBe(false);
    expect(openFastMock).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(useTryOnStore().phase).toBe("starting");
  });

  it("clear during Vision handshake aborts the pending operation and closes a late socket", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    useTryOnStore().prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );

    const opening = deferred<{ close: ReturnType<typeof vi.fn> }>();
    const signals: AbortSignal[] = [];
    openFastMock.mockImplementationOnce((_connection, _input, _onEvent, s) => {
      signals.push(s);
      return opening.promise;
    });
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));

    const starting = useTryOnStore().startFast();
    await vi.waitFor(() => {
      expect(openFastMock).toHaveBeenCalledTimes(1);
    });
    const close = vi.fn();
    useTryOnStore().clear();
    opening.resolve({ close });

    await expect(starting).resolves.toBe(false);
    expect(signals[0]?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(useTryOnStore().phase).toBe("idle");
  });

  it("replaces every current acquisition fact, preserves one manual intent, and removes preview before the generated result", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    let pushEvent:
      | ((event: Parameters<typeof store.applyEvent>[1]) => void)
      | undefined;
    const capture = vi.fn(() => true);
    const cancel = vi.fn(() => true);
    openFastMock.mockImplementationOnce((_connection, _input, onEvent) => {
      pushEvent = (event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({ close: vi.fn(), capture, cancel });
    });
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));

    await expect(store.startFast()).resolves.toBe(true);
    if (!pushEvent) throw new Error("expected native attempt callback");
    const attemptId = store.attemptId!;
    pushEvent(acceptedEvent(attemptId));
    pushEvent(acquiringEvent(attemptId, "no_person", false));
    expect(store.guidance).toBe("no_person");
    expect(store.occupancy).toBe("none");
    pushEvent(acquiringEvent(attemptId, "multiple_people", false));
    expect(store.guidance).toBe("multiple_people");
    expect(store.occupancy).toBe("multiple");
    pushEvent(acquiringEvent(attemptId, "hold_still", true));

    expect(store.phase).toBe("acquiring");
    expect(store.previewUrl).toContain("/v2/try-on/acquisition/preview.mjpeg");
    expect(store.guidance).toBe("hold_still");
    expect(store.requestManualCapture()).toBe(true);
    expect(store.requestManualCapture()).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
    pushEvent(acquiringEvent(attemptId, "ready", false));
    expect(store.guidance).toBe("ready");
    expect(store.manualCaptureSubmitted).toBe(true);
    expect(store.manualCaptureAllowed).toBe(false);

    pushEvent(generatingEvent(attemptId, "preparing"));
    pushEvent(generatingEvent(attemptId, "preparing"));
    pushEvent(generatingEvent(attemptId, "rendering"));
    pushEvent(generatingEvent(attemptId, "preparing"));
    expect(store.phase).toBe("generating");
    expect(store.previewUrl).toBeNull();
    expect(store.generationStage).toBe("rendering");
    expect(store.requestManualCapture()).toBe(false);
    pushEvent(completedEvent(attemptId));

    expect(store.phase).toBe("completed");
    expect(store.result?.reference).toContain(
      `/v2/try-on/results/${attemptId}`,
    );
    expect(store.previewUrl).toBeNull();
  });

  it("fails safely without projecting a cross-origin acquisition preview", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    let pushEvent:
      | ((event: Parameters<typeof store.applyEvent>[1]) => void)
      | undefined;
    openFastMock.mockImplementationOnce((_connection, _input, onEvent) => {
      pushEvent = (event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      });
    });
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    await store.startFast();
    if (!pushEvent) throw new Error("expected Vision event boundary");
    const attemptId = store.attemptId!;
    pushEvent(acceptedEvent(attemptId));
    const unsafe = acquiringEvent(attemptId, "hold_still", true);
    unsafe.payload.preview.reference =
      "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token";
    pushEvent(unsafe);
    expect(store.phase).toBe("failed");
    expect(store.previewUrl).toBeNull();
  });

  it("fences an old socket after retry and binds the new preview to its new socket context", async () => {
    getSaleViewMock.mockResolvedValue(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    const callbacks: Array<
      (event: Parameters<typeof store.applyEvent>[1]) => void
    > = [];
    openFastMock.mockImplementationOnce((_connection, _input, onEvent) => {
      callbacks.push((event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        }),
      );
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(() => true),
      });
    });
    openFastMock.mockImplementationOnce((_connection, _input, onEvent) => {
      callbacks.push((event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://[::1]:7892/ws",
        }),
      );
      return Promise.resolve({
        close: vi.fn(),
        capture: vi.fn(),
        cancel: vi.fn(),
      });
    });

    await store.startFast();
    const oldAttemptId = store.attemptId!;
    store.cancelCurrentAttempt();
    await store.retry();
    const currentAttemptId = store.attemptId!;
    callbacks[0]?.(acquiringEvent(oldAttemptId, "hold_still", true));
    expect(store.attemptId).toBe(currentAttemptId);
    expect(store.phase).toBe("starting");
    const fresh = acquiringEvent(currentAttemptId, "hold_still", true);
    fresh.payload.preview.reference =
      "http://[::1]:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token";
    callbacks[1]?.(acceptedEvent(currentAttemptId));
    callbacks[1]?.(fresh);
    expect(store.phase).toBe("acquiring");
    expect(store.previewUrl).toBe(fresh.payload.preview.reference);
  });

  it("does not send manual capture for no-person, multiple-person, or late acquisition guidance", async () => {
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    const catalog = useCatalogStore();
    await catalog.refresh();
    const store = useTryOnStore();
    store.prepare(
      catalog.saleableVariantItemFor(`product:${productId}`, variantId)!,
    );
    let pushEvent:
      | ((event: Parameters<typeof store.applyEvent>[1]) => void)
      | undefined;
    const capture = vi.fn(() => true);
    openFastMock.mockImplementationOnce((_connection, _input, onEvent) => {
      pushEvent = (event) =>
        onEvent(event, {
          attemptId: event.payload.attemptId,
          visionSocketUrl: "ws://127.0.0.1:7892/ws",
        });
      return Promise.resolve({ close: vi.fn(), capture, cancel: vi.fn() });
    });
    getSaleViewMock.mockResolvedValueOnce(saleView("tshirt_short_sleeve"));
    await store.startFast();
    if (!pushEvent) throw new Error("expected native attempt callback");
    const attemptId = store.attemptId!;

    pushEvent(acceptedEvent(attemptId));
    pushEvent(acquiringEvent(attemptId, "no_person", false));
    expect(store.requestManualCapture()).toBe(false);
    pushEvent(acquiringEvent(attemptId, "multiple_people", false));
    expect(store.requestManualCapture()).toBe(false);
    pushEvent(generatingEvent(attemptId, "rendering"));
    pushEvent(acquiringEvent(attemptId, "hold_still", true));
    expect(store.requestManualCapture()).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it("accepts only the strict attempt lifecycle while retaining repeated acquisition truth and fencing late terminals", () => {
    const store = useTryOnStore();
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    const resultContext = {
      attemptId,
      visionSocketUrl: "ws://127.0.0.1:7892/ws",
    };
    store.attemptId = attemptId;
    store.phase = "starting";

    store.applyEvent(
      attemptId,
      generatingEvent(attemptId, "preparing"),
      resultContext,
    );
    store.applyEvent(attemptId, completedEvent(attemptId), resultContext);
    expect(store.phase).toBe("starting");

    store.applyEvent(attemptId, acceptedEvent(attemptId), resultContext);
    store.applyEvent(
      attemptId,
      generatingEvent(attemptId, "preparing"),
      resultContext,
    );
    store.applyEvent(attemptId, completedEvent(attemptId), resultContext);
    expect(store.phase).toBe("accepted");

    store.applyEvent(
      attemptId,
      acquiringEvent(attemptId, "hold_still", true),
      resultContext,
    );
    store.manualCaptureSubmitted = true;
    store.applyEvent(
      attemptId,
      acquiringEvent(attemptId, "ready", true),
      resultContext,
    );
    expect(store.phase).toBe("acquiring");
    expect(store.guidance).toBe("ready");
    expect(store.manualCaptureSubmitted).toBe(true);
    expect(store.manualCaptureAllowed).toBe(false);

    store.applyEvent(attemptId, completedEvent(attemptId), resultContext);
    expect(store.phase).toBe("acquiring");
    store.applyEvent(
      attemptId,
      generatingEvent(attemptId, "preparing"),
      resultContext,
    );
    store.applyEvent(
      attemptId,
      generatingEvent(attemptId, "rendering"),
      resultContext,
    );
    store.applyEvent(
      attemptId,
      generatingEvent(attemptId, "preparing"),
      resultContext,
    );
    store.applyEvent(attemptId, completedEvent(attemptId), resultContext);
    expect(store.phase).toBe("completed");
    expect(store.generationStage).toBeNull();

    store.applyEvent(
      attemptId,
      failedEvent(attemptId, "fast_failed"),
      resultContext,
    );
    expect(store.phase).toBe("completed");
  });
});

function acceptedEvent(attemptId: string) {
  return {
    type: "vision.try_on.attempt.accepted",
    payload: { attemptId },
  } as Parameters<ReturnType<typeof useTryOnStore>["applyEvent"]>[1];
}

function acquiringEvent(
  attemptId: string,
  guidance: "no_person" | "multiple_people" | "align" | "hold_still" | "ready",
  manualCaptureAllowed: boolean,
): Extract<
  Parameters<ReturnType<typeof useTryOnStore>["applyEvent"]>[1],
  { type: "vision.try_on.attempt.acquiring" }
> {
  const occupancy =
    guidance === "no_person"
      ? "none"
      : guidance === "multiple_people"
        ? "multiple"
        : "single";
  return {
    type: "vision.try_on.attempt.acquiring",
    payload: {
      attemptId,
      preview: {
        reference:
          "http://127.0.0.1:7892/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
        streamType: "mjpeg",
      },
      occupancy,
      guidance,
      manualCaptureAllowed,
    },
  } as Extract<
    Parameters<ReturnType<typeof useTryOnStore>["applyEvent"]>[1],
    { type: "vision.try_on.attempt.acquiring" }
  >;
}

function generatingEvent(attemptId: string, stage: "preparing" | "rendering") {
  return {
    type: "vision.try_on.attempt.generating",
    payload: { attemptId, stage },
  } as Parameters<ReturnType<typeof useTryOnStore>["applyEvent"]>[1];
}

function completedEvent(attemptId: string) {
  return {
    type: "vision.try_on.attempt.completed",
    payload: {
      attemptId,
      result: {
        reference: `http://127.0.0.1:7892/v2/try-on/results/${attemptId}?token=result-token`,
        digest: `sha256:${"a".repeat(64)}`,
        contentType: "image/png",
        byteSize: 2048,
        width: 512,
        height: 768,
      },
    },
  } as Parameters<ReturnType<typeof useTryOnStore>["applyEvent"]>[1];
}

function failedEvent(attemptId: string, reason: "fast_failed") {
  return {
    type: "vision.try_on.attempt.failed",
    payload: { attemptId, reason },
  } as Parameters<ReturnType<typeof useTryOnStore>["applyEvent"]>[1];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
