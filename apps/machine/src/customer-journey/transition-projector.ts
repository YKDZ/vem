export type CustomerJourneyTransitionKind =
  | "touchscreen.awakened"
  | "presence.welcome"
  | "privacy.crowd_detected"
  | "presence.departed"
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
    source: "local_interaction" | "vision" | "inactivity" | "unavailable";
    lastInteractionAt: string | null;
    restored?: boolean;
  } | null;
  vision?: {
    personPresent: boolean;
    occupancyState: "none" | "single" | "multiple" | "unknown";
    lastSeenAt: string | null;
    departedAt: string | null;
    lastChangedAt: string | null;
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
};

const TRANSITION_MEMORY_LIMIT = 256;

export function createCustomerJourneyTransitionProjector(): CustomerJourneyTransitionProjector {
  const emittedTransitionIds = new Set<string>();
  const pickupSeenByOrder = new Map<string, boolean>();
  const semanticEdges = createSemanticEdgeMemory();

  return {
    project(facts) {
      const candidates = projectCandidates(
        facts,
        pickupSeenByOrder,
        semanticEdges,
      );
      const transitions: CustomerJourneyTransition[] = [];
      for (const candidate of candidates) {
        if (candidateRestored(candidate, facts)) {
          rememberTransition(emittedTransitionIds, candidate.transitionId);
          continue;
        }
        if (emittedTransitionIds.has(candidate.transitionId)) continue;
        rememberTransition(emittedTransitionIds, candidate.transitionId);
        transitions.push(candidate);
      }
      return transitions;
    },
  };
}

function projectCandidates(
  facts: CustomerJourneyFacts,
  pickupSeenByOrder: Map<string, boolean>,
  semanticEdges: SemanticEdgeMemory,
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
  const visionProfile = profileForVision(vision);
  const visionEdge = semanticEdges.observeVision(
    visionProfile,
    vision?.departedAt !== null && vision?.departedAt !== undefined,
  );
  if (visionEdge === "crowd") {
    candidates.push(
      transition({
        transitionId: semanticEdges.nextVisionTransitionId("crowd"),
        kind: "privacy.crowd_detected",
        category: "presence",
        occurredAt: vision?.lastChangedAt ?? vision?.lastSeenAt ?? null,
      }),
    );
  } else if (visionEdge === "welcome") {
    candidates.push(
      transition({
        transitionId: semanticEdges.nextVisionTransitionId("welcome"),
        kind: "presence.welcome",
        category: "presence",
        occurredAt: vision?.lastChangedAt ?? vision?.lastSeenAt ?? null,
      }),
    );
  } else if (visionEdge === "departed") {
    candidates.push(
      transition({
        transitionId: semanticEdges.nextVisionTransitionId("departed"),
        kind: "presence.departed",
        category: "presence",
        occurredAt: vision?.departedAt ?? null,
      }),
    );
  }

  const selectedProduct = facts.selectedProduct;
  if (selectedProduct) {
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
  const occurredAt = transaction.updatedAt;
  if (transaction.nextAction === "wait_payment") {
    candidates.push(
      transactionTransition(
        orderNo,
        "payment-prompt",
        "payment.prompt",
        occurredAt,
      ),
    );
  }
  if (paymentSucceededAction(transaction.nextAction)) {
    candidates.push(
      transactionTransition(
        orderNo,
        "payment-succeeded",
        "payment.succeeded",
        occurredAt,
      ),
    );
  }
  if (transaction.nextAction === "dispensing") {
    candidates.push(
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
    pickupSeenByOrder.set(orderNo, true);
    switch (reminder.stage) {
      case "outlet_opened":
        candidates.push(
          transactionTransition(
            orderNo,
            "pickup-outlet-opened",
            "pickup.outlet_opened",
            reminder.reportedAt,
          ),
        );
        break;
      case "pickup_waiting":
        candidates.push(
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
        const warningNo = urgent ? Math.max(reminder.warningNo ?? 2, 2) : 1;
        candidates.push(
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
        candidates.push(
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
    pickupSeenByOrder.get(orderNo) === true
  ) {
    candidates.push(
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
      candidates.push(
        transactionTransition(
          orderNo,
          "pickup-completed",
          "pickup.completed",
          occurredAt,
        ),
      );
      candidates.push(
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
      candidates.push(
        transactionTransition(
          orderNo,
          "payment-failed",
          "payment.failed",
          occurredAt,
        ),
      );
      break;
    case "dispense_failed":
      candidates.push(
        transactionTransition(
          orderNo,
          "dispense-failed",
          "dispense.failed",
          occurredAt,
        ),
      );
      break;
    case "refund_pending":
      candidates.push(
        transactionTransition(
          orderNo,
          "refund-pending",
          "refund.pending",
          occurredAt,
        ),
      );
      break;
    case "refunded":
      candidates.push(
        transactionTransition(
          orderNo,
          "refund-completed",
          "refund.completed",
          occurredAt,
        ),
      );
      break;
    case "manual_handling":
      candidates.push(
        transactionTransition(
          orderNo,
          "manual-handling",
          "manual_handling.required",
          occurredAt,
        ),
      );
      break;
    case "closed":
    case "dispensing":
    case "wait_payment":
      break;
    default:
      break;
  }
  return candidates;
}

type VisionProfile = "absent" | "welcome" | "crowd";
type VisionEdge = Exclude<VisionProfile, "absent"> | "departed" | null;

type SemanticEdgeMemory = {
  observeTouchscreen(active: boolean): boolean;
  nextTouchscreenTransitionId(): string;
  observeVision(profile: VisionProfile, departureObserved: boolean): VisionEdge;
  nextVisionTransitionId(edge: Exclude<VisionEdge, null>): string;
};

function createSemanticEdgeMemory(): SemanticEdgeMemory {
  let touchscreenActive = false;
  let touchscreenEpoch = 0;
  let visionProfile: VisionProfile = "absent";
  let departureObserved = false;
  let visionEpoch = 0;

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
    observeVision(nextProfile, nextDepartureObserved) {
      const priorProfile = visionProfile;
      const priorDepartureObserved = departureObserved;
      visionProfile = nextProfile;
      departureObserved = nextDepartureObserved;

      if (nextProfile === "crowd" && priorProfile !== "crowd") {
        visionEpoch += 1;
        return "crowd";
      }
      if (nextProfile === "welcome" && priorProfile !== "welcome") {
        visionEpoch += 1;
        return "welcome";
      }
      if (
        nextProfile === "absent" &&
        nextDepartureObserved &&
        (!priorDepartureObserved || priorProfile !== "absent")
      ) {
        visionEpoch += 1;
        return "departed";
      }
      return null;
    },
    nextVisionTransitionId(edge) {
      return `vision:presence-${visionEpoch}:${edge}`;
    },
  };
}

function profileForVision(
  vision: CustomerJourneyFacts["vision"],
): VisionProfile {
  if (!vision?.personPresent) return "absent";
  return vision.occupancyState === "multiple" ? "crowd" : "welcome";
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

function rememberTransition(memory: Set<string>, transitionId: string): void {
  memory.add(transitionId);
  if (memory.size <= TRANSITION_MEMORY_LIMIT) return;
  const oldest = memory.values().next().value;
  if (oldest) memory.delete(oldest);
}
