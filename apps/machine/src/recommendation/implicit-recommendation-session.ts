import type { MachineCatalogItem } from "@/types/catalog";

export type RecommendationCanonicalSize = "S" | "M" | "L";
export type RecommendationOccupancy = "none" | "single" | "multiple";

export type ImplicitRecommendationState = Readonly<{
  sessionId: string | null;
  occupancy: RecommendationOccupancy;
  canonicalSize: RecommendationCanonicalSize | null;
  refinementConsumed: boolean;
  liveProfileSequenceFloor: number;
  seenProfileEventIds: readonly string[];
  manualSizes: Readonly<Record<string, string | null>>;
  selectedColors: Readonly<Record<string, string | null>>;
}>;

export type ImplicitRecommendationEvent =
  | {
      type: "presence_observed";
      present: boolean;
      occupancy: RecommendationOccupancy;
      edgeId: string | null;
      liveProfileSequence: number;
    }
  | {
      type: "profile_received";
      sequence: number;
      eventId: string;
      usable: boolean;
      personPresent: boolean;
      confidence: number | undefined;
      bodyType: string | undefined;
      availableSizes: readonly RecommendationCanonicalSize[];
    }
  | {
      type: "manual_size_selected";
      catalogKey: string;
      size: string | null;
    }
  | {
      type: "color_selected";
      catalogKey: string;
      color: string | null;
    }
  | {
      type: "vend_succeeded";
      transactionId: string;
    }
  | { type: "runtime_reset" };

export type ImplicitRecommendationDiagnosticEvent =
  | "session_started"
  | "neutral_presented"
  | "refined_once"
  | "manual_size_override"
  | "multiple_suppressed"
  | "projected_unavailable"
  | "ignored_conflicting_profile"
  | "session_ended";

export type ImplicitRecommendationDiagnostic = Readonly<{
  event: ImplicitRecommendationDiagnosticEvent;
  sessionId: string | null;
  catalogKey?: string;
  profileEventId?: string;
  canonicalSize?: RecommendationCanonicalSize;
}>;

export type ImplicitRecommendationTransition = Readonly<{
  state: ImplicitRecommendationState;
  diagnostics: readonly ImplicitRecommendationDiagnostic[];
}>;

export type ProductRecommendationProjection = Readonly<{
  supportsSmartSizing: boolean;
  recommendedSize: RecommendationCanonicalSize | null;
  selectedSize: string | null;
  selectedColor: string | null;
  manualSizeSelected: boolean;
  unavailableCanonicalSize: RecommendationCanonicalSize | null;
}>;

export type ImplicitRecommendationProjection = Readonly<{
  visible: boolean;
  banner: "hidden" | "active" | "multiple";
  sessionId: string | null;
  canonicalSize: RecommendationCanonicalSize | null;
  products: Readonly<Record<string, ProductRecommendationProjection>>;
}>;

const PROFILE_CONFIDENCE_THRESHOLD = 0.5;

const NORMALIZED_SIZES: Readonly<Record<string, RecommendationCanonicalSize>> =
  {
    S: "S",
    S码: "S",
    SMALL: "S",
    小码: "S",
    小: "S",
    M: "M",
    M码: "M",
    MEDIUM: "M",
    中码: "M",
    中: "M",
    L: "L",
    L码: "L",
    LARGE: "L",
    大码: "L",
    大: "L",
  };

export function createImplicitRecommendationState(): ImplicitRecommendationState {
  return {
    sessionId: null,
    occupancy: "none",
    canonicalSize: null,
    refinementConsumed: false,
    liveProfileSequenceFloor: 0,
    seenProfileEventIds: [],
    manualSizes: {},
    selectedColors: {},
  };
}

export function normalizeRecommendationSize(
  value: string | null | undefined,
): RecommendationCanonicalSize | null {
  const normalized = (value ?? "")
    .trim()
    .toLocaleUpperCase()
    .replace(/\s+/g, "");
  return NORMALIZED_SIZES[normalized] ?? null;
}

export function transitionImplicitRecommendation(
  state: ImplicitRecommendationState,
  event: ImplicitRecommendationEvent,
): ImplicitRecommendationTransition {
  if (event.type === "runtime_reset") {
    return { state: createImplicitRecommendationState(), diagnostics: [] };
  }
  if (event.type === "presence_observed") {
    return observePresence(state, event);
  }
  if (event.type === "profile_received") {
    return observeProfile(state, event);
  }
  if (event.type === "manual_size_selected") {
    if (!state.sessionId) return { state, diagnostics: [] };
    return {
      state: {
        ...state,
        manualSizes: {
          ...state.manualSizes,
          [event.catalogKey]: event.size,
        },
      },
      diagnostics: [
        {
          event: "manual_size_override",
          sessionId: state.sessionId,
          catalogKey: event.catalogKey,
        },
      ],
    };
  }
  if (event.type === "color_selected") {
    if (!state.sessionId) return { state, diagnostics: [] };
    return {
      state: {
        ...state,
        selectedColors: {
          ...state.selectedColors,
          [event.catalogKey]: event.color,
        },
      },
      diagnostics: [],
    };
  }

  if (!state.sessionId || Object.keys(state.manualSizes).length === 0) {
    return { state, diagnostics: [] };
  }
  return { state: { ...state, manualSizes: {} }, diagnostics: [] };
}

export function projectImplicitRecommendation(
  state: ImplicitRecommendationState,
  catalog: readonly MachineCatalogItem[],
): ImplicitRecommendationProjection {
  const products = Object.fromEntries(
    catalog.map((item) => [
      item.catalogKey,
      projectProductRecommendation(state, item),
    ]),
  );
  const capabilityAvailable = Object.values(products).some(
    (product) => product.supportsSmartSizing,
  );
  const visible =
    capabilityAvailable &&
    (state.sessionId !== null || state.occupancy === "multiple");
  return {
    visible,
    banner: !visible
      ? "hidden"
      : state.occupancy === "multiple"
        ? "multiple"
        : "active",
    sessionId: state.sessionId,
    canonicalSize: state.sessionId ? state.canonicalSize : null,
    products,
  };
}

function observePresence(
  state: ImplicitRecommendationState,
  event: Extract<ImplicitRecommendationEvent, { type: "presence_observed" }>,
): ImplicitRecommendationTransition {
  if (!event.present || event.occupancy === "none") {
    if (!state.sessionId) {
      return {
        state:
          state.occupancy === "none" ? state : { ...state, occupancy: "none" },
        diagnostics: [],
      };
    }
    return {
      state: createImplicitRecommendationState(),
      diagnostics: [{ event: "session_ended", sessionId: state.sessionId }],
    };
  }

  if (event.occupancy === "multiple") {
    const becameMultiple = state.occupancy !== "multiple";
    return {
      state: { ...state, occupancy: "multiple" },
      diagnostics:
        state.sessionId && becameMultiple
          ? [
              {
                event: "multiple_suppressed",
                sessionId: state.sessionId,
              },
            ]
          : [],
    };
  }

  if (state.sessionId) {
    return {
      state:
        state.occupancy === "single"
          ? state
          : { ...state, occupancy: "single" },
      diagnostics: [],
    };
  }

  const sessionId = sessionIdFor(event.edgeId);
  return {
    state: {
      ...createImplicitRecommendationState(),
      sessionId,
      occupancy: "single",
      canonicalSize: "M",
      liveProfileSequenceFloor: event.liveProfileSequence,
    },
    diagnostics: [
      { event: "session_started", sessionId, canonicalSize: "M" },
      { event: "neutral_presented", sessionId, canonicalSize: "M" },
    ],
  };
}

function observeProfile(
  state: ImplicitRecommendationState,
  event: Extract<ImplicitRecommendationEvent, { type: "profile_received" }>,
): ImplicitRecommendationTransition {
  if (!state.sessionId) return { state, diagnostics: [] };
  if (state.seenProfileEventIds.includes(event.eventId)) {
    return { state, diagnostics: [] };
  }
  const nextState = {
    ...state,
    seenProfileEventIds: [...state.seenProfileEventIds, event.eventId],
  };
  if (
    event.sequence <= state.liveProfileSequenceFloor ||
    state.occupancy !== "single" ||
    !event.usable ||
    !event.personPresent ||
    (event.confidence !== undefined &&
      event.confidence < PROFILE_CONFIDENCE_THRESHOLD)
  ) {
    return { state: nextState, diagnostics: [] };
  }

  const targetSize = canonicalSizeForBodyType(event.bodyType);
  if (!targetSize || !event.availableSizes.includes(targetSize)) {
    return { state: nextState, diagnostics: [] };
  }
  if (state.refinementConsumed) {
    return {
      state: nextState,
      diagnostics:
        targetSize !== state.canonicalSize
          ? [
              {
                event: "ignored_conflicting_profile",
                sessionId: state.sessionId,
                profileEventId: event.eventId,
                canonicalSize: state.canonicalSize ?? undefined,
              },
            ]
          : [],
    };
  }
  return {
    state: {
      ...nextState,
      canonicalSize: targetSize,
      refinementConsumed: true,
    },
    diagnostics: [
      {
        event: "refined_once",
        sessionId: state.sessionId,
        profileEventId: event.eventId,
        canonicalSize: targetSize,
      },
    ],
  };
}

function projectProductRecommendation(
  state: ImplicitRecommendationState,
  item: MachineCatalogItem,
): ProductRecommendationProjection {
  const saleableStandardVariants = item.variantCandidates.filter(
    (candidate) =>
      candidate.slotSalesState === "sale_ready" &&
      candidate.saleableStock > 0 &&
      normalizeRecommendationSize(candidate.size) !== null,
  );
  const supportsSmartSizing = saleableStandardVariants.length > 0;
  const hasManualSize = Object.prototype.hasOwnProperty.call(
    state.manualSizes,
    item.catalogKey,
  );
  const manualSize = hasManualSize
    ? (state.manualSizes[item.catalogKey] ?? null)
    : null;
  const targetVariant = saleableStandardVariants.find(
    (candidate) =>
      normalizeRecommendationSize(candidate.size) === state.canonicalSize,
  );
  const canProjectAutomatic =
    state.sessionId !== null &&
    state.occupancy === "single" &&
    !hasManualSize &&
    supportsSmartSizing;

  return {
    supportsSmartSizing,
    recommendedSize:
      canProjectAutomatic && targetVariant ? state.canonicalSize : null,
    selectedSize: hasManualSize
      ? manualSize
      : canProjectAutomatic && targetVariant
        ? targetVariant.size
        : null,
    selectedColor: Object.prototype.hasOwnProperty.call(
      state.selectedColors,
      item.catalogKey,
    )
      ? (state.selectedColors[item.catalogKey] ?? null)
      : null,
    manualSizeSelected: hasManualSize,
    unavailableCanonicalSize:
      canProjectAutomatic && !targetVariant ? state.canonicalSize : null,
  };
}

function canonicalSizeForBodyType(
  bodyType: string | undefined,
): RecommendationCanonicalSize | null {
  if (bodyType === "slim") return "S";
  if (bodyType === "regular") return "M";
  if (bodyType === "strong") return "L";
  return null;
}

function sessionIdFor(edgeId: string | null): string {
  return (edgeId ?? "presence-unidentified").replace(
    /:(arrival|departure)$/,
    "",
  );
}
