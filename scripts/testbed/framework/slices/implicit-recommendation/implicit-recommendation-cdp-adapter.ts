import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CommandResult } from "../../test-adapter.ts";
import type {
  ImplicitRecommendationAcceptanceAdapter,
  ImplicitRecommendationObservation,
  RecommendationCanonicalSize,
  RecommendationDistance,
  RecommendationTraceEntry,
} from "./implicit-recommendation-driver.ts";

import { redactSensitiveEvidenceText } from "../../../failure-evidence-redaction.ts";
import { EVIDENCE_LIMITS } from "../../../full-workflow-evidence-manifest.ts";
import {
  captureScreenshot,
  evaluateExpression,
} from "../../../machine-ui-cdp-driver.ts";

type JsonRecord = Record<string, unknown>;
type CdpClientBoundary = {
  send: (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;
};
type RuntimeBoundary = {
  client: CdpClientBoundary | null;
  run(command: string, args?: string[]): Promise<CommandResult>;
};
type EvaluateBoundary = (
  client: CdpClientBoundary,
  expression: string,
  options?: { timeoutMs?: number; returnByValue?: boolean },
) => Promise<unknown>;
type ScreenshotBoundary = (
  client: CdpClientBoundary,
  options: {
    label?: string;
    maxBytes?: number;
    validatePng?: boolean;
    screenshotSink?: (input: {
      bytes: Uint8Array;
      sha256: string;
      format: string;
      label: string;
    }) => Promise<string | { ref: string }>;
  },
) => Promise<{
  sha256: string;
  byteLength: number;
  format: string;
  ref: string | null;
}>;

const TRACE_EVENTS = new Set<RecommendationTraceEntry["event"]>([
  "session_started",
  "neutral_presented",
  "refined_once",
  "manual_size_override",
  "multiple_suppressed",
  "projected_unavailable",
  "ignored_conflicting_profile",
  "session_ended",
]);
const CANONICAL_SIZES = new Set<RecommendationCanonicalSize>(["S", "M", "L"]);
const CATALOG_KEY =
  /^product:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCREENSHOT_LABEL =
  /^implicit-recommendation-(?:near|far)-(?:catalog|detail)$/;

export const IMPLICIT_RECOMMENDATION_PRESENTATION_PROBE_EXPRESSION = `(() => {
  const key = '__VEM_IMPLICIT_RECOMMENDATION_PRESENTATION_PROBE__';
  const previous = window[key];
  previous?.observer?.disconnect?.();
  const probe = {
    observedAtMs: null,
    sessionId: null,
    observer: null
  };
  const capture = () => {
    const card = document.querySelector('[data-test="home-tshirt-recommendation-card"]');
    const page = document.querySelector('[data-test="catalog-page"]');
    const sessionId = page?.getAttribute('data-recommendation-session-id') || null;
    const visible = Boolean(
      card &&
      card.getClientRects().length > 0 &&
      getComputedStyle(card).visibility !== 'hidden' &&
      getComputedStyle(card).display !== 'none'
    );
    if (
      visible &&
      sessionId &&
      card?.querySelector('strong')?.textContent?.trim() === '为你推荐' &&
      card?.querySelector('small')?.textContent?.trim() === '选一件后查看尺码'
    ) {
      probe.observedAtMs = Date.now();
      probe.sessionId = sessionId;
      probe.observer?.disconnect();
    }
  };
  probe.observer = new MutationObserver(capture);
  window[key] = probe;
  probe.observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true
  });
  capture();
  return true;
})()`;

export const IMPLICIT_RECOMMENDATION_OBSERVATION_EXPRESSION = `(() => {
  const visible = (element) => Boolean(
    element &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden' &&
    getComputedStyle(element).display !== 'none'
  );
  const text = (element) => {
    const value = element?.textContent?.trim();
    return value ? value : null;
  };
  const page = document.querySelector('[data-test="catalog-page"]');
  const banner = document.querySelector('[data-test="implicit-recommendation-banner"]');
  const homeCard = document.querySelector('[data-test="home-tshirt-recommendation-card"]');
  const detail = document.querySelector('[data-test="product-detail-page"]');
  const recommendation = detail?.querySelector('[data-test="product-size-recommendation"]');
  const selectedSize = detail?.querySelector(
    '[data-test="product-size-option"][data-vision-recommended="true"]'
  );
  const presentationProbe = window.__VEM_IMPLICIT_RECOMMENDATION_PRESENTATION_PROBE__;
  const cards = [...document.querySelectorAll('[data-test="catalog-product"]')].map((card) => ({
    catalogKey: card.getAttribute('data-catalog-key'),
    preferredVariantId: card.getAttribute('data-preferred-variant-id') || null,
    smartSizingSupported: card.getAttribute('data-smart-sizing-supported') === 'true',
    smartSizingText: text(card.querySelector('[data-test="catalog-product-smart-sizing"]'))
  }));
  const snapshot = window.__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__;
  const trace = Array.isArray(snapshot?.entries)
    ? snapshot.entries
      .filter((entry) => entry?.type === 'implicit_recommendation')
      .slice(-256)
      .map((entry) => ({
        id: entry.id,
        event: entry.event,
        sessionId: entry.sessionId,
        canonicalSize: entry.canonicalSize,
        profileEventId: entry.profileEventId,
        recordedAt: entry.recordedAt
      }))
    : [];
  return {
    observedAtMs: Date.now(),
    presentation: {
      observedAtMs: Number.isSafeInteger(presentationProbe?.observedAtMs)
        ? presentationProbe.observedAtMs
        : null,
      sessionId: typeof presentationProbe?.sessionId === 'string'
        ? presentationProbe.sessionId
        : null
    },
    route: location.hash,
    banner: {
      visible: visible(banner),
      state: banner?.getAttribute('data-recommendation-state') || null,
      text: text(banner)
    },
    homeCard: {
      visible: visible(homeCard),
      title: text(homeCard?.querySelector('strong')),
      detail: text(homeCard?.querySelector('small'))
    },
    catalog: {
      visible: visible(page),
      categoryKey: page?.getAttribute('data-category-key') || null,
      sessionId: page?.getAttribute('data-recommendation-session-id') || null,
      canonicalSize: page?.getAttribute('data-recommendation-canonical-size') || null,
      profileEventId: page?.getAttribute('data-vision-profile-event-id') || null,
      cards
    },
    detail: detail ? {
      visible: visible(detail),
      catalogKey: detail.getAttribute('data-catalog-key'),
      sessionId: detail.getAttribute('data-recommendation-session-id') || null,
      canonicalSize: detail.getAttribute('data-recommendation-canonical-size') || null,
      manualSizeSelected: detail.getAttribute('data-recommendation-manual-size') === 'true',
      recommendedText: text(recommendation),
      recommendedCanonicalSize: recommendation?.getAttribute('data-recommended-size') || null,
      selectedSize: selectedSize?.getAttribute('data-size') || null,
      selectedSizeVisionRecommended:
        selectedSize?.getAttribute('data-vision-recommended') === 'true'
    } : null,
    trace
  };
})()`;

function recordValue(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function canonicalSize(
  value: unknown,
  label: string,
): RecommendationCanonicalSize | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !CANONICAL_SIZES.has(value as RecommendationCanonicalSize)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value as RecommendationCanonicalSize;
}

function parseTrace(value: unknown): RecommendationTraceEntry[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("runtime trace is invalid");
  }
  return value.map((input) => {
    const entry = recordValue(input, "runtime trace entry");
    if (
      !Number.isSafeInteger(entry.id) ||
      Number(entry.id) < 1 ||
      typeof entry.event !== "string" ||
      !TRACE_EVENTS.has(entry.event as RecommendationTraceEntry["event"]) ||
      typeof entry.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.recordedAt))
    ) {
      throw new Error("runtime trace entry is invalid");
    }
    return {
      id: Number(entry.id),
      event: entry.event as RecommendationTraceEntry["event"],
      sessionId: nullableString(entry.sessionId, "runtime trace session id"),
      canonicalSize: canonicalSize(
        entry.canonicalSize,
        "runtime trace canonical size",
      ),
      profileEventId: nullableString(
        entry.profileEventId,
        "runtime trace profile event id",
      ),
      recordedAt: entry.recordedAt,
    };
  });
}

/** Parse the bounded public DOM/trace projection and reject partial evidence. */
export function parseImplicitRecommendationObservation(
  value: unknown,
): ImplicitRecommendationObservation {
  const root = recordValue(value, "implicit recommendation observation");
  if (
    !Number.isSafeInteger(root.observedAtMs) ||
    Number(root.observedAtMs) < 1
  ) {
    throw new Error("implicit recommendation observation timestamp is invalid");
  }
  const presentation = recordValue(
    root.presentation,
    "recommendation presentation timing",
  );
  const presentationObservedAtMs = presentation.observedAtMs;
  if (
    presentationObservedAtMs !== null &&
    (!Number.isSafeInteger(presentationObservedAtMs) ||
      Number(presentationObservedAtMs) < 1)
  ) {
    throw new Error("recommendation presentation timestamp is invalid");
  }
  const presentationSessionId = nullableString(
    presentation.sessionId,
    "recommendation presentation session id",
  );
  if (
    (presentationObservedAtMs === null) !==
    (presentationSessionId === null)
  ) {
    throw new Error("recommendation presentation timing is incomplete");
  }
  const banner = recordValue(root.banner, "recommendation banner");
  const state = banner.state;
  if (state !== null && state !== "active" && state !== "multiple") {
    throw new Error("recommendation banner state is invalid");
  }
  const homeCard = recordValue(root.homeCard, "home recommendation card");
  const catalog = recordValue(root.catalog, "recommendation catalog");
  if (!Array.isArray(catalog.cards) || catalog.cards.length > 256) {
    throw new Error("recommendation catalog cards are invalid");
  }
  const cards = catalog.cards.map((input) => {
    const card = recordValue(input, "recommendation catalog card");
    return {
      catalogKey: requiredString(card.catalogKey, "catalog key"),
      preferredVariantId: nullableString(
        card.preferredVariantId,
        "preferred variant id",
      ),
      smartSizingSupported: requiredBoolean(
        card.smartSizingSupported,
        "smart sizing support",
      ),
      smartSizingText: nullableString(
        card.smartSizingText,
        "smart sizing text",
      ),
    };
  });
  let detail: ImplicitRecommendationObservation["detail"] = null;
  if (root.detail !== null) {
    const input = recordValue(root.detail, "recommendation detail");
    detail = {
      visible: requiredBoolean(input.visible, "detail visibility"),
      catalogKey: requiredString(input.catalogKey, "detail catalog key"),
      sessionId: nullableString(input.sessionId, "detail session id"),
      canonicalSize: canonicalSize(
        input.canonicalSize,
        "detail canonical size",
      ),
      manualSizeSelected: requiredBoolean(
        input.manualSizeSelected,
        "detail manual size state",
      ),
      recommendedText: nullableString(
        input.recommendedText,
        "detail recommendation text",
      ),
      recommendedCanonicalSize: canonicalSize(
        input.recommendedCanonicalSize,
        "detail recommended canonical size",
      ),
      selectedSize: nullableString(input.selectedSize, "detail selected size"),
      selectedSizeVisionRecommended: requiredBoolean(
        input.selectedSizeVisionRecommended,
        "detail selected recommendation state",
      ),
    };
  }
  return {
    observedAtMs: Number(root.observedAtMs),
    presentation: {
      observedAtMs:
        presentationObservedAtMs === null
          ? null
          : Number(presentationObservedAtMs),
      sessionId: presentationSessionId,
    },
    route: requiredString(root.route, "recommendation route"),
    banner: {
      visible: requiredBoolean(banner.visible, "banner visibility"),
      state,
      text: nullableString(banner.text, "banner text"),
    },
    homeCard: {
      visible: requiredBoolean(homeCard.visible, "home card visibility"),
      title: nullableString(homeCard.title, "home card title"),
      detail: nullableString(homeCard.detail, "home card detail"),
    },
    catalog: {
      visible: requiredBoolean(catalog.visible, "catalog visibility"),
      categoryKey: nullableString(catalog.categoryKey, "category key"),
      sessionId: nullableString(catalog.sessionId, "catalog session id"),
      canonicalSize: canonicalSize(
        catalog.canonicalSize,
        "catalog canonical size",
      ),
      profileEventId: nullableString(
        catalog.profileEventId,
        "catalog profile event id",
      ),
      cards,
    },
    detail,
    trace: parseTrace(root.trace),
  };
}

function commandFailure(result: CommandResult, label: string): Error {
  const detail = redactSensitiveEvidenceText(
    result.stderr || result.stdout || "no command output",
    2_048,
  );
  return new Error(`${label} failed: ${detail}`);
}

export class InstalledImplicitRecommendationAdapter implements ImplicitRecommendationAcceptanceAdapter {
  private readonly boundary: RuntimeBoundary;
  private readonly artifactRoot: string | null;
  private readonly evaluateImpl: EvaluateBoundary;
  private readonly captureImpl: ScreenshotBoundary;
  private readonly io: {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(path: string, bytes: Uint8Array): Promise<unknown>;
  };

  constructor({
    boundary,
    artifactRoot = null,
    evaluateImpl = evaluateExpression,
    captureImpl = captureScreenshot,
    io = { mkdir, writeFile },
  }: {
    boundary: RuntimeBoundary;
    artifactRoot?: string | null;
    evaluateImpl?: EvaluateBoundary;
    captureImpl?: ScreenshotBoundary;
    io?: {
      mkdir(path: string, options: { recursive: true }): Promise<unknown>;
      writeFile(path: string, bytes: Uint8Array): Promise<unknown>;
    };
  }) {
    this.boundary = boundary;
    this.artifactRoot = artifactRoot;
    this.evaluateImpl = evaluateImpl;
    this.captureImpl = captureImpl;
    this.io = io;
  }

  now(): number {
    return Date.now();
  }

  async sleep(milliseconds: number): Promise<void> {
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, milliseconds),
    );
  }

  async restoreDefaultFixtures(): Promise<void> {
    await this.runRequired(
      "restore-recorded-video-fixtures",
      [],
      "restore fixtures",
    );
  }

  async selectFieldFixtures(distance: RecommendationDistance): Promise<void> {
    const armed = await this.evaluateImpl(
      this.requiredClient(),
      IMPLICIT_RECOMMENDATION_PRESENTATION_PROBE_EXPRESSION,
      { timeoutMs: 5_000 },
    );
    if (armed !== true) {
      throw new Error("implicit recommendation presentation probe did not arm");
    }
    await this.runRequired(
      "select-recommendation-video-fixture",
      [distance],
      `select ${distance} recommendation fixtures`,
    );
  }

  async navigateCatalogHome(): Promise<void> {
    await this.runRequired("navigate", ["#/catalog"], "navigate catalog home");
  }

  async openTshirtCategory(): Promise<void> {
    await this.runRequired(
      "click",
      ['[data-test="catalog-category"][data-category-key="tshirts"]'],
      "open T-shirt category",
    );
  }

  async openSmartSizedProduct(catalogKey: string): Promise<void> {
    if (!CATALOG_KEY.test(catalogKey)) {
      throw new Error("recommendation catalog key is invalid");
    }
    await this.runRequired(
      "click",
      [`[data-test="catalog-product"][data-catalog-key="${catalogKey}"]`],
      "open smart-sized product",
    );
  }

  async observe(): Promise<ImplicitRecommendationObservation> {
    const client = this.requiredClient();
    return parseImplicitRecommendationObservation(
      await this.evaluateImpl(
        client,
        IMPLICIT_RECOMMENDATION_OBSERVATION_EXPRESSION,
        { timeoutMs: 5_000 },
      ),
    );
  }

  async captureScreenshot(label: string): Promise<string | null> {
    if (!this.artifactRoot) return null;
    if (!SCREENSHOT_LABEL.test(label)) {
      throw new Error("implicit recommendation screenshot label is invalid");
    }
    await this.io.mkdir(this.artifactRoot, { recursive: true });
    const path = join(this.artifactRoot, `${label}.png`);
    const result = await this.captureImpl(this.requiredClient(), {
      label,
      maxBytes: EVIDENCE_LIMITS.screenshotPerFileBytes,
      validatePng: true,
      screenshotSink: async ({ bytes }) => {
        await this.io.writeFile(path, bytes);
        return path;
      },
    });
    return result.ref;
  }

  private requiredClient(): CdpClientBoundary {
    if (!this.boundary.client) {
      throw new Error("Machine UI CDP client is not connected");
    }
    return this.boundary.client;
  }

  private async runRequired(
    command: string,
    args: string[],
    label: string,
  ): Promise<void> {
    const result = await this.boundary.run(command, args);
    if (result.exitCode !== 0) throw commandFailure(result, label);
  }
}
