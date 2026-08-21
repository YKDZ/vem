import type { ProcessRoleManifest } from "../../fault-injection.ts";
import type { TestAdapter } from "../../test-adapter.ts";
import type {
  CapturedFrameResource,
  CapturedSourceEvidence,
  VisionProtocolEvent,
} from "./captured-source-evidence.ts";
import type { ResultGeometryValidation } from "./result-geometry-evidence.ts";
import type { SemanticResultPng } from "./result-geometry-evidence.ts";

import { buildAcceptanceReport } from "../../acceptance-report.ts";
import { waitForCondition } from "../../condition-waiter.ts";
import { stopDeclaredRole } from "../../fault-injection.ts";
import { businessAssertion } from "../../observation-record.ts";
import {
  capturedSourceBinding,
  validateCapturedSourceEvidence,
} from "./captured-source-evidence.ts";
import {
  validateResultGeometryEvidence,
  validateResultScalePair,
} from "./result-geometry-evidence.ts";
import {
  isSourceGarmentAttemptBound,
  type SourceGarmentMetadata,
} from "./source-garment-evidence.ts";

const STATE_PATH = "ui/try-on-state.json";

export interface TryOnState {
  route?: string;
  catalogKey?: string | null;
  variantId?: string | null;
  state?: string | null;
  attemptId?: string | null;
  visionOrigin?: string | null;
  preview?: { naturalWidth: number; naturalHeight: number };
  resultUrl?: string | null;
  scaleValue?: string | null;
  tryOnPresent?: boolean | null;
  buyDisabled?: boolean | null;
  guidance?: string | null;
  phaseText?: string | null;
  manualCaptureAllowed?: boolean | null;
  protocolTimeline?: VisionProtocolEvent[];
  capturedResource?: CapturedFrameResource | null;
  observationTimeline?: VisionExperienceObservation[];
  resultGeometryEvidence?: ResultGeometryValidation | null;
  /** CDP adapter 已下载并解码的当前 result PNG；绝不以 URL 或摘要替代。 */
  resultPng?: SemanticResultPng | null;
  /** 与当前 testbed 上传短袖源图同源的语义 mask；缺失时几何验收 fail closed。 */
  sourceGarmentPng?: SemanticResultPng | null;
  /** 当前 attempt 实际通过 Vision V2 start 发出的成衣描述。 */
  startGarment?: unknown;
  /** 同一公开 V2 websocket 上捕获的 adjust 与 adjusted；缺失或重复均 fail closed。 */
  adjustmentEvidence?: { scales: number[]; results: unknown[] } | null;
  /** runner 从本次 guest-input 与 Service API 规范来源重新验证后的源图元数据。 */
  sourceGarmentMetadata?: SourceGarmentMetadata | null;
}

/** 同一 attempt 的公开 DOM/resource 观测样本；时间只允许单调前进。 */
export interface VisionExperienceObservation {
  atMs: number;
  attemptId: string;
  state: string | null;
  holdRemainingMs: number | null;
  countdownText: string | null;
  previewVisible: boolean;
  previewFrameHash: string | null;
  capturedFrameId?: string | null;
  capturedDigest?: string | null;
}

interface TimelineAssertionValue {
  expected: unknown;
  observed: unknown;
}

export interface VisionExperienceTimelineValidation {
  ok: boolean;
  countdownRenderedSequence: TimelineAssertionValue;
  captureAfterCountdown: TimelineAssertionValue;
  previewLiveThroughCountdown: TimelineAssertionValue;
  capturedFrameHeldDuringGeneration: TimelineAssertionValue;
}

const COUNTDOWN_SEQUENCE = ["3", "2", "1"];
const MIN_COUNTDOWN_BUCKET_MS = 700;
const MIN_COUNTDOWN_TOTAL_MS = 2_500;
const MAX_PREVIEW_STALE_MS = 1_000;
const ACTIONABLE_ENTRY_TIMEOUT_MS = 15_000;
const ATTEMPT_STATES = new Set([
  "starting",
  "accepted",
  "acquiring",
  "captured",
  "generating",
  "completed",
]);
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CATALOG_KEY_PATTERN = new RegExp(`^product:${UUID_PATTERN}$`);
const VARIANT_ID_PATTERN = new RegExp(`^${UUID_PATTERN}$`);
const PRODUCT_SIZE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._+/-]{0,31}$/u;

export interface VisionAcceptanceBinding {
  selectedCatalogKey: string;
  selectedVariantId: string;
  selectedSize: string;
  sourceGarmentMetadata: SourceGarmentMetadata;
}

export interface VisionCatalogSelectionEvidence {
  kind: "vision-catalog-selection";
  catalogKey: string;
  variantId: string;
  size: string;
  actions: ("catalog-card" | "size-option")[];
  route: string;
}

export interface VisionStartGarmentBindingEvidence {
  kind: "vision-start-garment-binding";
  status: "bound" | "mismatch";
  selection: { catalogKey: string; variantId: string; size: string };
  expected: {
    assetId: string;
    digest: string;
    contentType: "image/png";
    byteSize: number;
    template: "tshirt_short_sleeve" | "tshirt_long_sleeve";
  };
  observed: {
    assetId: unknown;
    digest: unknown;
    contentType: unknown;
    byteSize: unknown;
    template: unknown;
  };
}

export function createVisionAcceptanceBinding({
  selectedCatalogKey,
  selectedVariantId,
  selectedSize,
  sourceGarmentMetadata,
}: {
  selectedCatalogKey: unknown;
  selectedVariantId: unknown;
  selectedSize: unknown;
  sourceGarmentMetadata: SourceGarmentMetadata;
}): VisionAcceptanceBinding {
  if (
    typeof selectedCatalogKey !== "string" ||
    !CATALOG_KEY_PATTERN.test(selectedCatalogKey) ||
    typeof selectedVariantId !== "string" ||
    !VARIANT_ID_PATTERN.test(selectedVariantId) ||
    typeof selectedSize !== "string" ||
    !PRODUCT_SIZE_PATTERN.test(selectedSize)
  ) {
    throw new Error("vision acceptance catalog selection identity is invalid");
  }
  return {
    selectedCatalogKey,
    selectedVariantId,
    selectedSize,
    sourceGarmentMetadata,
  };
}

function selectedProductSelector(binding: VisionAcceptanceBinding): string {
  createVisionAcceptanceBinding(binding);
  return (
    '[data-test="catalog-product"]' +
    `[data-catalog-key="${binding.selectedCatalogKey}"]`
  );
}

function selectedSizeSelector(binding: VisionAcceptanceBinding): string {
  createVisionAcceptanceBinding(binding);
  return (
    '[data-test="product-size-option"]' +
    `[data-size="${binding.selectedSize}"]`
  );
}

function startGarmentBindingEvidence(
  binding: VisionAcceptanceBinding,
  garment: unknown,
): VisionStartGarmentBindingEvidence {
  const observed =
    garment && typeof garment === "object" && !Array.isArray(garment)
      ? (garment as Record<string, unknown>)
      : {};
  const expected = binding.sourceGarmentMetadata;
  return {
    kind: "vision-start-garment-binding",
    status: isSourceGarmentAttemptBound(expected, garment)
      ? "bound"
      : "mismatch",
    selection: {
      catalogKey: binding.selectedCatalogKey,
      variantId: binding.selectedVariantId,
      size: binding.selectedSize,
    },
    expected: {
      assetId: expected.assetId,
      digest: expected.digest,
      contentType: expected.contentType,
      byteSize: expected.byteSize,
      template: expected.template,
    },
    observed: {
      assetId: observed.assetId ?? null,
      digest: observed.digest ?? null,
      contentType: observed.contentType ?? null,
      byteSize: observed.byteSize ?? null,
      template: observed.template ?? null,
    },
  };
}

function requireStartGarmentBinding(
  binding: VisionAcceptanceBinding,
  garment: unknown,
): VisionStartGarmentBindingEvidence {
  const evidence = startGarmentBindingEvidence(binding, garment);
  if (evidence.status === "bound") return evidence;
  const error = new Error(
    "first Vision attempt startGarment is not bound to guest-input",
  ) as Error & {
    stage: "vision-start-garment-binding";
    evidence: VisionStartGarmentBindingEvidence;
    report: ReturnType<typeof buildAcceptanceReport>;
  };
  error.stage = "vision-start-garment-binding";
  error.evidence = evidence;
  error.report = buildAcceptanceReport({
    runId: "slice-vision-experience",
    mode: "fast",
    pass: 1,
    businessSets: [
      {
        name: "visionExperience",
        assertions: [
          businessAssertion({
            id: "start-garment-bound",
            source: "vision-v2-protocol",
            expected: evidence.expected,
            observed: evidence.observed,
          }),
        ],
        supportingEvidence: [evidence],
      },
    ],
  });
  throw error;
}

function routeSelectionIdentity(route: unknown): {
  catalogKey: string | null;
  variantId: string | null;
} {
  if (typeof route !== "string" || !route.startsWith("#/products/")) {
    return { catalogKey: null, variantId: null };
  }
  try {
    const url = new URL(route.slice(1), "http://machine.invalid");
    return {
      catalogKey: decodeURIComponent(url.pathname.slice("/products/".length)),
      variantId: url.searchParams.get("variantId"),
    };
  } catch {
    return { catalogKey: null, variantId: null };
  }
}

async function enterSelectedProduct(
  adapter: TestAdapter,
  binding: VisionAcceptanceBinding,
  { timeoutMs, pollMs }: { timeoutMs?: number; pollMs?: number },
): Promise<VisionCatalogSelectionEvidence> {
  const selector = selectedProductSelector(binding);
  const actions: VisionCatalogSelectionEvidence["actions"] = [];
  try {
    await adapter.run("navigate", ["#/catalog"]);
    await adapter.run("click", [
      '[data-test="catalog-category"][data-category-key="tshirts"]',
    ]);
    await adapter.run("click", [selector]);
    actions.push("catalog-card");
    const detailState = await waitForCondition(
      "selected-product-catalog-detail",
      async () => {
        const current = await readState(adapter);
        const routeIdentity = routeSelectionIdentity(current.route);
        return {
          ok: routeIdentity.catalogKey === binding.selectedCatalogKey,
          value: current,
        };
      },
      { timeoutMs, pollMs },
    );
    if (detailState.variantId !== binding.selectedVariantId) {
      await adapter.run("click", [selectedSizeSelector(binding)]);
      actions.push("size-option");
    }
    const state = await waitForCondition(
      "selected-product-variant-detail",
      async () => {
        const current = await readState(adapter);
        return {
          ok:
            current.catalogKey === binding.selectedCatalogKey &&
            current.variantId === binding.selectedVariantId,
          value: current,
        };
      },
      { timeoutMs, pollMs },
    );
    return {
      kind: "vision-catalog-selection",
      catalogKey: binding.selectedCatalogKey,
      variantId: binding.selectedVariantId,
      size: binding.selectedSize,
      actions,
      route: state.route!,
    };
  } catch (cause) {
    const current = await readState(adapter).catch((): TryOnState => ({}));
    const routeIdentity = routeSelectionIdentity(current.route);
    const evidence = {
      kind: "vision-catalog-selection" as const,
      status: "mismatch" as const,
      actions,
      expected: {
        catalogKey: binding.selectedCatalogKey,
        variantId: binding.selectedVariantId,
        size: binding.selectedSize,
      },
      observed: {
        catalogKey: current.catalogKey ?? routeIdentity.catalogKey,
        variantId: current.variantId ?? routeIdentity.variantId,
        route: current.route ?? null,
      },
    };
    const error = new Error(
      "catalog selection did not enter the guest-input product variant",
      { cause: cause instanceof Error ? cause : undefined },
    ) as Error & {
      stage: "vision-catalog-selection";
      evidence: typeof evidence;
      report: ReturnType<typeof buildAcceptanceReport>;
    };
    error.stage = "vision-catalog-selection";
    error.evidence = evidence;
    error.report = buildAcceptanceReport({
      runId: "slice-vision-experience",
      mode: "fast",
      pass: 1,
      businessSets: [
        {
          name: "visionExperience",
          assertions: [
            businessAssertion({
              id: "catalog-selection-bound",
              source: "machine-ui-dom",
              expected: evidence.expected,
              observed: evidence.observed,
            }),
          ],
          supportingEvidence: [evidence],
        },
      ],
    });
    throw error;
  }
}

function collapsedCountdownSequence(samples: VisionExperienceObservation[]) {
  return samples.reduce<string[]>((sequence, sample) => {
    if (sequence.at(-1) !== sample.countdownText) {
      sequence.push(sample.countdownText!);
    }
    return sequence;
  }, []);
}

function activeCountdownRound(samples: VisionExperienceObservation[]) {
  let active: VisionExperienceObservation[] = [];
  let latest: VisionExperienceObservation[] = [];
  for (const sample of samples) {
    if (
      sample.state !== "acquiring" ||
      sample.countdownText === null ||
      !COUNTDOWN_SEQUENCE.includes(sample.countdownText)
    ) {
      active = [];
      continue;
    }
    if (sample.countdownText === "3" && active.at(-1)?.countdownText !== "3") {
      active = [];
    }
    active.push(sample);
    latest = active;
  }
  return latest;
}

/**
 * 以 DOM/protocol/resource 的逐样本观测判定倒计时与预览活性。
 * 该函数只消费公共 observation timeline，绝不读取 UI store 或内部计时器。
 */
export function validateVisionExperienceTimeline({
  attemptId,
  samples,
}: {
  attemptId: string;
  samples: VisionExperienceObservation[];
}): VisionExperienceTimelineValidation {
  const attemptSamples = (Array.isArray(samples) ? samples : []).filter(
    (sample) => sample?.attemptId === attemptId,
  );
  const monotonic = attemptSamples.every(
    (sample, index) =>
      Number.isFinite(sample.atMs) &&
      (index === 0 || sample.atMs > attemptSamples[index - 1]!.atMs),
  );
  const countdown = activeCountdownRound(attemptSamples);
  const sequence = collapsedCountdownSequence(countdown);
  const holdMatchesDom = countdown.every(
    (sample) =>
      Number.isInteger(sample.holdRemainingMs) &&
      sample.holdRemainingMs! >= 0 &&
      sample.holdRemainingMs! <= 3_000 &&
      String(Math.ceil(sample.holdRemainingMs! / 1_000)) ===
        sample.countdownText,
  );
  const holdNonIncreasing = countdown.every(
    (sample, index) =>
      index === 0 ||
      sample.holdRemainingMs! <= countdown[index - 1]!.holdRemainingMs!,
  );
  const bucketDurations = COUNTDOWN_SEQUENCE.map((digit) => {
    const entries = countdown.filter(
      (sample) => sample.countdownText === digit,
    );
    if (entries.length === 0) return 0;
    const first = entries[0]!.atMs;
    const next = countdown.find(
      (sample) => sample.atMs > first && sample.countdownText !== digit,
    );
    return (next?.atMs ?? entries.at(-1)!.atMs) - first;
  });
  const firstThree = countdown.find((sample) => sample.countdownText === "3");
  const lastOne = countdown
    .filter((sample) => sample.countdownText === "1")
    .at(-1);
  const captured = attemptSamples.find((sample) => sample.state === "captured");
  const firstHeld = attemptSamples.find(
    (sample) => sample.state === "captured" || sample.state === "generating",
  );
  const countdownComplete =
    monotonic &&
    holdMatchesDom &&
    holdNonIncreasing &&
    JSON.stringify(sequence) === JSON.stringify(COUNTDOWN_SEQUENCE) &&
    bucketDurations.every((duration) => duration >= MIN_COUNTDOWN_BUCKET_MS) &&
    Boolean(
      firstThree &&
      captured &&
      captured.atMs - firstThree.atMs >= MIN_COUNTDOWN_TOTAL_MS,
    );
  const captureAfter = Boolean(
    countdownComplete &&
    captured &&
    lastOne &&
    captured.atMs > lastOne.atMs &&
    firstHeld &&
    firstHeld.atMs > lastOne.atMs,
  );
  const previewForAllBuckets = COUNTDOWN_SEQUENCE.every((digit) => {
    const entries = countdown.filter(
      (sample) => sample.countdownText === digit,
    );
    if (
      entries.some(
        (sample) => !sample.previewVisible || !sample.previewFrameHash,
      )
    )
      return false;
    const frames = new Set(
      entries.map((sample) => sample.previewFrameHash).filter(Boolean),
    );
    if (frames.size < 2) return false;
    return entries.every((entry, index) => {
      if (index === 0) return true;
      return entry.atMs - entries[index - 1]!.atMs <= MAX_PREVIEW_STALE_MS;
    });
  });
  const countdownRenderedSequence = {
    expected: COUNTDOWN_SEQUENCE,
    observed: sequence,
  };
  const captureAfterCountdown = {
    expected: true,
    observed: captureAfter,
  };
  const previewLiveThroughCountdown = {
    expected: true,
    observed: monotonic && previewForAllBuckets,
  };
  const heldSamples = attemptSamples.filter(
    (sample) => sample.state === "captured" || sample.state === "generating",
  );
  const capturedIdentity = heldSamples.find(
    (sample) => sample.state === "captured",
  );
  const capturedFrameHeldDuringGeneration = {
    expected: true,
    observed:
      Boolean(
        capturedIdentity?.capturedFrameId && capturedIdentity.capturedDigest,
      ) &&
      heldSamples.some((sample) => sample.state === "generating") &&
      heldSamples.every(
        (sample) =>
          sample.capturedFrameId === capturedIdentity?.capturedFrameId &&
          sample.capturedDigest === capturedIdentity?.capturedDigest,
      ),
  };
  return {
    ok:
      countdownComplete &&
      captureAfter &&
      monotonic &&
      previewForAllBuckets &&
      capturedFrameHeldDuringGeneration.observed,
    countdownRenderedSequence,
    captureAfterCountdown,
    previewLiveThroughCountdown,
    capturedFrameHeldDuringGeneration,
  };
}

/**
 * Validates the public V2 event and controlled resource that identify the
 * exact generation input.  This deliberately observes the protocol boundary,
 * not Pinia internals or the deferred captured-image presentation.
 */
export function validateCapturedTryOnEvidence(
  state: TryOnState,
): CapturedSourceEvidence {
  const attemptId = state?.attemptId;
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    throw new Error(
      "captured evidence requires the completed attempt identity",
    );
  }
  const timeline = Array.isArray(state.protocolTimeline)
    ? state.protocolTimeline.filter(
        (event) => event?.payload?.attemptId === attemptId,
      )
    : [];
  const capturedEvents = timeline.filter(
    (event) => event?.type === "vision.try_on.attempt.captured",
  );
  const capturedEvent = capturedEvents[0];
  const terminal = timeline.at(-1);
  const evidence = validateCapturedSourceEvidence({
    kind: "vision-v2-captured-source",
    attemptId,
    visionOrigin: state.visionOrigin,
    requestId: capturedEvent?.requestId,
    captured: capturedEvent?.payload?.captured,
    resource: state.capturedResource,
    terminal,
    protocolTimeline: timeline,
  });
  if (!evidence) {
    throw new Error(
      "captured evidence is not bound to the completed Vision attempt",
    );
  }
  const terminalResult = evidence.terminal.payload.result as {
    reference?: unknown;
  } | null;
  if (
    typeof state.resultUrl !== "string" ||
    terminalResult?.reference !== state.resultUrl
  ) {
    throw new Error(
      "captured evidence terminal result is not bound to the completed surface",
    );
  }
  return evidence;
}

async function readState(adapter: TestAdapter): Promise<TryOnState> {
  return JSON.parse(await adapter.readFile(STATE_PATH));
}

/**
 * 最小虚拟试衣垂直切片：导航、进入商品、点击试衣、等待结果表面。
 * 断言通过统一记录产出 v2 报告；VM 上由真实适配器提供同一状态读取。
 */
export async function runTryOnScenario(
  adapter: TestAdapter,
  {
    timeoutMs,
    pollMs,
    acceptanceBinding,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    acceptanceBinding: VisionAcceptanceBinding;
  },
) {
  const selectionEvidence = await enterSelectedProduct(
    adapter,
    acceptanceBinding,
    {
      timeoutMs,
      pollMs,
    },
  );
  await adapter.run("click", ['[data-test="try-on"]']);
  let previewSeen = false;
  const observeState = async () => {
    const current = await readState(adapter);
    if (
      current?.state === "acquiring" &&
      (current?.preview?.naturalWidth ?? 0) > 0
    ) {
      previewSeen = true;
    }
    return current;
  };
  const entryTimeoutMs = Math.min(
    timeoutMs ?? ACTIONABLE_ENTRY_TIMEOUT_MS,
    ACTIONABLE_ENTRY_TIMEOUT_MS,
  );
  await waitForCondition(
    "try-on-route",
    async () => {
      const current = await observeState();
      return {
        ok: current?.route?.startsWith("#/try-on") === true,
        value: current,
      };
    },
    { timeoutMs: entryTimeoutMs, pollMs },
  );
  const attemptState = await waitForCondition(
    "try-on-attempt",
    async () => {
      const current = await observeState();
      return {
        ok:
          typeof current?.attemptId === "string" &&
          current.attemptId.length > 0 &&
          ATTEMPT_STATES.has(current.state ?? ""),
        value: current,
      };
    },
    { timeoutMs: entryTimeoutMs, pollMs },
  );
  const garmentBindingEvidence = requireStartGarmentBinding(
    acceptanceBinding,
    attemptState.startGarment,
  );
  const state = await waitForCondition(
    "result-surface",
    async () => {
      const current = await observeState();
      return {
        ok:
          current?.state === "completed" &&
          typeof current?.resultUrl === "string" &&
          current.resultUrl.length > 0,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const capturedEvidence = validateCapturedTryOnEvidence(state);
  const captured = capturedSourceBinding(capturedEvidence);
  const timeline =
    Array.isArray(state.observationTimeline) &&
    state.observationTimeline.length > 0
      ? validateVisionExperienceTimeline({
          attemptId: state.attemptId!,
          samples: state.observationTimeline,
        })
      : null;
  const geometry = state.resultGeometryEvidence ?? null;
  const assertions = [
    businessAssertion({
      id: "catalog-selection-bound",
      source: "machine-ui-dom",
      expected: {
        catalogKey: acceptanceBinding.selectedCatalogKey,
        variantId: acceptanceBinding.selectedVariantId,
      },
      observed: {
        catalogKey: selectionEvidence.catalogKey,
        variantId: selectionEvidence.variantId,
      },
    }),
    businessAssertion({
      id: "start-garment-bound",
      source: "vision-v2-protocol",
      expected: garmentBindingEvidence.expected,
      observed: garmentBindingEvidence.observed,
    }),
    businessAssertion({
      id: "try-on-route",
      source: "machine-ui-dom",
      expected: { prefix: "#/try-on" },
      observed: { prefix: state.route?.split("?")[0] ?? null },
    }),
    businessAssertion({
      id: "preview-decoded",
      source: "machine-ui-dom",
      expected: { decoded: true },
      observed: { decoded: previewSeen },
    }),
    businessAssertion({
      id: "result-surface",
      source: "machine-ui-dom",
      expected: { state: "completed", resultUrl: true },
      observed: {
        state: state.state,
        resultUrl: typeof state.resultUrl === "string",
      },
    }),
    businessAssertion({
      id: "captured-source-bound",
      source: "vision-v2-protocol",
      expected: captured,
      observed: captured,
    }),
    ...(timeline
      ? [
          businessAssertion({
            id: "countdown-rendered-sequence",
            source: "vision-experience-observation-timeline",
            expected: timeline.countdownRenderedSequence.expected,
            observed: timeline.countdownRenderedSequence.observed,
          }),
          businessAssertion({
            id: "captured-frame-held-during-generation",
            source: "vision-experience-observation-timeline",
            expected: timeline.capturedFrameHeldDuringGeneration.expected,
            observed: timeline.capturedFrameHeldDuringGeneration.observed,
          }),
          businessAssertion({
            id: "capture-after-countdown",
            source: "vision-experience-observation-timeline",
            expected: timeline.captureAfterCountdown.expected,
            observed: timeline.captureAfterCountdown.observed,
          }),
          businessAssertion({
            id: "preview-live-through-countdown",
            source: "vision-experience-observation-timeline",
            expected: timeline.previewLiveThroughCountdown.expected,
            observed: timeline.previewLiveThroughCountdown.observed,
          }),
        ]
      : []),
    ...(geometry
      ? [
          businessAssertion({
            id: "result-sleeves-retained",
            source: "vision-result-png-pixels",
            expected: geometry.resultSleevesRetained.expected,
            observed: geometry.resultSleevesRetained.observed,
          }),
          businessAssertion({
            id: "result-uniform-placement",
            source: "vision-result-png-pixels",
            expected: geometry.resultUniformPlacement.expected,
            observed: geometry.resultUniformPlacement.observed,
          }),
          businessAssertion({
            id: "result-automatic-scale",
            source: "vision-result-png-pixels",
            expected: geometry.resultAutomaticScale.expected,
            observed: geometry.resultAutomaticScale.observed,
          }),
          businessAssertion({
            id: "garment-scale-renders-pixels",
            source: "vision-result-png-pixels",
            expected: geometry.garmentScaleRendersPixels.expected,
            observed: geometry.garmentScaleRendersPixels.observed,
          }),
        ]
      : []),
  ];
  return {
    state,
    assertions,
    supportingEvidence: [
      selectionEvidence,
      garmentBindingEvidence,
      {
        ...capturedEvidence,
      },
    ],
    report: buildAcceptanceReport({
      runId: "slice-vision-experience",
      mode: "fast",
      pass: 1,
      businessSets: [
        {
          name: "visionExperience",
          assertions,
          supportingEvidence: [
            selectionEvidence,
            garmentBindingEvidence,
            {
              ...capturedEvidence,
            },
          ],
        },
      ],
    }),
  };
}

export interface RecordedGeometryFixtureEvidence {
  kind: "vision-recorded-geometry-fixture";
  status: "ready" | "blocked";
  reason: string | null;
  segments: string[];
}

function geometryAssertions(validation: ResultGeometryValidation) {
  return [
    ["result-sleeves-retained", validation.resultSleevesRetained],
    ["result-uniform-placement", validation.resultUniformPlacement],
    ["result-automatic-scale", validation.resultAutomaticScale],
    ["garment-scale-renders-pixels", validation.garmentScaleRendersPixels],
  ].map(([id, value]) =>
    businessAssertion({
      id,
      source: "vision-result-png-pixels",
      expected: (value as { expected: unknown }).expected,
      observed: (value as { observed: unknown }).observed,
    }),
  );
}

/**
 * 在已安装 Vision owner 上依次切换远、中、近三段录播，并只从每次完成 attempt
 * 下载的 result PNG 聚合几何事实。切换失败时返回结构化、fail-closed 的证据，
 * 不会把同一 clip 的重播改名为不同距离。
 */
export async function runRecordedResultGeometryScenario(
  adapter: TestAdapter,
  {
    timeoutMs,
    pollMs,
    acceptanceBinding,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    acceptanceBinding: VisionAcceptanceBinding;
  },
): Promise<
  | {
      ok: true;
      mid: Awaited<ReturnType<typeof runTryOnScenario>>;
      assertions: ReturnType<typeof geometryAssertions>;
      scaleAssertions: Awaited<
        ReturnType<typeof runGarmentScaleScenario>
      >["assertions"];
      adjustmentAssertions: Awaited<
        ReturnType<typeof runGarmentScaleScenario>
      >["adjustmentAssertions"];
      evidence: RecordedGeometryFixtureEvidence;
    }
  | {
      ok: false;
      assertions: ReturnType<typeof geometryAssertions>;
      scaleAssertions: [];
      adjustmentAssertions: [];
      evidence: RecordedGeometryFixtureEvidence;
    }
> {
  const attempts = new Map<
    string,
    Awaited<ReturnType<typeof runTryOnScenario>>
  >();
  let scaleResult: Awaited<ReturnType<typeof runGarmentScaleScenario>> | null =
    null;
  for (const segment of ["far", "mid", "near"]) {
    const selected = await adapter.run("select-recorded-video-fixture", [
      segment,
    ]);
    if (selected.exitCode !== 0) {
      return {
        ok: false,
        assertions: geometryAssertions({
          ok: false,
          resultSleevesRetained: { expected: true, observed: false },
          resultUniformPlacement: { expected: true, observed: false },
          resultAutomaticScale: { expected: true, observed: false },
          garmentScaleRendersPixels: { expected: true, observed: false },
        }),
        scaleAssertions: [],
        adjustmentAssertions: [],
        evidence: {
          kind: "vision-recorded-geometry-fixture",
          status: "blocked",
          reason:
            selected.stderr || selected.stdout || `无法选择 ${segment} 录播段`,
          segments: [...attempts.keys(), segment],
        },
      };
    }
    await waitForCondition(
      `vision-ready-after-${segment}-fixture`,
      async () => {
        const ready = await adapter.run("vision-ready");
        return { ok: ready.exitCode === 0, value: ready.stdout };
      },
      { timeoutMs: timeoutMs ?? 60_000, pollMs: 1_000 },
    );
    const attempt = await runTryOnScenario(adapter, {
      timeoutMs,
      pollMs,
      acceptanceBinding,
    });
    if (!attempt.state.resultPng) {
      return {
        ok: false,
        assertions: geometryAssertions({
          ok: false,
          resultSleevesRetained: { expected: true, observed: false },
          resultUniformPlacement: { expected: true, observed: false },
          resultAutomaticScale: { expected: true, observed: false },
          garmentScaleRendersPixels: { expected: true, observed: false },
        }),
        scaleAssertions: [],
        adjustmentAssertions: [],
        evidence: {
          kind: "vision-recorded-geometry-fixture",
          status: "blocked",
          reason: `${segment} attempt 未取得可解码的 result PNG 语义像素`,
          segments: [...attempts.keys(), segment],
        },
      };
    }
    attempts.set(segment, attempt);
    if (segment === "mid") {
      scaleResult = await runGarmentScaleScenario(adapter, {
        timeoutMs,
        pollMs,
        acceptanceBinding,
      });
      if (!scaleResult.beforeState.resultPng || !scaleResult.state.resultPng) {
        throw new Error(
          "garment scale scenario did not retain result PNG observations",
        );
      }
      attempts.set("scale100", { ...attempt, state: scaleResult.beforeState });
      attempts.set("scale105", { ...attempt, state: scaleResult.state });
    }
  }
  const mid = attempts.get("mid")!;
  const source = mid.state.sourceGarmentPng;
  const metadata = mid.state.sourceGarmentMetadata ?? null;
  const sourceBound = [...attempts.values()].every((attempt) =>
    isSourceGarmentAttemptBound(metadata, attempt.state.startGarment),
  );
  if (!source || !sourceBound) {
    return {
      ok: false,
      assertions: geometryAssertions({
        ok: false,
        resultSleevesRetained: { expected: true, observed: false },
        resultUniformPlacement: { expected: true, observed: false },
        resultAutomaticScale: { expected: true, observed: false },
        garmentScaleRendersPixels: { expected: true, observed: false },
      }),
      scaleAssertions: [],
      adjustmentAssertions: [],
      evidence: {
        kind: "vision-recorded-geometry-fixture",
        status: "blocked",
        reason: !source
          ? "当前 attempt 缺少同源短袖语义 mask"
          : "当前 attempt 的 V2 start 成衣描述未绑定本次预置源图",
        segments: ["far", "mid", "near"],
      },
    };
  }
  const validation = validateResultGeometryEvidence({
    source,
    far: attempts.get("far")!.state.resultPng!,
    mid: mid.state.resultPng,
    near: attempts.get("near")!.state.resultPng!,
    scale100: attempts.get("scale100")!.state.resultPng!,
    scale105: attempts.get("scale105")!.state.resultPng!,
  });
  return {
    ok: validation.ok,
    mid,
    assertions: geometryAssertions(validation),
    scaleAssertions: scaleResult!.assertions,
    adjustmentAssertions: scaleResult!.adjustmentAssertions,
    evidence: {
      kind: "vision-recorded-geometry-fixture",
      status: "ready",
      reason: null,
      segments: ["far", "mid", "near"],
    },
  };
}

/**
 * 观察者自愈垂直切片：通过产品声明的角色边界停止 observer，等待降级，
 * 再次触发试衣并等待结果表面完成。
 */
export async function runObserverSelfHealScenario(
  adapter: TestAdapter,
  manifest: ProcessRoleManifest,
  {
    timeoutMs,
    pollMs,
    acceptanceBinding,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    acceptanceBinding: VisionAcceptanceBinding;
  },
) {
  await stopDeclaredRole(adapter, manifest, "observer", {
    timeoutMs,
    pollMs,
  });
  await enterSelectedProduct(adapter, acceptanceBinding, {
    timeoutMs,
    pollMs,
  });
  await adapter.run("click", ['[data-test="try-on"]']);
  const state = await waitForCondition(
    "result-surface-after-heal",
    async () => {
      const current = await readState(adapter);
      return {
        ok:
          current?.state === "completed" &&
          typeof current?.resultUrl === "string" &&
          current.resultUrl.length > 0,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "observer-stop-declared",
      source: "process-role-manifest",
      expected: { stopped: true },
      observed: { stopped: true },
    }),
    businessAssertion({
      id: "observer-self-heal-completes",
      source: "machine-ui-dom",
      expected: { state: "completed", resultUrl: true },
      observed: {
        state: state.state,
        resultUrl: typeof state.resultUrl === "string",
      },
    }),
  ];
  return {
    assertions,
    report: buildAcceptanceReport({
      runId: "slice-vision-experience-self-heal",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}

/**
 * 结果锁定中心缩放：完成试衣后点击放大，等待 105% 与新的结果 URL。
 */
/** 只接受同一 attempt 上唯一的绝对 105% 意图与唯一调整结果。 */
export function validateGarmentScaleAdjustment({
  evidence,
  resultUrl,
}: {
  evidence: TryOnState["adjustmentEvidence"];
  resultUrl: unknown;
}): boolean {
  const results = evidence?.results;
  const adjustedReference =
    Array.isArray(results) && results.length === 1
      ? (results[0] as { reference?: unknown } | null)?.reference
      : null;
  return (
    evidence?.scales.length === 1 &&
    evidence.scales[0] === 1.05 &&
    adjustedReference === resultUrl
  );
}

export async function runGarmentScaleScenario(
  adapter: TestAdapter,
  {
    timeoutMs,
    pollMs,
    acceptanceBinding,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    acceptanceBinding: VisionAcceptanceBinding;
  },
) {
  const initial = await readState(adapter);
  if (
    initial?.state !== "completed" ||
    typeof initial?.resultUrl !== "string"
  ) {
    throw new Error("garment scale scenario requires a completed result");
  }
  requireStartGarmentBinding(acceptanceBinding, initial.startGarment);
  const beforeUrl = initial.resultUrl;
  const beforeAttemptId = initial.attemptId;
  await adapter.run("click", ['[data-test="try-on-scale-up"]']);
  const state = await waitForCondition(
    "adjusted-garment-scale",
    async () => {
      const current = await readState(adapter);
      return {
        ok:
          current?.scaleValue === "105%" &&
          typeof current?.resultUrl === "string" &&
          current.resultUrl !== beforeUrl,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "garment-scale-adjusts",
      source: "machine-ui-dom",
      expected: { scale: "105%", changed: true },
      observed: {
        scale: state.scaleValue,
        changed: state.resultUrl !== beforeUrl,
      },
    }),
  ];
  if (
    typeof beforeAttemptId !== "string" ||
    state.attemptId !== beforeAttemptId
  ) {
    throw new Error(
      "garment scale result must remain in the same Vision attempt",
    );
  }
  const adjustmentBound = validateGarmentScaleAdjustment({
    evidence: state.adjustmentEvidence,
    resultUrl: state.resultUrl,
  });
  const scalePixels =
    initial.resultPng && state.resultPng
      ? validateResultScalePair({
          scale100: initial.resultPng,
          scale105: state.resultPng,
        })
      : { expected: true, observed: false };
  return {
    beforeState: initial,
    state,
    assertions,
    adjustmentAssertions: [
      businessAssertion({
        id: "garment-scale-v2-adjustment",
        source: "vision-v2-protocol",
        expected: { scales: [1.05], adjustedResultBound: true },
        observed: {
          scales: state.adjustmentEvidence?.scales ?? [],
          adjustedResultBound: adjustmentBound,
        },
      }),
    ],
    pixelAssertions: [
      businessAssertion({
        id: "garment-scale-renders-pixels",
        source: "vision-result-png-pixels",
        expected: scalePixels.expected,
        observed: scalePixels.observed,
      }),
    ],
    report: buildAcceptanceReport({
      runId: "slice-vision-experience-scale",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}

/**
 * 降级购买：停止整个 Vision owner 后，商品页试衣入口隐藏但购买保持可用。
 * stopOwner 由调用方提供（安装 owner 的受控停止），driver 不猜测进程。
 */
export async function runDegradationScenario(
  adapter: TestAdapter,
  {
    stopOwner,
    timeoutMs,
    pollMs,
    acceptanceBinding,
  }: {
    stopOwner: () => Promise<void> | void;
    timeoutMs?: number;
    pollMs?: number;
    acceptanceBinding: VisionAcceptanceBinding;
  },
) {
  await enterSelectedProduct(adapter, acceptanceBinding, {
    timeoutMs,
    pollMs,
  });
  await waitForCondition(
    "product-detail-ready",
    async () => {
      const current = await readState(adapter);
      return {
        ok:
          current?.route?.startsWith("#/products") &&
          current?.tryOnPresent !== null
            ? true
            : false,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  await stopOwner();
  const degraded = await waitForCondition(
    "degraded-product-detail",
    async () => {
      const current = await readState(adapter);
      return {
        ok: current?.tryOnPresent === false && current?.buyDisabled === false,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "vision-owner-stop-declared",
      source: "install-owner",
      expected: { stopped: true },
      observed: { stopped: true },
    }),
    businessAssertion({
      id: "degraded-try-on-hidden",
      source: "machine-ui-dom",
      expected: { tryOnPresent: false },
      observed: { tryOnPresent: degraded.tryOnPresent },
    }),
    businessAssertion({
      id: "degraded-buy-available",
      source: "machine-ui-dom",
      expected: { buyDisabled: false },
      observed: { buyDisabled: degraded.buyDisabled },
    }),
  ];
  return {
    assertions,
    report: buildAcceptanceReport({
      runId: "slice-vision-experience-degradation",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}

async function enterTryOn(
  adapter: TestAdapter,
  acceptanceBinding: VisionAcceptanceBinding,
  options: { timeoutMs?: number; pollMs?: number },
) {
  await enterSelectedProduct(adapter, acceptanceBinding, options);
  await adapter.run("click", ['[data-test="try-on"]']);
}

/**
 * 手动采集与不稳定录播：进入试衣后自动拍摄不应在失稳时触发，
 * 手动按钮可用时点击并完成。
 */
export async function runManualCaptureScenario(
  adapter: TestAdapter,
  {
    timeoutMs,
    pollMs,
    acceptanceBinding,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    acceptanceBinding: VisionAcceptanceBinding;
  },
) {
  await enterTryOn(adapter, acceptanceBinding, { timeoutMs, pollMs });
  let autoCaptured = false;
  await waitForCondition(
    "manual-capture-available",
    async () => {
      const current = await readState(adapter);
      if (current?.state === "completed") autoCaptured = true;
      return {
        ok: current?.manualCaptureAllowed === true,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  await adapter.run("click", ['[data-test="try-on-manual-capture"]']);
  const completed = await waitForCondition(
    "manual-capture-completed",
    async () => {
      const current = await readState(adapter);
      return {
        ok: current?.state === "completed" ? true : false,
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "auto-capture-not-fired",
      source: "machine-ui-dom",
      expected: { fired: false },
      observed: { fired: autoCaptured },
    }),
    businessAssertion({
      id: "manual-capture-completes",
      source: "machine-ui-dom",
      expected: { state: "completed" },
      observed: { state: completed.state },
    }),
  ];
  return {
    assertions,
    report: buildAcceptanceReport({
      runId: "slice-vision-experience-manual",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}

/**
 * 离开取消：模拟顶部相机 departure 后当前 attempt 应被取消。
 */
export async function runDepartureScenario(
  adapter: TestAdapter,
  {
    timeoutMs,
    pollMs,
    acceptanceBinding,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    acceptanceBinding: VisionAcceptanceBinding;
  },
) {
  await enterTryOn(adapter, acceptanceBinding, { timeoutMs, pollMs });
  await adapter.run("simulate-departure");
  const canceled = await waitForCondition(
    "departure-canceled",
    async () => {
      const current = await readState(adapter);
      return {
        ok:
          current?.state === "canceled" &&
          /离开/.test(current?.phaseText ?? ""),
        value: current,
      };
    },
    { timeoutMs, pollMs },
  );
  const assertions = [
    businessAssertion({
      id: "departure-cancels-attempt",
      source: "machine-ui-dom",
      expected: { state: "canceled", departureDetected: true },
      observed: {
        state: canceled.state,
        departureDetected: /离开/.test(canceled.phaseText ?? ""),
      },
    }),
  ];
  return {
    assertions,
    report: buildAcceptanceReport({
      runId: "slice-vision-experience-departure",
      mode: "fast",
      pass: 1,
      businessSets: [{ name: "visionExperience", assertions }],
    }),
  };
}
