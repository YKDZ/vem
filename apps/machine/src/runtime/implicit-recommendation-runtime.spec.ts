// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TransactionSnapshot } from "@/daemon/schemas";
import type { MachineSaleViewItem } from "@/types/catalog";

import { resetStableVisionPresenceSessionForTests } from "@/composables/stable-vision-presence-session";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useImplicitRecommendationStore } from "@/stores/implicit-recommendation";
import { useVisionStore } from "@/stores/vision";

import { installImplicitRecommendationRuntime } from "./implicit-recommendation-runtime";

vi.mock("@/router/transaction-route-authority", () => ({
  installedMachineRuntimeTrace: () => null,
  submitMachineNavigationIntent: vi.fn(),
}));

function catalogItem(): MachineSaleViewItem {
  return {
    machineCode: "VEM-TEST",
    slotId: "slot-m",
    slotDisplayLabel: "R7C1",
    rowNo: 7,
    cellNo: 1,
    inventoryId: "inventory-m",
    variantId: "variant-m",
    productId: "product-cn",
    productName: "中文尺码 T恤",
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: "T恤",
    sku: "SKU-M",
    size: "中码",
    color: "白色",
    priceCents: 5_900,
    capacity: 8,
    parLevel: 6,
    physicalStock: 3,
    saleableStock: 3,
    slotSalesState: "sale_ready",
    productSortOrder: 1,
    targetGender: null,
  } as MachineSaleViewItem;
}

function observe(
  eventId: string,
  occupancy: "single" | "multiple" | "none",
): void {
  const personPresent = occupancy !== "none";
  useVisionStore().applyPresenceStatus({
    source: "top",
    eventId,
    detectedAt: "2026-08-24T15:00:00.000Z",
    state: personPresent ? "approach" : "empty",
    reason: personPresent ? "person_present_but_not_close" : "no_person",
    personPresent,
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: { present: personPresent },
    occupancy: { state: occupancy, confidence: 0.91 },
  });
}

function successfulVendTransaction(): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440100",
    orderNo: "ORD-RECOMMENDATION-001",
    productSummary: null,
    paymentId: "550e8400-e29b-41d4-a716-446655440101",
    paymentNo: "PAY-RECOMMENDATION-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "fulfilled",
    totalAmountCents: 5_900,
    vending: {
      commandId: "550e8400-e29b-41d4-a716-446655440102",
      commandNo: "CMD-RECOMMENDATION-001",
      status: "succeeded",
      lastError: null,
      pickupReminder: null,
    },
    nextAction: "success",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-08-24T15:10:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-08-24T15:01:00.000Z",
  } as TransactionSnapshot;
}

describe("implicit recommendation runtime", () => {
  let close: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    resetStableVisionPresenceSessionForTests();
    useCatalogStore().applySnapshot({
      items: [catalogItem()],
      source: "test",
      planogramVersion: "planogram-1",
      lastUpdatedAt: "2026-08-24T15:00:00.000Z",
    });
    close = installImplicitRecommendationRuntime().close;
  });

  afterEach(() => {
    close?.();
    close = null;
    resetStableVisionPresenceSessionForTests();
    vi.useRealTimers();
  });

  it("projects the sole stable occupancy facts without independent debounce", async () => {
    const recommendation = useImplicitRecommendationStore();

    observe("single-transient", "single");
    await vi.advanceTimersByTimeAsync(999);
    expect(recommendation.projection.banner).toBe("hidden");

    await vi.advanceTimersByTimeAsync(1);
    expect(recommendation.projection).toMatchObject({
      banner: "active",
      canonicalSize: "M",
      sessionId: "presence-1",
    });

    observe("multiple", "multiple");
    await vi.advanceTimersByTimeAsync(999);
    expect(recommendation.projection.banner).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    expect(recommendation.projection).toMatchObject({
      banner: "multiple",
      canonicalSize: "M",
      sessionId: "presence-1",
    });

    observe("single-again", "single");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recommendation.projection).toMatchObject({
      banner: "active",
      canonicalSize: "M",
      sessionId: "presence-1",
    });

    observe("absent", "none");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(recommendation.projection.banner).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    expect(recommendation.projection.banner).toBe("hidden");
    expect(recommendation.session.sessionId).toBeNull();
  });

  it("freezes an established recommendation while Vision is unavailable", async () => {
    observe("single", "single");
    await vi.advanceTimersByTimeAsync(1_000);
    useVisionStore().applyStatus({
      enabled: true,
      online: false,
      message: "Vision unavailable",
      latestDiagnosticPayload: null,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(useImplicitRecommendationStore().projection).toMatchObject({
      banner: "active",
      canonicalSize: "M",
      sessionId: "presence-1",
    });
  });

  it("clears only manual size choices after one successful vend", async () => {
    observe("single", "single");
    await vi.advanceTimersByTimeAsync(1_000);
    const recommendation = useImplicitRecommendationStore();
    recommendation.selectManualSize("product:product-cn", "中码");
    recommendation.selectColor("product:product-cn", "白色");

    useCheckoutStore().applyTransaction(successfulVendTransaction());
    expect(
      recommendation.projection.products["product:product-cn"],
    ).toMatchObject({
      recommendedSize: "M",
      selectedSize: "中码",
      selectedColor: "白色",
      manualSizeSelected: false,
    });

    recommendation.selectManualSize("product:product-cn", "中码");
    useCheckoutStore().applyTransaction({
      ...successfulVendTransaction(),
      updatedAt: "2026-08-24T15:01:01.000Z",
    });
    expect(
      recommendation.projection.products["product:product-cn"]
        ?.manualSizeSelected,
    ).toBe(true);
  });
});
