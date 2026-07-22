export type CustomerJourneyTransitionKind =
  | "touchscreen.awakened"
  | "presence.welcome"
  | "privacy.crowd_detected"
  | "presence.departed"
  | "category.entered"
  | "product.selected"
  | "payment.prompt"
  | "payment.succeeded"
  | "payment.failed"
  | "dispensing.started"
  | "pickup.outlet_opened"
  | "pickup.waiting"
  | "pickup.warning"
  | "pickup.urgent"
  | "pickup.resetting"
  | "pickup.completed"
  | "dispense.succeeded"
  | "dispense.failed"
  | "refund.pending"
  | "refund.completed"
  | "manual_handling.required";

export type CustomerJourneyTransition = {
  transitionId: string;
  kind: CustomerJourneyTransitionKind;
  category: "presence" | "transaction";
  orderNo: string | null;
  occurredAt: string | null;
  productCategory: string | null;
};

export type CustomerJourneyFacts = {
  touchscreen?: {
    personPresent: boolean;
    source: "local_interaction";
    lastInteractionAt: string | null;
    restored?: boolean;
  } | null;
  vision?: {
    personPresent: boolean;
    occupancyState: "none" | "single" | "multiple" | "unknown";
    lastSeenAt: string | null;
    departedAt: string | null;
    lastChangedAt: string | null;
    edge: "arrival" | "departure" | null;
    edgeId: string | null;
    restored?: boolean;
  } | null;
  categoryEntry?: {
    entryId: string;
    category: string;
    enteredAt: string | null;
    restored?: boolean;
  } | null;
  selectedProduct?: {
    selectionId: string;
    productId: string;
    category: string | null;
    selectedAt: string | null;
    restored?: boolean;
  } | null;
  transaction?: {
    orderNo: string | null;
    nextAction:
      | "wait_payment"
      | "dispensing"
      | "success"
      | "payment_failed"
      | "payment_expired"
      | "dispense_failed"
      | "refund_pending"
      | "refunded"
      | "manual_handling"
      | "closed"
      | null;
    updatedAt: string;
    vending: {
      status: string | null;
      pickupReminder: {
        stage:
          | "outlet_opened"
          | "pickup_waiting"
          | "pickup_completed"
          | "pickup_timeout_warning"
          | null
          | undefined;
        level: "info" | "warning" | "urgent";
        warningNo: number | null;
        reportedAt: string;
      } | null;
    } | null;
    restored?: boolean;
  } | null;
};

export type CustomerJourneyTransitionProjector = {
  project(facts: CustomerJourneyFacts): CustomerJourneyTransition[];
  memoryUsage(): CustomerJourneyTransitionProjectorMemoryUsage;
};

export type CustomerJourneyTransitionProjectorMemoryUsage = {
  transactionOrders: number;
  pickupSeenOrders: number;
  maxTransactionOrders: number;
};

const TRANSACTION_ORDER_MEMORY_LIMIT = 32;

export function createCustomerJourneyTransitionProjector(): CustomerJourneyTransitionProjector {
  const semanticEdges = createSemanticEdgeMemory();
  const transactionEdges = createTransactionEdgeMemory();

  return {
    project(facts) {
      return projectCandidates(facts, semanticEdges, transactionEdges).filter(
        (candidate) => !candidateRestored(candidate, facts),
      );
    },
    memoryUsage: () => transactionEdges.memoryUsage(),
  };
}

function projectCandidates(
  facts: CustomerJourneyFacts,
  semanticEdges: SemanticEdgeMemory,
  transactionEdges: TransactionEdgeMemory,
): CustomerJourneyTransition[] {
  const candidates: CustomerJourneyTransition[] = [];
  const touchscreen = facts.touchscreen;
  const touchscreenActive = Boolean(
    touchscreen?.personPresent && touchscreen.source === "local_interaction",
  );
  if (semanticEdges.observeTouchscreen(touchscreenActive)) {
    candidates.push(
      transition({
        transitionId: semanticEdges.nextTouchscreenTransitionId(),
        kind: "touchscreen.awakened",
        category: "presence",
        occurredAt: touchscreen?.lastInteractionAt ?? null,
      }),
    );
  }

  const vision = facts.vision;
  const visionEdge = semanticEdges.observeVision(
    vision?.edgeId ?? null,
    vision?.edge ?? null,
    vision?.occupancyState ?? "none",
  );
  if (visionEdge === "crowd") {
    candidates.push(
      transition({
        transitionId: visionTransitionId(vision?.edgeId, "crowd"),
        kind: "privacy.crowd_detected",
        category: "presence",
        occurredAt: vision?.lastChangedAt ?? vision?.lastSeenAt ?? null,
      }),
    );
  } else if (visionEdge === "welcome") {
    candidates.push(
      transition({
        transitionId: visionTransitionId(vision?.edgeId, "welcome"),
        kind: "presence.welcome",
        category: "presence",
        occurredAt: vision?.lastChangedAt ?? vision?.lastSeenAt ?? null,
      }),
    );
  } else if (visionEdge === "departed") {
    candidates.push(
      transition({
        transitionId: visionTransitionId(vision?.edgeId, "departed"),
        kind: "presence.departed",
        category: "presence",
        occurredAt: vision?.departedAt ?? null,
      }),
    );
  }

  const categoryEntry = facts.categoryEntry;
  const categoryEntryChanged = semanticEdges.observeCategory(
    categoryEntry?.entryId ?? null,
  );
  if (categoryEntry && categoryEntryChanged) {
    candidates.push(
      transition({
        transitionId: `category:${categoryEntry.entryId}`,
        kind: "category.entered",
        category: "transaction",
        occurredAt: categoryEntry.enteredAt,
        productCategory: categoryEntry.category,
      }),
    );
  }

  const selectedProduct = facts.selectedProduct;
  const selectedProductChanged = semanticEdges.observeProduct(
    selectedProduct?.selectionId ?? null,
  );
  if (selectedProduct && selectedProductChanged) {
    candidates.push(
      transition({
        transitionId: `product:${selectedProduct.selectionId}`,
        kind: "product.selected",
        category: "transaction",
        occurredAt: selectedProduct.selectedAt,
        productCategory: selectedProduct.category,
      }),
    );
  }

  const transaction = facts.transaction;
  if (!transaction?.orderNo || !transaction.nextAction) return candidates;

  const orderNo = transaction.orderNo;
  if (transaction.nextAction === "closed") {
    transactionEdges.clear(orderNo);
    return candidates;
  }
  const transactionCandidates: CustomerJourneyTransition[] = [];
  const occurredAt = transaction.updatedAt;
  if (transaction.nextAction === "wait_payment") {
    transactionCandidates.push(
      transactionTransition(
        orderNo,
        "payment-prompt",
        "payment.prompt",
        occurredAt,
      ),
    );
  }
  if (paymentSucceededAction(transaction.nextAction)) {
    transactionCandidates.push(
      transactionTransition(
        orderNo,
        "payment-succeeded",
        "payment.succeeded",
        occurredAt,
      ),
    );
  }
  if (transaction.nextAction === "dispensing") {
    transactionCandidates.push(
      transactionTransition(
        orderNo,
        "dispensing-started",
        "dispensing.started",
        occurredAt,
      ),
    );
  }

  const reminder = transaction.vending?.pickupReminder ?? null;
  if (reminder) {
    transactionEdges.markPickupSeen(orderNo);
    switch (reminder.stage) {
      case "outlet_opened":
        transactionCandidates.push(
          transactionTransition(
            orderNo,
            "pickup-outlet-opened",
            "pickup.outlet_opened",
            reminder.reportedAt,
          ),
        );
        break;
      case "pickup_waiting":
        transactionCandidates.push(
          transactionTransition(
            orderNo,
            "pickup-waiting",
            "pickup.waiting",
            reminder.reportedAt,
          ),
        );
        break;
      case "pickup_timeout_warning": {
        const urgent =
          reminder.level === "urgent" || (reminder.warningNo ?? 0) >= 2;
        const warningNo = urgent ? 2 : 1;
        transactionCandidates.push(
          transactionTransition(
            orderNo,
            `pickup-warning-${warningNo}`,
            urgent ? "pickup.urgent" : "pickup.warning",
            reminder.reportedAt,
          ),
        );
        break;
      }
      case "pickup_completed":
        transactionCandidates.push(
          transactionTransition(
            orderNo,
            "pickup-completed",
            "pickup.completed",
            reminder.reportedAt,
          ),
        );
        break;
      case null:
      case undefined:
        break;
    }
  } else if (
    transaction.nextAction === "dispensing" &&
    transactionEdges.hasPickupSeen(orderNo)
  ) {
    transactionCandidates.push(
      transactionTransition(
        orderNo,
        "pickup-resetting",
        "pickup.resetting",
        occurredAt,
      ),
    );
  }

  switch (transaction.nextAction) {
    case "success":
      transactionCandidates.push(
        transactionTransition(
          orderNo,
          "pickup-completed",
          "pickup.completed",
          occurredAt,
        ),
      );
      transactionCandidates.push(
        transactionTransition(
          orderNo,
          "dispense-succeeded",
          "dispense.succeeded",
          occurredAt,
        ),
      );
      break;
    case "payment_failed":
    case "payment_expired":
      transactionCandidates.push(
        transactionTransition(
          orderNo,
          "payment-failed",
          "payment.failed",
          occurredAt,
        ),
      );
      break;
    case "dispense_failed":
      transactionCandidates.push(
        transactionTransition(
          orderNo,
          "dispense-failed",
          "dispense.failed",
          occurredAt,
        ),
      );
      break;
    case "refund_pending":
      transactionCandidates.push(
        transactionTransition(
          orderNo,
          "refund-pending",
          "refund.pending",
          occurredAt,
        ),
      );
      break;
    case "refunded":
      transactionCandidates.push(
        transactionTransition(
          orderNo,
          "refund-completed",
          "refund.completed",
          occurredAt,
        ),
      );
      break;
    case "manual_handling":
      transactionCandidates.push(
        transactionTransition(
          orderNo,
          "manual-handling",
          "manual_handling.required",
          occurredAt,
        ),
      );
      break;
    case "dispensing":
    case "wait_payment":
      break;
    default:
      break;
  }
  candidates.push(
    ...transactionCandidates.filter((candidate) =>
      transactionEdges.claim(orderNo, candidate.transitionId),
    ),
  );
  return candidates;
}

type VisionEdge = "crowd" | "welcome" | "departed" | null;

type SemanticEdgeMemory = {
  observeTouchscreen(active: boolean): boolean;
  nextTouchscreenTransitionId(): string;
  observeVision(
    edgeId: string | null,
    edge: "arrival" | "departure" | null,
    occupancyState: "none" | "single" | "multiple" | "unknown",
  ): VisionEdge;
  observeCategory(entryId: string | null): boolean;
  observeProduct(selectionId: string | null): boolean;
};

function createSemanticEdgeMemory(): SemanticEdgeMemory {
  let touchscreenActive = false;
  let touchscreenEpoch = 0;
  const claimedVisionEdges = new Set<string>();
  let categoryEntryId: string | null = null;
  let selectedProductId: string | null = null;

  return {
    observeTouchscreen(active) {
      const awakened = active && !touchscreenActive;
      touchscreenActive = active;
      if (awakened) touchscreenEpoch += 1;
      return awakened;
    },
    nextTouchscreenTransitionId() {
      return `touchscreen:session-${touchscreenEpoch}:awakened`;
    },
    observeVision(edgeId, edge, occupancyState) {
      if (!edgeId || !edge || claimedVisionEdges.has(edgeId)) return null;
      claimedVisionEdges.add(edgeId);
      if (claimedVisionEdges.size > TRANSACTION_ORDER_MEMORY_LIMIT) {
        const oldest = claimedVisionEdges.values().next().value;
        if (oldest) claimedVisionEdges.delete(oldest);
      }
      if (edge === "departure") return "departed";
      return occupancyState === "multiple" ? "crowd" : "welcome";
    },
    observeCategory(entryId) {
      const entered = entryId !== null && entryId !== categoryEntryId;
      categoryEntryId = entryId;
      return entered;
    },
    observeProduct(selectionId) {
      const selected =
        selectionId !== null && selectionId !== selectedProductId;
      selectedProductId = selectionId;
      return selected;
    },
  };
}

type TransactionEdgeState = {
  levels: Set<string>;
  pickupSeen: boolean;
};

type TransactionEdgeMemory = {
  claim(orderNo: string, level: string): boolean;
  markPickupSeen(orderNo: string): void;
  hasPickupSeen(orderNo: string): boolean;
  clear(orderNo: string): void;
  memoryUsage(): CustomerJourneyTransitionProjectorMemoryUsage;
};

function createTransactionEdgeMemory(): TransactionEdgeMemory {
  const orders = new Map<string, TransactionEdgeState>();

  function stateFor(orderNo: string): TransactionEdgeState {
    const existing = orders.get(orderNo);
    if (existing) {
      orders.delete(orderNo);
      orders.set(orderNo, existing);
      return existing;
    }
    const state = { levels: new Set<string>(), pickupSeen: false };
    orders.set(orderNo, state);
    if (orders.size > TRANSACTION_ORDER_MEMORY_LIMIT) {
      const oldestOrderNo = orders.keys().next().value;
      if (oldestOrderNo) orders.delete(oldestOrderNo);
    }
    return state;
  }

  return {
    claim(orderNo, level) {
      const state = stateFor(orderNo);
      if (state.levels.has(level)) return false;
      state.levels.add(level);
      return true;
    },
    markPickupSeen(orderNo) {
      stateFor(orderNo).pickupSeen = true;
    },
    hasPickupSeen(orderNo) {
      return stateFor(orderNo).pickupSeen;
    },
    clear(orderNo) {
      orders.delete(orderNo);
    },
    memoryUsage() {
      return {
        transactionOrders: orders.size,
        pickupSeenOrders: [...orders.values()].filter(
          (state) => state.pickupSeen,
        ).length,
        maxTransactionOrders: TRANSACTION_ORDER_MEMORY_LIMIT,
      };
    },
  };
}

function visionTransitionId(
  edgeId: string | null | undefined,
  kind: Exclude<VisionEdge, null>,
): string {
  const stableSessionId = edgeId
    ? edgeId.replace(/:(arrival|departure)$/, "")
    : "presence-unknown";
  return `vision:${stableSessionId}:${kind}`;
}

function candidateRestored(
  transition: CustomerJourneyTransition,
  facts: CustomerJourneyFacts,
): boolean {
  if (transition.transitionId.startsWith("touchscreen:")) {
    return facts.touchscreen?.restored === true;
  }
  if (transition.transitionId.startsWith("vision:")) {
    return facts.vision?.restored === true;
  }
  if (transition.transitionId.startsWith("category:")) {
    return facts.categoryEntry?.restored === true;
  }
  if (transition.transitionId.startsWith("product:")) {
    return facts.selectedProduct?.restored === true;
  }
  return facts.transaction?.restored === true;
}

function paymentSucceededAction(
  nextAction: NonNullable<CustomerJourneyFacts["transaction"]>["nextAction"],
): boolean {
  return [
    "dispensing",
    "success",
    "dispense_failed",
    "refund_pending",
    "refunded",
    "manual_handling",
  ].includes(nextAction ?? "");
}

function transactionTransition(
  orderNo: string,
  identity: string,
  kind: CustomerJourneyTransitionKind,
  occurredAt: string,
): CustomerJourneyTransition {
  return transition({
    transitionId: `transaction:${orderNo}:${identity}`,
    kind,
    category: "transaction",
    orderNo,
    occurredAt,
  });
}

function transition(
  input: Omit<CustomerJourneyTransition, "orderNo" | "productCategory"> & {
    orderNo?: string | null;
    productCategory?: string | null;
  },
): CustomerJourneyTransition {
  return {
    transitionId: input.transitionId,
    kind: input.kind,
    category: input.category,
    orderNo: input.orderNo ?? null,
    occurredAt: input.occurredAt,
    productCategory: input.productCategory ?? null,
  };
}
