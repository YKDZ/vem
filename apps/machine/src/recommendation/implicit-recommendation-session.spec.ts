import { describe, expect, it } from "vitest";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  createImplicitRecommendationState,
  normalizeRecommendationSize,
  projectImplicitRecommendation,
  transitionImplicitRecommendation,
  type ImplicitRecommendationEvent,
  type ImplicitRecommendationState,
} from "./implicit-recommendation-session";

function transition(
  state: ImplicitRecommendationState,
  event: ImplicitRecommendationEvent,
): ImplicitRecommendationState {
  return transitionImplicitRecommendation(state, event).state;
}

function startSession(
  state = createImplicitRecommendationState(),
): ImplicitRecommendationState {
  return transition(state, {
    type: "presence_observed",
    present: true,
    occupancy: "single",
    edgeId: "presence-1:arrival",
    liveProfileSequence: 2,
  });
}

function variant(variantId: string, size: string | null, saleable = true) {
  return {
    variantId,
    sku: variantId,
    size,
    color: "白色",
    priceCents: 5_900,
    capacity: 8,
    parLevel: 6,
    physicalStock: saleable ? 3 : 0,
    saleableStock: saleable ? 3 : 0,
    slotSalesState: saleable ? ("sale_ready" as const) : ("sold_out" as const),
    slotCandidates: [],
  };
}

function product(
  catalogKey: string,
  variants: ReturnType<typeof variant>[],
): MachineCatalogItem {
  const representative = variants[0] ?? variant("fallback", null, false);
  return {
    machineCode: "VEM-TEST",
    catalogKey,
    aggregatedSlotCount: 1,
    slotId: `${catalogKey}-slot`,
    slotDisplayLabel: "R7C1",
    rowNo: 7,
    cellNo: 1,
    inventoryId: `${catalogKey}-inventory`,
    variantId: representative.variantId,
    productId: catalogKey,
    productName: catalogKey,
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: "T恤",
    sku: representative.sku,
    size: representative.size,
    color: representative.color,
    priceCents: representative.priceCents,
    capacity: representative.capacity,
    parLevel: representative.parLevel,
    physicalStock: representative.physicalStock,
    saleableStock: variants.reduce(
      (total, candidate) => total + candidate.saleableStock,
      0,
    ),
    slotSalesState: variants.some(
      (candidate) => candidate.slotSalesState === "sale_ready",
    )
      ? "sale_ready"
      : "sold_out",
    productSortOrder: 10,
    targetGender: null,
    slotCandidates: [],
    variantCandidates: variants,
  } as MachineCatalogItem;
}

describe("Implicit Recommendation Session", () => {
  it.each([
    ["S", "S"],
    ["s码", "S"],
    ["小码", "S"],
    ["M", "M"],
    ["中码", "M"],
    ["L", "L"],
    ["大码", "L"],
    ["均码", null],
    ["XL", null],
    ["", null],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeRecommendationSize(input)).toBe(expected);
  });

  it("starts once with neutral M, suppresses specifics for multiple people, and ends only on confirmed departure", () => {
    const initial = createImplicitRecommendationState();
    const started = transitionImplicitRecommendation(initial, {
      type: "presence_observed",
      present: true,
      occupancy: "single",
      edgeId: "presence-1:arrival",
      liveProfileSequence: 4,
    });

    expect(started.state).toMatchObject({
      sessionId: "presence-1",
      occupancy: "single",
      canonicalSize: "M",
      refinementConsumed: false,
      liveProfileSequenceFloor: 4,
    });
    expect(started.diagnostics.map((entry) => entry.event)).toEqual([
      "session_started",
      "neutral_presented",
    ]);

    const multiple = transitionImplicitRecommendation(started.state, {
      type: "presence_observed",
      present: true,
      occupancy: "multiple",
      edgeId: "presence-1:arrival",
      liveProfileSequence: 4,
    });
    expect(multiple.state).toMatchObject({
      sessionId: "presence-1",
      occupancy: "multiple",
      canonicalSize: "M",
    });
    expect(multiple.diagnostics).toEqual([
      expect.objectContaining({ event: "multiple_suppressed" }),
    ]);

    const resumed = transition(multiple.state, {
      type: "presence_observed",
      present: true,
      occupancy: "single",
      edgeId: "presence-1:arrival",
      liveProfileSequence: 4,
    });
    expect(resumed).toMatchObject({
      sessionId: "presence-1",
      occupancy: "single",
      canonicalSize: "M",
    });

    const ended = transitionImplicitRecommendation(resumed, {
      type: "presence_observed",
      present: false,
      occupancy: "none",
      edgeId: "presence-2:departure",
      liveProfileSequence: 5,
    });
    expect(ended.state).toEqual(createImplicitRecommendationState());
    expect(ended.diagnostics).toEqual([
      expect.objectContaining({
        event: "session_ended",
        sessionId: "presence-1",
      }),
    ]);
  });

  it("accepts only one new usable live profile that has a saleable catalog target", () => {
    const started = startSession();
    const stale = transitionImplicitRecommendation(started, {
      type: "profile_received",
      sequence: 2,
      eventId: "profile-before-session",
      usable: true,
      personPresent: true,
      confidence: 0.91,
      bodyType: "slim",
      availableSizes: ["S", "M", "L"],
    });
    expect(stale.state).toMatchObject({
      canonicalSize: "M",
      refinementConsumed: false,
    });

    const unusable = transitionImplicitRecommendation(stale.state, {
      type: "profile_received",
      sequence: 3,
      eventId: "profile-unknown",
      usable: false,
      personPresent: true,
      confidence: 0.91,
      bodyType: "slim",
      availableSizes: ["S", "M", "L"],
    });
    expect(unusable.state.refinementConsumed).toBe(false);

    const unavailable = transitionImplicitRecommendation(unusable.state, {
      type: "profile_received",
      sequence: 4,
      eventId: "profile-no-target",
      usable: true,
      personPresent: true,
      confidence: 0.91,
      bodyType: "strong",
      availableSizes: ["S", "M"],
    });
    expect(unavailable.state).toMatchObject({
      canonicalSize: "M",
      refinementConsumed: false,
    });

    const refined = transitionImplicitRecommendation(unavailable.state, {
      type: "profile_received",
      sequence: 5,
      eventId: "profile-refine",
      usable: true,
      personPresent: true,
      confidence: 0.91,
      bodyType: "slim",
      availableSizes: ["S", "M", "L"],
    });
    expect(refined.state).toMatchObject({
      canonicalSize: "S",
      refinementConsumed: true,
      seenProfileEventIds: [
        "profile-before-session",
        "profile-unknown",
        "profile-no-target",
        "profile-refine",
      ],
    });
    expect(refined.diagnostics).toEqual([
      expect.objectContaining({
        event: "refined_once",
        profileEventId: "profile-refine",
        canonicalSize: "S",
      }),
    ]);

    const duplicate = transitionImplicitRecommendation(refined.state, {
      type: "profile_received",
      sequence: 6,
      eventId: "profile-refine",
      usable: true,
      personPresent: true,
      confidence: 0.91,
      bodyType: "strong",
      availableSizes: ["S", "M", "L"],
    });
    expect(duplicate.state).toBe(refined.state);
    expect(duplicate.diagnostics).toEqual([]);

    const conflicting = transitionImplicitRecommendation(refined.state, {
      type: "profile_received",
      sequence: 7,
      eventId: "profile-conflict",
      usable: true,
      personPresent: true,
      confidence: 0.91,
      bodyType: "strong",
      availableSizes: ["S", "M", "L"],
    });
    expect(conflicting.state.canonicalSize).toBe("S");
    expect(conflicting.diagnostics).toEqual([
      expect.objectContaining({
        event: "ignored_conflicting_profile",
        profileEventId: "profile-conflict",
      }),
    ]);
  });

  it("keeps per-product manual size and color ownership separate", () => {
    let state = startSession();
    state = transition(state, {
      type: "manual_size_selected",
      catalogKey: "product:a",
      size: "大码",
    });
    state = transition(state, {
      type: "color_selected",
      catalogKey: "product:a",
      color: "黑色",
    });
    state = transition(state, {
      type: "manual_size_selected",
      catalogKey: "product:b",
      size: "小码",
    });

    expect(state.manualSizes).toEqual({
      "product:a": "大码",
      "product:b": "小码",
    });
    expect(state.selectedColors).toEqual({ "product:a": "黑色" });

    state = transition(state, {
      type: "vend_succeeded",
      transactionId: "order-1",
    });
    expect(state.manualSizes).toEqual({});
    expect(state.selectedColors).toEqual({ "product:a": "黑色" });
    expect(state).toMatchObject({
      sessionId: "presence-1",
      canonicalSize: "M",
      refinementConsumed: false,
    });
  });

  it("projects truthful capability and never substitutes an unavailable target size", () => {
    const chineseProduct = product("product:cn", [
      variant("cn-s", "小码"),
      variant("cn-m", "中码"),
      variant("cn-l", "大码", false),
    ]);
    const oneSizeProduct = product("product:one", [variant("one", "均码")]);
    let state = startSession();
    state = transition(state, {
      type: "profile_received",
      sequence: 3,
      eventId: "profile-strong",
      usable: true,
      personPresent: true,
      confidence: 0.91,
      bodyType: "strong",
      availableSizes: ["S", "M", "L"],
    });

    const projection = projectImplicitRecommendation(state, [
      chineseProduct,
      oneSizeProduct,
    ]);
    expect(projection).toMatchObject({
      visible: true,
      banner: "active",
      canonicalSize: "L",
    });
    expect(projection.products["product:cn"]).toMatchObject({
      supportsSmartSizing: true,
      recommendedSize: null,
      selectedSize: null,
      unavailableCanonicalSize: "L",
    });
    expect(projection.products["product:one"]).toMatchObject({
      supportsSmartSizing: false,
      recommendedSize: null,
    });

    const noCapability = projectImplicitRecommendation(state, [oneSizeProduct]);
    expect(noCapability).toMatchObject({
      visible: false,
      banner: "hidden",
    });
  });
});
