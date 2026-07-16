import { z } from "zod";

export const installedKioskSaleDisturbanceSchema = z.enum([
  "catalog_refresh",
  "readiness_refresh",
  "presence_departure",
  "duplicate_payment_status",
  "ipc_interruption",
]);

export type InstalledKioskSaleDisturbance = z.infer<
  typeof installedKioskSaleDisturbanceSchema
>;

export const installedKioskSaleRouteSchema = z.enum([
  "home",
  "product",
  "checkout",
  "payment",
  "fulfillment",
  "result",
  "maintenance",
  "offline",
  "other",
]);

const linkedTransactionIdentitySchema = z.object({
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  orderNo: z.string().min(1),
  paymentUrl: z.url(),
});

export const installedKioskSaleCustomerPaymentSurfaceSchema = z.object({
  observedAt: z.iso.datetime(),
  orderId: z.string().min(1),
  paymentId: z.string().min(1),
  orderNo: z.string().min(1),
  paymentUrl: z.url(),
  renderedQrSource: z.string().min(1),
  decodedQrPayload: z.url(),
});

export type InstalledKioskSaleCustomerPaymentSurface = z.infer<
  typeof installedKioskSaleCustomerPaymentSurfaceSchema
>;

export const installedKioskSaleCustomerTransactionSurfaceSchema =
  linkedTransactionIdentitySchema.extend({
    observedAt: z.iso.datetime(),
    route: z.enum(["fulfillment", "result"]),
    commandId: z.string().min(1),
  });

export type InstalledKioskSaleCustomerTransactionSurface = z.infer<
  typeof installedKioskSaleCustomerTransactionSurfaceSchema
>;

export const installedKioskSaleTimelineEntrySchema =
  linkedTransactionIdentitySchema.extend({
    observationId: z.string().min(1),
    observedAt: z.iso.datetime(),
    route: installedKioskSaleRouteSchema,
    identitySource: z.enum([
      "customer_payment_surface",
      "customer_fulfillment_surface",
      "customer_result_surface",
      "router_transaction_state",
    ]),
    renderedQrSource: z.string().min(1).nullable(),
    decodedQrPayload: z.string().min(1).nullable(),
    commandId: z.string().min(1).nullable(),
  });

export const installedKioskSaleLinkedTransactionSchema = z.object({
  checkout: z.object({
    idempotencyKey: z.string().min(1),
  }),
  order: z.object({
    orderId: z.string().min(1),
    checkoutIdempotencyKey: z.string().min(1),
    status: z.enum(["pending_payment", "dispensing", "fulfilled", "failed"]),
  }),
  reservation: z.object({
    reservationId: z.string().min(1),
    orderId: z.string().min(1),
    status: z.enum(["reserved", "consumed", "released"]),
  }),
  payment: z.object({
    paymentId: z.string().min(1),
    orderId: z.string().min(1),
    reservationId: z.string().min(1),
    paymentUrl: z.url(),
    status: z.enum(["processing", "succeeded", "failed"]),
    statusDeliveries: z.array(
      z.object({
        deliveryId: z.string().min(1),
        status: z.enum(["succeeded", "failed"]),
        deliveredAt: z.iso.datetime(),
        payload: z.object({
          orderId: z.string().min(1),
          paymentId: z.string().min(1),
          orderNo: z.string().min(1),
          paymentStatus: z.enum(["succeeded", "failed"]),
        }),
      }),
    ),
  }),
  transaction: z.object({
    orderNo: z.string().min(1),
    orderId: z.string().min(1),
    paymentId: z.string().min(1),
    reservationId: z.string().min(1),
    status: z.enum(["awaiting_payment", "dispensing", "succeeded", "failed"]),
  }),
  vendingCommand: z
    .object({
      commandId: z.string().min(1),
      orderId: z.string().min(1),
      orderNo: z.string().min(1),
      status: z.enum(["sent", "succeeded", "failed"]),
      creationCount: z.number().int().nonnegative(),
    })
    .nullable(),
  stockMovement: z
    .object({
      movementId: z.string().min(1),
      orderId: z.string().min(1),
      orderNo: z.string().min(1),
      commandId: z.string().min(1),
      quantity: z.number().int(),
      status: z.enum(["pending", "accepted", "rejected"]),
      creationCount: z.number().int().nonnegative(),
    })
    .nullable(),
  fulfillment: z
    .object({
      status: z.enum(["succeeded", "failed"]),
      orderId: z.string().min(1),
      orderNo: z.string().min(1),
      commandId: z.string().min(1),
      stockMovementId: z.string().min(1),
    })
    .nullable(),
});

export type InstalledKioskSaleLinkedTransaction = z.infer<
  typeof installedKioskSaleLinkedTransactionSchema
>;

export const installedKioskSaleDisturbanceInjectionSchema = z.object({
  injectionId: z.string().min(1),
  kind: installedKioskSaleDisturbanceSchema,
  injectedAt: z.iso.datetime(),
  barrier: z.literal("payment_qr_presented"),
  barrierObservationId: z.string().min(1),
  count: z.number().int().nonnegative(),
  outcome: z.enum(["completed", "failed"]),
  pressure: z
    .object({
      refreshedState: z.enum(["catalog", "readiness"]),
      attemptedRoute: z.string().min(1),
      resolvedRoute: z.string().min(1),
      routeAuthorityWon: z.boolean(),
    })
    .nullable(),
});

export type InstalledKioskSaleDisturbanceInjection = z.infer<
  typeof installedKioskSaleDisturbanceInjectionSchema
>;

export const browserInstalledKioskSaleContractFactsSchema = z.object({
  source: z.literal("browser_ui_contract"),
  transactions: z.array(installedKioskSaleLinkedTransactionSchema),
  timeline: z.array(installedKioskSaleTimelineEntrySchema),
  disturbanceInjections: z.array(installedKioskSaleDisturbanceInjectionSchema),
  observationWindow: z.object({
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime(),
  }),
});

export type BrowserInstalledKioskSaleContractFacts = z.infer<
  typeof browserInstalledKioskSaleContractFactsSchema
>;

export const browserInstalledKioskSaleContractDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const browserInstalledKioskSaleContractReportSchema = z.object({
  schemaVersion: z.literal("installed-kiosk-sale-ui-contract/v1"),
  source: z.literal("browser_ui_contract"),
  assertionScope: z.literal("ui_contract_only"),
  status: z.enum(["passed", "failed"]),
  diagnostics: z.array(browserInstalledKioskSaleContractDiagnosticSchema),
});

export type BrowserInstalledKioskSaleContractReport = z.infer<
  typeof browserInstalledKioskSaleContractReportSchema
>;

function addDiagnostic(
  diagnostics: BrowserInstalledKioskSaleContractReport["diagnostics"],
  code: string,
  message: string,
): void {
  diagnostics.push({ code, message });
}

function transactionBindingsMatch(
  record: InstalledKioskSaleLinkedTransaction,
): boolean {
  const { order, reservation, payment, transaction } = record;
  const command = record.vendingCommand;
  const movement = record.stockMovement;
  const fulfillment = record.fulfillment;
  return (
    order.checkoutIdempotencyKey === record.checkout.idempotencyKey &&
    reservation.orderId === order.orderId &&
    payment.orderId === order.orderId &&
    payment.reservationId === reservation.reservationId &&
    transaction.orderId === order.orderId &&
    transaction.paymentId === payment.paymentId &&
    transaction.reservationId === reservation.reservationId &&
    (!command ||
      (command.orderId === order.orderId &&
        command.orderNo === transaction.orderNo)) &&
    (!movement ||
      (movement.orderId === order.orderId &&
        movement.orderNo === transaction.orderNo &&
        movement.commandId === command?.commandId)) &&
    (!fulfillment ||
      (fulfillment.orderId === order.orderId &&
        fulfillment.orderNo === transaction.orderNo &&
        fulfillment.commandId === command?.commandId &&
        fulfillment.stockMovementId === movement?.movementId))
  );
}

function finalFulfillmentMatches(
  record: InstalledKioskSaleLinkedTransaction,
): boolean {
  const { order, reservation, payment, transaction } = record;
  const command = record.vendingCommand;
  const movement = record.stockMovement;
  const fulfillment = record.fulfillment;
  return Boolean(
    command &&
    movement &&
    fulfillment &&
    order.status === "fulfilled" &&
    reservation.status === "consumed" &&
    payment.status === "succeeded" &&
    transaction.status === "succeeded" &&
    command.status === "succeeded" &&
    command.creationCount === 1 &&
    command.orderId === order.orderId &&
    command.orderNo === transaction.orderNo &&
    movement.status === "accepted" &&
    movement.creationCount === 1 &&
    movement.quantity === -1 &&
    movement.orderId === order.orderId &&
    movement.orderNo === transaction.orderNo &&
    movement.commandId === command.commandId &&
    fulfillment.status === "succeeded" &&
    fulfillment.orderId === order.orderId &&
    fulfillment.orderNo === transaction.orderNo &&
    fulfillment.commandId === command.commandId &&
    fulfillment.stockMovementId === movement.movementId,
  );
}

function inspectSideEffectCounts(
  facts: BrowserInstalledKioskSaleContractFacts,
  record: InstalledKioskSaleLinkedTransaction,
  diagnostics: BrowserInstalledKioskSaleContractReport["diagnostics"],
): void {
  const injection = facts.disturbanceInjections[0];
  const deliveries = record.payment.statusDeliveries;
  const expectedDeliveryCount =
    injection?.kind === "duplicate_payment_status" ? 2 : 1;
  const firstDelivery = deliveries[0];
  const deliveriesMatch = deliveries.every(
    (delivery) =>
      delivery.status === "succeeded" &&
      delivery.deliveryId === firstDelivery?.deliveryId &&
      delivery.payload.orderId === record.order.orderId &&
      delivery.payload.paymentId === record.payment.paymentId &&
      delivery.payload.orderNo === record.transaction.orderNo &&
      delivery.payload.paymentStatus === "succeeded" &&
      JSON.stringify(delivery.payload) ===
        JSON.stringify(firstDelivery?.payload),
  );
  if (deliveries.length !== expectedDeliveryCount || !deliveriesMatch) {
    addDiagnostic(
      diagnostics,
      "payment_status_delivery_count_mismatch",
      "The UI contract must observe one success delivery, or the same success exactly twice for the duplicate-status disturbance.",
    );
  }
  if (
    record.vendingCommand?.creationCount !== 1 ||
    record.stockMovement?.creationCount !== 1
  ) {
    addDiagnostic(
      diagnostics,
      "fulfillment_side_effect_count_mismatch",
      "A linked transaction must create exactly one vending command and one stock movement.",
    );
  }
}

function inspectTimeline(
  facts: BrowserInstalledKioskSaleContractFacts,
  record: InstalledKioskSaleLinkedTransaction,
  diagnostics: BrowserInstalledKioskSaleContractReport["diagnostics"],
): void {
  if (
    new Set(facts.timeline.map((entry) => entry.observationId)).size !==
    facts.timeline.length
  ) {
    addDiagnostic(
      diagnostics,
      "timeline_observation_id_not_unique",
      "Every timeline observationId must be globally unique.",
    );
  }
  const timestamps = facts.timeline.map((entry) =>
    Date.parse(entry.observedAt),
  );
  if (
    timestamps.some(
      (timestamp, index) => index > 0 && timestamp < timestamps[index - 1],
    )
  ) {
    addDiagnostic(
      diagnostics,
      "timeline_observed_at_not_nondecreasing",
      "UI contract observations must be recorded in nondecreasing timestamp order.",
    );
  }
  const paymentIndex = facts.timeline.findIndex(
    (entry) => entry.route === "payment",
  );
  const terminalIndex = facts.timeline.findIndex(
    (entry, index) => index >= paymentIndex && entry.route === "result",
  );
  const fulfillmentIndex = facts.timeline.findIndex(
    (entry) => entry.route === "fulfillment",
  );
  if (paymentIndex === -1 || terminalIndex === -1) {
    addDiagnostic(
      diagnostics,
      "payment_to_terminal_timeline_missing",
      "UI contract timeline must include Payment followed by an explicit result.",
    );
    return;
  }

  const paymentTimestamp = Date.parse(facts.timeline[paymentIndex].observedAt);
  const terminalTimestamp = Date.parse(
    facts.timeline[terminalIndex].observedAt,
  );
  const observationWindowClosedAt = Date.parse(
    facts.observationWindow.closedAt,
  );
  if (
    Date.parse(facts.observationWindow.openedAt) > paymentTimestamp ||
    observationWindowClosedAt < terminalTimestamp
  ) {
    addDiagnostic(
      diagnostics,
      "observation_window_invalid",
      "The bounded observation window must open by Payment and close after the first Result.",
    );
  }
  const activeTimeline = facts.timeline.filter((entry) => {
    const timestamp = Date.parse(entry.observedAt);
    return (
      timestamp >= paymentTimestamp && timestamp <= observationWindowClosedAt
    );
  });
  if (!activeTimeline.some((entry) => entry.route === "fulfillment")) {
    addDiagnostic(
      diagnostics,
      "fulfillment_route_missing",
      "UI contract timeline must observe Fulfillment before the result.",
    );
  }
  if (
    fulfillmentIndex === -1 ||
    paymentIndex >= fulfillmentIndex ||
    fulfillmentIndex >= terminalIndex
  ) {
    addDiagnostic(
      diagnostics,
      "timeline_route_sequence_invalid",
      "Timeline indexes must strictly order Payment before Fulfillment before Result.",
    );
  }
  const hasPostResultObservation = facts.timeline.some(
    (entry, index) =>
      index > terminalIndex &&
      Date.parse(entry.observedAt) <= observationWindowClosedAt,
  );
  if (!hasPostResultObservation) {
    addDiagnostic(
      diagnostics,
      "post_result_observation_missing",
      "The bounded observation window must include an observation after the first Result.",
    );
  }
  for (const entry of activeTimeline) {
    if (!new Set(["payment", "fulfillment", "result"]).has(entry.route)) {
      addDiagnostic(
        diagnostics,
        "active_transaction_route_replaced",
        "Home, Maintenance, and unrelated routes cannot replace an active transaction.",
      );
      break;
    }
    if (
      entry.route === "payment" &&
      entry.identitySource !== "customer_payment_surface"
    ) {
      addDiagnostic(
        diagnostics,
        "payment_identity_not_customer_surface_observed",
        "Payment observations must derive from the QR and identities rendered to the customer.",
      );
      break;
    }
    if (
      entry.route === "fulfillment" &&
      (entry.identitySource !== "customer_fulfillment_surface" ||
        entry.commandId !== record.vendingCommand?.commandId)
    ) {
      addDiagnostic(
        diagnostics,
        "fulfillment_identity_not_customer_surface_observed",
        "Fulfillment observations must derive from the rendered customer surface and command identity.",
      );
      break;
    }
    if (
      entry.route === "result" &&
      (entry.identitySource !== "customer_result_surface" ||
        entry.commandId !== record.vendingCommand?.commandId)
    ) {
      addDiagnostic(
        diagnostics,
        "result_identity_not_customer_surface_observed",
        "Result observations must derive from the rendered customer surface and command identity.",
      );
      break;
    }
    if (
      entry.orderId !== record.order.orderId ||
      entry.paymentId !== record.payment.paymentId ||
      entry.orderNo !== record.transaction.orderNo
    ) {
      addDiagnostic(
        diagnostics,
        "timeline_transaction_identity_mismatch",
        "Every UI route observation must carry the linked order, payment, and transaction identity.",
      );
      break;
    }
    if (entry.paymentUrl !== record.payment.paymentUrl) {
      addDiagnostic(
        diagnostics,
        "timeline_payment_qr_mismatch",
        "Every UI route observation must retain the QR bound to the linked payment.",
      );
      break;
    }
    if (
      entry.route === "payment" &&
      (entry.renderedQrSource === null ||
        entry.decodedQrPayload === null ||
        entry.decodedQrPayload !== entry.paymentUrl)
    ) {
      addDiagnostic(
        diagnostics,
        "rendered_payment_qr_source_mismatch",
        "The loaded rendered QR image must decode to the declared linked transaction payment URL.",
      );
      break;
    }
  }
}

function inspectDisturbance(
  facts: BrowserInstalledKioskSaleContractFacts,
  record: InstalledKioskSaleLinkedTransaction | undefined,
  diagnostics: BrowserInstalledKioskSaleContractReport["diagnostics"],
): void {
  const injections = facts.disturbanceInjections;
  if (injections.length !== 1) {
    addDiagnostic(
      diagnostics,
      "disturbance_not_exactly_once",
      "Browser UI contract requires exactly one deterministic disturbance injection.",
    );
  }
  if (
    new Set(injections.map((entry) => entry.injectionId)).size !==
    injections.length
  ) {
    addDiagnostic(
      diagnostics,
      "disturbance_injection_id_not_unique",
      "Every disturbance injection must have a unique injectionId.",
    );
  }
  for (const injection of injections) {
    if (injection.count !== 1) {
      addDiagnostic(
        diagnostics,
        "disturbance_count_not_exactly_once",
        "Each deterministic disturbance must be injected exactly once.",
      );
    }
    if (injection.outcome !== "completed") {
      addDiagnostic(
        diagnostics,
        "disturbance_outcome_not_completed",
        "The deterministic disturbance must complete at the declared barrier.",
      );
    }
    const barrierMatches = facts.timeline.filter(
      (entry) => entry.observationId === injection.barrierObservationId,
    );
    const barrierObservation = barrierMatches[0];
    if (
      !record ||
      barrierMatches.length !== 1 ||
      !barrierObservation ||
      barrierObservation.route !== "payment" ||
      barrierObservation.identitySource !== "customer_payment_surface" ||
      barrierObservation.orderId !== record.order.orderId ||
      barrierObservation.paymentId !== record.payment.paymentId ||
      barrierObservation.paymentUrl !== record.payment.paymentUrl ||
      barrierObservation.renderedQrSource === null ||
      barrierObservation.decodedQrPayload !== barrierObservation.paymentUrl
    ) {
      addDiagnostic(
        diagnostics,
        "disturbance_barrier_payment_qr_mismatch",
        "The disturbance barrier must reference the observed customer payment QR for the linked transaction.",
      );
    }
    if (
      injection.kind === "catalog_refresh" ||
      injection.kind === "readiness_refresh"
    ) {
      const expectedState =
        injection.kind === "catalog_refresh" ? "catalog" : "readiness";
      if (
        injection.pressure?.refreshedState !== expectedState ||
        !injection.pressure.routeAuthorityWon ||
        injection.pressure.attemptedRoute ===
          injection.pressure.resolvedRoute ||
        injection.pressure.resolvedRoute !== "/payment"
      ) {
        addDiagnostic(
          diagnostics,
          "competing_navigation_pressure_not_resolved",
          "Catalog and readiness disturbances must compete with the active transaction route and prove route authority wins.",
        );
      }
    } else if (injection.pressure !== null) {
      addDiagnostic(
        diagnostics,
        "unexpected_competing_navigation_pressure",
        "Only catalog and readiness disturbances may report competing navigation pressure.",
      );
    }
    const paymentEntry = facts.timeline.find(
      (entry) => entry.route === "payment",
    );
    const resultEntry = facts.timeline.find(
      (entry) => entry.route === "result",
    );
    if (
      !paymentEntry ||
      !resultEntry ||
      Date.parse(injection.injectedAt) < Date.parse(paymentEntry.observedAt) ||
      Date.parse(injection.injectedAt) > Date.parse(resultEntry.observedAt) ||
      (barrierObservation &&
        Date.parse(injection.injectedAt) <
          Date.parse(barrierObservation.observedAt))
    ) {
      addDiagnostic(
        diagnostics,
        "disturbance_outside_payment_result_interval",
        "The disturbance must be injected after its observed payment QR barrier and no later than the result.",
      );
    }
  }
}

/**
 * Classifies only browser UI mock contract evidence. It does not assert a
 * platform transaction, Windows runtime, Factory image, or physical sale.
 */
export function classifyBrowserInstalledKioskSaleContract(
  input: BrowserInstalledKioskSaleContractFacts,
): BrowserInstalledKioskSaleContractReport {
  const facts = browserInstalledKioskSaleContractFactsSchema.parse(input);
  const diagnostics: BrowserInstalledKioskSaleContractReport["diagnostics"] =
    [];

  if (facts.transactions.length !== 1) {
    addDiagnostic(
      diagnostics,
      "transaction_record_not_exactly_once",
      "Browser UI contract requires exactly one linked transaction record.",
    );
  }
  const record = facts.transactions[0];
  if (record) {
    if (!transactionBindingsMatch(record)) {
      addDiagnostic(
        diagnostics,
        "transaction_identity_binding_mismatch",
        "Checkout, order, reservation, payment, and transaction identities must remain linked.",
      );
    }
    if (!finalFulfillmentMatches(record)) {
      addDiagnostic(
        diagnostics,
        "final_fulfillment_not_successful",
        "The linked UI mock transaction must finish one successful fulfillment and accepted stock movement.",
      );
    }
    inspectSideEffectCounts(facts, record, diagnostics);
    inspectTimeline(facts, record, diagnostics);
  }
  inspectDisturbance(facts, record, diagnostics);

  return browserInstalledKioskSaleContractReportSchema.parse({
    schemaVersion: "installed-kiosk-sale-ui-contract/v1",
    source: "browser_ui_contract",
    assertionScope: "ui_contract_only",
    status: diagnostics.length === 0 ? "passed" : "failed",
    diagnostics,
  });
}
