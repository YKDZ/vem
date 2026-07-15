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
  transactionId: z.string().min(1),
  paymentUrl: z.url(),
});

export const installedKioskSaleTimelineEntrySchema =
  linkedTransactionIdentitySchema.extend({
    observedAt: z.iso.datetime(),
    route: installedKioskSaleRouteSchema,
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
  }),
  transaction: z.object({
    transactionId: z.string().min(1),
    orderId: z.string().min(1),
    paymentId: z.string().min(1),
    reservationId: z.string().min(1),
    status: z.enum(["awaiting_payment", "dispensing", "succeeded", "failed"]),
  }),
  vendingCommand: z
    .object({
      commandId: z.string().min(1),
      orderId: z.string().min(1),
      transactionId: z.string().min(1),
      status: z.enum(["sent", "succeeded", "failed"]),
    })
    .nullable(),
  stockMovement: z
    .object({
      movementId: z.string().min(1),
      orderId: z.string().min(1),
      transactionId: z.string().min(1),
      commandId: z.string().min(1),
      quantity: z.number().int(),
      status: z.enum(["pending", "accepted", "rejected"]),
    })
    .nullable(),
  fulfillment: z
    .object({
      status: z.enum(["succeeded", "failed"]),
      orderId: z.string().min(1),
      transactionId: z.string().min(1),
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
  count: z.number().int().nonnegative(),
  outcome: z.enum(["completed", "failed"]),
});

export type InstalledKioskSaleDisturbanceInjection = z.infer<
  typeof installedKioskSaleDisturbanceInjectionSchema
>;

export const browserInstalledKioskSaleContractFactsSchema = z.object({
  source: z.literal("browser_ui_contract"),
  transactions: z.array(installedKioskSaleLinkedTransactionSchema),
  timeline: z.array(installedKioskSaleTimelineEntrySchema),
  disturbanceInjections: z.array(installedKioskSaleDisturbanceInjectionSchema),
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
        command.transactionId === transaction.transactionId)) &&
    (!movement ||
      (movement.orderId === order.orderId &&
        movement.transactionId === transaction.transactionId &&
        movement.commandId === command?.commandId)) &&
    (!fulfillment ||
      (fulfillment.orderId === order.orderId &&
        fulfillment.transactionId === transaction.transactionId &&
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
    command.orderId === order.orderId &&
    command.transactionId === transaction.transactionId &&
    movement.status === "accepted" &&
    movement.quantity === -1 &&
    movement.orderId === order.orderId &&
    movement.transactionId === transaction.transactionId &&
    movement.commandId === command.commandId &&
    fulfillment.status === "succeeded" &&
    fulfillment.orderId === order.orderId &&
    fulfillment.transactionId === transaction.transactionId &&
    fulfillment.commandId === command.commandId &&
    fulfillment.stockMovementId === movement.movementId,
  );
}

function inspectTimeline(
  facts: BrowserInstalledKioskSaleContractFacts,
  record: InstalledKioskSaleLinkedTransaction,
  diagnostics: BrowserInstalledKioskSaleContractReport["diagnostics"],
): void {
  const paymentIndex = facts.timeline.findIndex(
    (entry) => entry.route === "payment",
  );
  const terminalIndex = facts.timeline.findIndex(
    (entry, index) => index >= paymentIndex && entry.route === "result",
  );
  if (paymentIndex === -1 || terminalIndex === -1) {
    addDiagnostic(
      diagnostics,
      "payment_to_terminal_timeline_missing",
      "UI contract timeline must include Payment followed by an explicit result.",
    );
    return;
  }

  const activeTimeline = facts.timeline.slice(paymentIndex, terminalIndex + 1);
  if (!activeTimeline.some((entry) => entry.route === "fulfillment")) {
    addDiagnostic(
      diagnostics,
      "fulfillment_route_missing",
      "UI contract timeline must observe Fulfillment before the result.",
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
      entry.orderId !== record.order.orderId ||
      entry.paymentId !== record.payment.paymentId ||
      entry.transactionId !== record.transaction.transactionId
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
  }
}

function inspectDisturbance(
  facts: BrowserInstalledKioskSaleContractFacts,
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
    inspectTimeline(facts, record, diagnostics);
  }
  inspectDisturbance(facts, diagnostics);

  return browserInstalledKioskSaleContractReportSchema.parse({
    schemaVersion: "installed-kiosk-sale-ui-contract/v1",
    source: "browser_ui_contract",
    assertionScope: "ui_contract_only",
    status: diagnostics.length === 0 ? "passed" : "failed",
    diagnostics,
  });
}
