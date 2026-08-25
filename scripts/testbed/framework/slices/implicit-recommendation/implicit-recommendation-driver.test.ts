import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ImplicitRecommendationAcceptanceAdapter,
  ImplicitRecommendationObservation,
  RecommendationDistance,
  RecommendationTraceEntry,
} from "./implicit-recommendation-driver.ts";

import { runImplicitRecommendationBusinessSet } from "./implicit-recommendation-driver.ts";

class FakeRecommendationAdapter implements ImplicitRecommendationAcceptanceAdapter {
  nowMs = Date.parse("2026-08-24T10:00:00.000Z");
  activeDistance: RecommendationDistance | null = null;
  selectedAtMs = 0;
  presentationAtMs: number | null = null;
  fixtureSwitchDelayMs = 0;
  currentSessionId: string | null = null;
  canonicalSize: "M" | "L" | null = null;
  categoryOpen = false;
  detailOpen = false;
  trace: RecommendationTraceEntry[] = [];
  nextTraceId = 1;
  calls: string[] = [];
  captures: string[] = [];
  refined = false;
  flicker = false;
  doubleRefinement = false;

  now(): number {
    return this.nowMs;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.nowMs += milliseconds;
  }

  async restoreDefaultFixtures(): Promise<void> {
    this.calls.push("restore");
    if (this.currentSessionId) {
      this.record("session_ended", this.currentSessionId, null);
    }
    this.activeDistance = null;
    this.presentationAtMs = null;
    this.currentSessionId = null;
    this.canonicalSize = null;
    this.categoryOpen = false;
    this.detailOpen = false;
  }

  async selectFieldFixtures(distance: RecommendationDistance): Promise<void> {
    this.calls.push(`select:${distance}`);
    this.activeDistance = distance;
    this.selectedAtMs = this.nowMs;
    this.presentationAtMs = this.nowMs;
    this.currentSessionId = `session-${distance}`;
    this.canonicalSize = "M";
    this.refined = false;
    this.record("session_started", this.currentSessionId, "M");
    this.record("neutral_presented", this.currentSessionId, "M");
    this.nowMs += this.fixtureSwitchDelayMs;
  }

  async navigateCatalogHome(): Promise<void> {
    this.calls.push("catalog-home");
    this.categoryOpen = false;
    this.detailOpen = false;
  }

  async openTshirtCategory(): Promise<void> {
    this.calls.push("category:tshirts");
    this.categoryOpen = true;
    this.detailOpen = false;
  }

  async openSmartSizedProduct(catalogKey: string): Promise<void> {
    this.calls.push(`product:${catalogKey}`);
    this.detailOpen = true;
  }

  async captureScreenshot(label: string): Promise<string | null> {
    this.captures.push(label);
    return `${label}.png`;
  }

  async observe(): Promise<ImplicitRecommendationObservation> {
    if (
      this.activeDistance &&
      !this.refined &&
      this.nowMs - this.selectedAtMs >= 500
    ) {
      this.refined = true;
      this.canonicalSize = "L";
      this.record("refined_once", this.currentSessionId, "L");
      if (this.doubleRefinement) {
        this.record("refined_once", this.currentSessionId, "L");
      }
    }
    const shouldFlicker =
      this.flicker &&
      this.activeDistance === "near" &&
      this.nowMs - this.selectedAtMs >= 2_000 &&
      this.nowMs - this.selectedAtMs < 2_200;
    const homeCardVisible =
      this.currentSessionId !== null &&
      !this.categoryOpen &&
      !this.detailOpen &&
      !shouldFlicker;
    const selectedSize = this.canonicalSize === "L" ? "大码" : "中码";
    return {
      observedAtMs: this.nowMs,
      presentation: {
        observedAtMs: this.presentationAtMs,
        sessionId: this.currentSessionId,
      },
      route: this.detailOpen
        ? "#/products/product:recommendation"
        : "#/catalog",
      banner: {
        visible: false,
        state: null,
        text: null,
      },
      homeCard: {
        visible: homeCardVisible,
        title: homeCardVisible ? "为你推荐" : null,
        detail: homeCardVisible ? "选一件后查看尺码" : null,
      },
      catalog: {
        visible: !this.detailOpen,
        categoryKey: this.categoryOpen ? "tshirts" : null,
        sessionId: this.currentSessionId,
        canonicalSize: this.canonicalSize,
        profileEventId: this.refined ? `profile-${this.activeDistance}` : null,
        cards: this.categoryOpen
          ? [
              {
                catalogKey: "product:recommendation",
                preferredVariantId: "variant:recommended",
                smartSizingSupported: true,
                smartSizingText: shouldFlicker
                  ? null
                  : "支持智能选码 · 进入查看",
              },
              {
                catalogKey: "product:other",
                preferredVariantId: null,
                smartSizingSupported: false,
                smartSizingText: null,
              },
            ]
          : [],
      },
      detail: this.detailOpen
        ? {
            visible: true,
            catalogKey: "product:recommendation",
            sessionId: this.currentSessionId,
            canonicalSize: this.canonicalSize,
            manualSizeSelected: false,
            recommendedText: `推荐 ${this.canonicalSize}`,
            recommendedCanonicalSize: this.canonicalSize,
            selectedSize,
            selectedSizeVisionRecommended: true,
          }
        : null,
      trace: structuredClone(this.trace),
    };
  }

  private record(
    event: RecommendationTraceEntry["event"],
    sessionId: string | null,
    canonicalSize: "S" | "M" | "L" | null,
  ): void {
    this.trace.push({
      id: this.nextTraceId++,
      event,
      sessionId,
      canonicalSize,
      profileEventId: event === "refined_once" ? "profile-live" : null,
      recordedAt: new Date(this.nowMs).toISOString(),
    });
  }
}

describe("implicit recommendation VM business driver", () => {
  it("proves two distinct real-fixture sessions through the public customer projection", async () => {
    const adapter = new FakeRecommendationAdapter();
    adapter.fixtureSwitchDelayMs = 900;

    const result = await runImplicitRecommendationBusinessSet(adapter, {
      baselineQuietMs: 1_000,
      presentationTimeoutMs: 2_000,
      stabilityMs: 10_000,
      departureTimeoutMs: 2_000,
      pollMs: 100,
    });

    assert.equal(result.assertions.length, 9);
    assert.ok(result.assertions.every((entry) => entry.status === "passed"));
    assert.deepEqual(
      result.assertions.map((entry) => entry.id),
      [
        "near.neutral-visible-within-500ms",
        "near.stable-ten-seconds",
        "near.catalog-detail-chinese-size",
        "near.departure-once",
        "far.neutral-visible-within-500ms",
        "far.stable-ten-seconds",
        "far.catalog-detail-chinese-size",
        "far.departure-once",
        "sessions.distinct",
      ],
    );
    assert.deepEqual(adapter.calls, [
      "catalog-home",
      "restore",
      "select:near",
      "category:tshirts",
      "product:product:recommendation",
      "restore",
      "catalog-home",
      "select:far",
      "category:tshirts",
      "product:product:recommendation",
      "restore",
      "catalog-home",
    ]);
    assert.deepEqual(adapter.captures, [
      "implicit-recommendation-near-catalog",
      "implicit-recommendation-near-detail",
      "implicit-recommendation-far-catalog",
      "implicit-recommendation-far-detail",
    ]);
    assert.equal(result.evidence.scenarios[0]?.canonicalSize, "L");
    assert.equal(result.evidence.scenarios[1]?.profileEventId, "profile-far");
  });

  it("fails the stability assertion on a visible flicker or duplicate refinement", async () => {
    const adapter = new FakeRecommendationAdapter();
    adapter.flicker = true;
    adapter.doubleRefinement = true;

    const result = await runImplicitRecommendationBusinessSet(adapter, {
      baselineQuietMs: 100,
      presentationTimeoutMs: 1_000,
      stabilityMs: 2_500,
      departureTimeoutMs: 1_000,
      pollMs: 100,
    });

    const nearStability = result.assertions.find(
      (entry) => entry.id === "near.stable-ten-seconds",
    );
    assert.equal(nearStability?.status, "failed");
    assert.deepEqual(nearStability?.observed, {
      presentationNeverFlickered: false,
      oneSession: true,
      canonicalChangedAtMostOnce: true,
      refinedAtMostOnce: false,
      catalogOrderStable: true,
      sampledForFullWindow: true,
    });
    assert.deepEqual(adapter.calls.slice(-2), ["restore", "catalog-home"]);
  });
});
