import type { BusinessAssertionRecord } from "../../observation-record.ts";

import { businessAssertion } from "../../observation-record.ts";

export type RecommendationDistance = "near" | "far";
export type RecommendationCanonicalSize = "S" | "M" | "L";

export interface RecommendationTraceEntry {
  id: number;
  event:
    | "session_started"
    | "neutral_presented"
    | "refined_once"
    | "manual_size_override"
    | "multiple_suppressed"
    | "projected_unavailable"
    | "ignored_conflicting_profile"
    | "session_ended";
  sessionId: string | null;
  canonicalSize: RecommendationCanonicalSize | null;
  profileEventId: string | null;
  recordedAt: string;
}

export interface RecommendationCatalogCardObservation {
  catalogKey: string;
  preferredVariantId: string | null;
  smartSizingSupported: boolean;
  smartSizingText: string | null;
}

export interface ImplicitRecommendationObservation {
  observedAtMs: number;
  presentation: {
    observedAtMs: number | null;
    sessionId: string | null;
  };
  route: string;
  banner: {
    visible: boolean;
    state: "active" | "multiple" | null;
    text: string | null;
  };
  homeCard: {
    visible: boolean;
    title: string | null;
    detail: string | null;
  };
  catalog: {
    visible: boolean;
    categoryKey: string | null;
    sessionId: string | null;
    canonicalSize: RecommendationCanonicalSize | null;
    profileEventId: string | null;
    cards: RecommendationCatalogCardObservation[];
  };
  detail: {
    visible: boolean;
    catalogKey: string;
    sessionId: string | null;
    canonicalSize: RecommendationCanonicalSize | null;
    manualSizeSelected: boolean;
    recommendedText: string | null;
    recommendedCanonicalSize: RecommendationCanonicalSize | null;
    selectedSize: string | null;
    selectedSizeVisionRecommended: boolean;
  } | null;
  trace: RecommendationTraceEntry[];
}

export interface ImplicitRecommendationAcceptanceAdapter {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  restoreDefaultFixtures(): Promise<void>;
  selectFieldFixtures(distance: RecommendationDistance): Promise<void>;
  navigateCatalogHome(): Promise<void>;
  openTshirtCategory(): Promise<void>;
  openSmartSizedProduct(catalogKey: string): Promise<void>;
  observe(): Promise<ImplicitRecommendationObservation>;
  captureScreenshot(label: string): Promise<string | null>;
}

interface DriverOptions {
  baselineQuietMs?: number;
  baselineTimeoutMs?: number;
  presentationTimeoutMs?: number;
  stabilityMs?: number;
  departureTimeoutMs?: number;
  pollMs?: number;
}

interface ScenarioEvidence {
  distance: RecommendationDistance;
  sessionId: string | null;
  neutralVisibleLatencyMs: number | null;
  stabilityWindowMs: number;
  stabilitySampleCount: number;
  presentationFlickerCount: number;
  canonicalSizes: RecommendationCanonicalSize[];
  canonicalSize: RecommendationCanonicalSize | null;
  profileEventId: string | null;
  refinementCount: number;
  departureCount: number;
  screenshots: string[];
}

export interface ImplicitRecommendationBusinessResult {
  assertions: BusinessAssertionRecord[];
  evidence: {
    kind: "implicit-recommendation-business-evidence";
    baselineQuiescent: boolean;
    finalRestored: boolean;
    scenarios: ScenarioEvidence[];
  };
}

const HOME_CARD_TITLE = "为你推荐";
const HOME_CARD_DETAIL = "选一件后查看尺码";
const SMART_CARD_TEXT = "支持智能选码 · 进入查看";
const CHINESE_SIZE_BY_CANONICAL: Record<RecommendationCanonicalSize, string> = {
  S: "小码",
  M: "中码",
  L: "大码",
};

function maxTraceId(observation: ImplicitRecommendationObservation): number {
  return observation.trace.reduce(
    (maximum, entry) => Math.max(maximum, entry.id),
    0,
  );
}

function activeTraceSessions(
  observation: ImplicitRecommendationObservation,
): Set<string> {
  const state = new Map<string, "started" | "ended">();
  for (const entry of observation.trace) {
    if (!entry.sessionId) continue;
    if (entry.event === "session_started") {
      state.set(entry.sessionId, "started");
    } else if (entry.event === "session_ended") {
      state.set(entry.sessionId, "ended");
    }
  }
  return new Set(
    [...state.entries()]
      .filter(([, status]) => status === "started")
      .map(([sessionId]) => sessionId),
  );
}

async function waitForObservation(
  adapter: ImplicitRecommendationAcceptanceAdapter,
  predicate: (observation: ImplicitRecommendationObservation) => boolean,
  {
    timeoutMs,
    pollMs,
    observations = null,
  }: {
    timeoutMs: number;
    pollMs: number;
    observations?: ImplicitRecommendationObservation[] | null;
  },
): Promise<{
  observation: ImplicitRecommendationObservation;
  matched: boolean;
}> {
  const deadline = adapter.now() + timeoutMs;
  let observation = await adapter.observe();
  observations?.push(observation);
  while (!predicate(observation) && adapter.now() < deadline) {
    await adapter.sleep(pollMs);
    observation = await adapter.observe();
    observations?.push(observation);
  }
  return { observation, matched: predicate(observation) };
}

async function waitForBaselineQuiescence(
  adapter: ImplicitRecommendationAcceptanceAdapter,
  {
    quietMs,
    timeoutMs,
    pollMs,
  }: {
    quietMs: number;
    timeoutMs: number;
    pollMs: number;
  },
): Promise<{
  observation: ImplicitRecommendationObservation;
  quiescent: boolean;
}> {
  const deadline = adapter.now() + timeoutMs;
  let quietSince: number | null = null;
  let observation = await adapter.observe();
  while (true) {
    const quiet =
      !observation.banner.visible &&
      !observation.homeCard.visible &&
      activeTraceSessions(observation).size === 0;
    quietSince = quiet ? (quietSince ?? adapter.now()) : null;
    if (quietSince !== null && adapter.now() - quietSince >= quietMs) {
      return { observation, quiescent: true };
    }
    if (adapter.now() >= deadline) {
      return { observation, quiescent: false };
    }
    await adapter.sleep(pollMs);
    observation = await adapter.observe();
  }
}

function compactSizes(
  observations: ImplicitRecommendationObservation[],
): RecommendationCanonicalSize[] {
  const compact: RecommendationCanonicalSize[] = [];
  for (const observation of observations) {
    const size = observation.catalog.canonicalSize;
    if (size && compact.at(-1) !== size) compact.push(size);
  }
  return compact;
}

function sameOrder(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runScenario(
  adapter: ImplicitRecommendationAcceptanceAdapter,
  distance: RecommendationDistance,
  baselineTraceId: number,
  options: Required<
    Pick<
      DriverOptions,
      "presentationTimeoutMs" | "stabilityMs" | "departureTimeoutMs" | "pollMs"
    >
  >,
): Promise<{
  assertions: BusinessAssertionRecord[];
  evidence: ScenarioEvidence;
  finalObservation: ImplicitRecommendationObservation;
}> {
  await adapter.selectFieldFixtures(distance);
  const presentation = await waitForObservation(
    adapter,
    (observation) => {
      const neutral = observation.trace.find(
        (entry) =>
          entry.id > baselineTraceId && entry.event === "neutral_presented",
      );
      return Boolean(
        neutral?.sessionId &&
        observation.homeCard.visible &&
        observation.homeCard.title === HOME_CARD_TITLE &&
        observation.homeCard.detail === HOME_CARD_DETAIL &&
        !observation.banner.visible &&
        observation.catalog.sessionId === neutral.sessionId,
      );
    },
    { timeoutMs: options.presentationTimeoutMs, pollMs: options.pollMs },
  );
  const neutral = presentation.observation.trace.find(
    (entry) =>
      entry.id > baselineTraceId && entry.event === "neutral_presented",
  );
  const sessionId =
    neutral?.sessionId ?? presentation.observation.catalog.sessionId;
  const neutralAtMs = neutral ? Date.parse(neutral.recordedAt) : Number.NaN;
  const presentationAtMs = presentation.observation.presentation.observedAtMs;
  const neutralVisibleLatencyMs =
    Number.isFinite(neutralAtMs) &&
    presentationAtMs !== null &&
    presentation.observation.presentation.sessionId === sessionId &&
    presentationAtMs >= neutralAtMs
      ? presentationAtMs - neutralAtMs
      : null;
  const assertions: BusinessAssertionRecord[] = [
    businessAssertion({
      id: `${distance}.neutral-visible-within-500ms`,
      source: "machine.runtime_trace+semantic_dom",
      expected: {
        visible: true,
        title: HOME_CARD_TITLE,
        detail: HOME_CARD_DETAIL,
        activeBannerHidden: true,
        within500ms: true,
      },
      observed: {
        visible:
          presentation.matched && presentation.observation.homeCard.visible,
        title: presentation.observation.homeCard.title,
        detail: presentation.observation.homeCard.detail,
        activeBannerHidden: !presentation.observation.banner.visible,
        within500ms:
          neutralVisibleLatencyMs !== null && neutralVisibleLatencyMs <= 500,
      },
    }),
  ];

  const stabilityStartedAt = adapter.now();
  const stabilityObservations: ImplicitRecommendationObservation[] = [
    presentation.observation,
  ];
  await adapter.openTshirtCategory();
  const category = await waitForObservation(
    adapter,
    (observation) =>
      observation.catalog.visible &&
      observation.catalog.categoryKey === "tshirts" &&
      observation.catalog.sessionId === sessionId,
    {
      timeoutMs: options.presentationTimeoutMs,
      pollMs: options.pollMs,
      observations: stabilityObservations,
    },
  );
  const initialOrder = category.observation.catalog.cards.map(
    (card) => card.catalogKey,
  );
  while (true) {
    stabilityObservations.push(await adapter.observe());
    if (adapter.now() - stabilityStartedAt >= options.stabilityMs) break;
    await adapter.sleep(
      Math.min(
        options.pollMs,
        options.stabilityMs - (adapter.now() - stabilityStartedAt),
      ),
    );
  }
  const stabilityWindowMs = adapter.now() - stabilityStartedAt;
  const finalCatalogObservation = stabilityObservations.at(-1)!;
  const compactCanonicalSizes = compactSizes(stabilityObservations);
  const sessionTrace = finalCatalogObservation.trace.filter(
    (entry) => entry.sessionId === sessionId,
  );
  const refinementCount = sessionTrace.filter(
    (entry) => entry.event === "refined_once",
  ).length;
  const sessionStartCount = sessionTrace.filter(
    (entry) => entry.event === "session_started",
  ).length;
  const neutralPresentationCount = sessionTrace.filter(
    (entry) => entry.event === "neutral_presented",
  ).length;
  const observedSessionIds = new Set(
    stabilityObservations
      .map((observation) => observation.catalog.sessionId)
      .filter((value): value is string => typeof value === "string"),
  );
  const categoryObservations = stabilityObservations.filter(
    (observation) => observation.catalog.categoryKey === "tshirts",
  );
  const presentationFlickerCount = categoryObservations.filter(
    (observation) => {
      const smartCard = observation.catalog.cards.find(
        (card) => card.smartSizingSupported,
      );
      return (
        observation.banner.visible ||
        smartCard?.smartSizingText !== SMART_CARD_TEXT ||
        observation.catalog.sessionId !== sessionId
      );
    },
  ).length;
  const catalogOrderStable =
    category.matched &&
    categoryObservations.length > 0 &&
    categoryObservations.every((observation) =>
      sameOrder(
        initialOrder,
        observation.catalog.cards.map((card) => card.catalogKey),
      ),
    );
  assertions.push(
    businessAssertion({
      id: `${distance}.stable-ten-seconds`,
      source: "semantic_dom+machine.runtime_trace",
      expected: {
        presentationNeverFlickered: true,
        oneSession: true,
        canonicalChangedAtMostOnce: true,
        refinedAtMostOnce: true,
        catalogOrderStable: true,
        sampledForFullWindow: true,
      },
      observed: {
        presentationNeverFlickered: presentationFlickerCount === 0,
        oneSession:
          sessionId !== null &&
          observedSessionIds.size === 1 &&
          observedSessionIds.has(sessionId) &&
          sessionStartCount === 1 &&
          neutralPresentationCount === 1,
        canonicalChangedAtMostOnce: compactCanonicalSizes.length <= 2,
        refinedAtMostOnce: refinementCount <= 1,
        catalogOrderStable,
        sampledForFullWindow: stabilityWindowMs >= options.stabilityMs,
      },
    }),
  );

  const screenshots: string[] = [];
  const catalogScreenshot = await adapter.captureScreenshot(
    `implicit-recommendation-${distance}-catalog`,
  );
  if (catalogScreenshot) screenshots.push(catalogScreenshot);
  const smartCard = finalCatalogObservation.catalog.cards.find(
    (card) => card.smartSizingSupported,
  );
  if (smartCard) {
    await adapter.openSmartSizedProduct(smartCard.catalogKey);
  }
  const detail = await waitForObservation(
    adapter,
    (observation) =>
      observation.detail?.visible === true &&
      observation.detail.catalogKey === smartCard?.catalogKey,
    { timeoutMs: options.presentationTimeoutMs, pollMs: options.pollMs },
  );
  const detailScreenshot = await adapter.captureScreenshot(
    `implicit-recommendation-${distance}-detail`,
  );
  if (detailScreenshot) screenshots.push(detailScreenshot);
  const canonicalSize = detail.observation.detail?.canonicalSize ?? null;
  const expectedChineseSize = canonicalSize
    ? CHINESE_SIZE_BY_CANONICAL[canonicalSize]
    : null;
  assertions.push(
    businessAssertion({
      id: `${distance}.catalog-detail-chinese-size`,
      source: "semantic_dom",
      expected: {
        cardCapabilityExact: true,
        detailCanonicalMatchesSession: true,
        detailRecommendationExact: true,
        selectedProductionChineseSize: true,
        automaticSelectionVisible: true,
      },
      observed: {
        cardCapabilityExact:
          smartCard?.smartSizingText === SMART_CARD_TEXT &&
          smartCard.preferredVariantId !== null,
        detailCanonicalMatchesSession:
          detail.matched &&
          canonicalSize !== null &&
          canonicalSize === finalCatalogObservation.catalog.canonicalSize &&
          detail.observation.detail?.sessionId === sessionId,
        detailRecommendationExact:
          canonicalSize !== null &&
          detail.observation.detail?.recommendedCanonicalSize ===
            canonicalSize &&
          detail.observation.detail?.recommendedText ===
            `推荐 ${canonicalSize}`,
        selectedProductionChineseSize:
          expectedChineseSize !== null &&
          detail.observation.detail?.selectedSize === expectedChineseSize,
        automaticSelectionVisible:
          detail.observation.detail?.manualSizeSelected === false &&
          detail.observation.detail.selectedSizeVisionRecommended === true,
      },
    }),
  );

  await adapter.restoreDefaultFixtures();
  await adapter.navigateCatalogHome();
  const departure = await waitForObservation(
    adapter,
    (observation) =>
      !observation.banner.visible &&
      !observation.homeCard.visible &&
      observation.trace.some(
        (entry) =>
          entry.sessionId === sessionId && entry.event === "session_ended",
      ),
    { timeoutMs: options.departureTimeoutMs, pollMs: options.pollMs },
  );
  const departureCount = departure.observation.trace.filter(
    (entry) => entry.sessionId === sessionId && entry.event === "session_ended",
  ).length;
  assertions.push(
    businessAssertion({
      id: `${distance}.departure-once`,
      source: "machine.runtime_trace+semantic_dom",
      expected: { hidden: true, endedExactlyOnce: true },
      observed: {
        hidden:
          departure.matched &&
          !departure.observation.banner.visible &&
          !departure.observation.homeCard.visible,
        endedExactlyOnce: departureCount === 1,
      },
    }),
  );

  return {
    assertions,
    evidence: {
      distance,
      sessionId,
      neutralVisibleLatencyMs,
      stabilityWindowMs,
      stabilitySampleCount: stabilityObservations.length,
      presentationFlickerCount,
      canonicalSizes: compactCanonicalSizes,
      canonicalSize,
      profileEventId: finalCatalogObservation.catalog.profileEventId,
      refinementCount,
      departureCount,
      screenshots,
    },
    finalObservation: departure.observation,
  };
}

/**
 * 独立推荐业务集：两组真实现场夹具共享同一顾客投影，并在每段后恢复默认来源。
 * 支持证据只解释断言；业务状态始终由公开 DOM 与结构化 runtime trace 决定。
 */
export async function runImplicitRecommendationBusinessSet(
  adapter: ImplicitRecommendationAcceptanceAdapter,
  options: DriverOptions = {},
): Promise<ImplicitRecommendationBusinessResult> {
  const resolved = {
    baselineQuietMs: options.baselineQuietMs ?? 6_000,
    baselineTimeoutMs: options.baselineTimeoutMs ?? 45_000,
    presentationTimeoutMs: options.presentationTimeoutMs ?? 30_000,
    stabilityMs: options.stabilityMs ?? 10_000,
    departureTimeoutMs: options.departureTimeoutMs ?? 30_000,
    pollMs: options.pollMs ?? 100,
  };
  if (
    Object.values(resolved).some(
      (value) => !Number.isInteger(value) || value <= 0,
    )
  ) {
    throw new TypeError(
      "implicit recommendation driver timings must be positive integers",
    );
  }

  let fixturesActive = false;
  let cleanupRequired = true;
  try {
    await adapter.navigateCatalogHome();
    await adapter.restoreDefaultFixtures();
    const baseline = await waitForBaselineQuiescence(adapter, {
      quietMs: resolved.baselineQuietMs,
      timeoutMs: resolved.baselineTimeoutMs,
      pollMs: resolved.pollMs,
    });
    let baselineTraceId = maxTraceId(baseline.observation);
    const assertions: BusinessAssertionRecord[] = [];
    const scenarios: ScenarioEvidence[] = [];
    const sessionIds: Array<string | null> = [];
    for (const distance of ["near", "far"] as const) {
      fixturesActive = true;
      const scenario = await runScenario(
        adapter,
        distance,
        baselineTraceId,
        resolved,
      );
      fixturesActive = false;
      assertions.push(...scenario.assertions);
      scenarios.push(scenario.evidence);
      sessionIds.push(scenario.evidence.sessionId);
      baselineTraceId = maxTraceId(scenario.finalObservation);
    }
    cleanupRequired = false;
    assertions.push(
      businessAssertion({
        id: "sessions.distinct",
        source: "machine.runtime_trace+fixture_restore",
        expected: {
          distinct: true,
          baselineQuiescent: true,
          finalRestored: true,
        },
        observed: {
          distinct:
            sessionIds.length === 2 &&
            sessionIds.every((value): value is string => value !== null) &&
            new Set(sessionIds).size === 2,
          baselineQuiescent: baseline.quiescent,
          finalRestored: true,
        },
      }),
    );
    return {
      assertions,
      evidence: {
        kind: "implicit-recommendation-business-evidence",
        baselineQuiescent: baseline.quiescent,
        finalRestored: true,
        scenarios,
      },
    };
  } finally {
    if (cleanupRequired) {
      if (fixturesActive) {
        await adapter.restoreDefaultFixtures().catch(() => {});
      }
      await adapter.navigateCatalogHome().catch(() => {});
    }
  }
}
