import { z } from "zod";

export const installedKioskSaleProfileSchema = z.enum([
  "browser_fast_feedback",
  "windows_vm_runtime",
  "factory_iso_overlay",
]);

export const installedKioskSaleDisturbanceSchema = z.enum([
  "none",
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

export const installedKioskSaleTimelineEntrySchema = z.object({
  observedAt: z.iso.datetime(),
  route: installedKioskSaleRouteSchema,
  transactionId: z.string().min(1).nullable(),
});

const installedKioskSaleCorrelationSchema = z.object({
  checkoutIdempotencyKeys: z.array(z.string().min(1)),
  orderIds: z.array(z.string().min(1)),
  paymentIds: z.array(z.string().min(1)),
  reservationIds: z.array(z.string().min(1)),
  transactionIds: z.array(z.string().min(1)),
  vendingCommandIds: z.array(z.string().min(1)),
  stockMovementIds: z.array(z.string().min(1)),
  paymentUrls: z.array(z.url()),
});

export const installedKioskSaleAcceptanceFactsSchema = z.object({
  profile: installedKioskSaleProfileSchema,
  disturbance: installedKioskSaleDisturbanceSchema,
  correlation: installedKioskSaleCorrelationSchema,
  timeline: z.array(installedKioskSaleTimelineEntrySchema).min(1),
  counts: z.object({
    orderCreation: z.number().int().nonnegative(),
    paymentStatusDeliveries: z.number().int().nonnegative(),
    vendingCommandCreation: z.number().int().nonnegative(),
    stockMovementCreation: z.number().int().nonnegative(),
  }),
});

export type InstalledKioskSaleAcceptanceFacts = z.infer<
  typeof installedKioskSaleAcceptanceFactsSchema
>;

export const installedKioskSaleAcceptanceDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const installedKioskSaleAcceptanceReportSchema = z.object({
  schemaVersion: z.literal("installed-kiosk-sale-acceptance/v1"),
  status: z.enum(["passed", "failed"]),
  diagnostics: z.array(installedKioskSaleAcceptanceDiagnosticSchema),
});

export type InstalledKioskSaleAcceptanceReport = z.infer<
  typeof installedKioskSaleAcceptanceReportSchema
>;

function addDiagnostic(
  diagnostics: InstalledKioskSaleAcceptanceReport["diagnostics"],
  code: string,
  message: string,
): void {
  diagnostics.push({ code, message });
}

function requiresExactlyOne(
  diagnostics: InstalledKioskSaleAcceptanceReport["diagnostics"],
  values: readonly string[],
  code: string,
  label: string,
): void {
  if (values.length !== 1) {
    addDiagnostic(
      diagnostics,
      code,
      `Installed Kiosk Sale Acceptance requires exactly one ${label}.`,
    );
  }
}

/**
 * Shared acceptance oracle for the browser, Windows VM, and Factory overlay
 * drivers. Drivers collect facts; this function owns the business assertions.
 */
export function classifyInstalledKioskSaleAcceptance(
  input: InstalledKioskSaleAcceptanceFacts,
): InstalledKioskSaleAcceptanceReport {
  const facts = installedKioskSaleAcceptanceFactsSchema.parse(input);
  const diagnostics: InstalledKioskSaleAcceptanceReport["diagnostics"] = [];
  const correlation = facts.correlation;

  requiresExactlyOne(
    diagnostics,
    correlation.checkoutIdempotencyKeys,
    "checkout_idempotency_key_not_exactly_once",
    "checkout idempotency key",
  );
  requiresExactlyOne(
    diagnostics,
    correlation.orderIds,
    "order_not_exactly_once",
    "order",
  );
  requiresExactlyOne(
    diagnostics,
    correlation.paymentIds,
    "payment_not_exactly_once",
    "payment",
  );
  requiresExactlyOne(
    diagnostics,
    correlation.reservationIds,
    "reservation_not_exactly_once",
    "reservation",
  );
  requiresExactlyOne(
    diagnostics,
    correlation.transactionIds,
    "transaction_not_exactly_once",
    "transaction",
  );
  requiresExactlyOne(
    diagnostics,
    correlation.vendingCommandIds,
    "vending_command_not_exactly_once",
    "vending command",
  );
  requiresExactlyOne(
    diagnostics,
    correlation.stockMovementIds,
    "stock_movement_not_exactly_once",
    "stock movement",
  );
  requiresExactlyOne(
    diagnostics,
    correlation.paymentUrls,
    "payment_qr_not_exactly_once",
    "payment QR",
  );

  const countAssertions = [
    [facts.counts.orderCreation, "order_not_exactly_once", "order creation"],
    [
      facts.counts.vendingCommandCreation,
      "vending_command_not_exactly_once",
      "vending command creation",
    ],
    [
      facts.counts.stockMovementCreation,
      "stock_movement_not_exactly_once",
      "stock movement creation",
    ],
  ] as const;
  for (const [count, code, label] of countAssertions) {
    if (count !== 1) {
      addDiagnostic(
        diagnostics,
        code,
        `Installed Kiosk Sale Acceptance requires exactly one ${label}.`,
      );
    }
  }
  if (facts.counts.paymentStatusDeliveries < 1) {
    addDiagnostic(
      diagnostics,
      "payment_status_missing",
      "Installed Kiosk Sale Acceptance requires a payment status delivery.",
    );
  }

  const transactionId = correlation.transactionIds[0] ?? null;
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
      "Timeline must include the active Payment route followed by an explicit terminal result.",
    );
  } else {
    for (const entry of facts.timeline.slice(paymentIndex, terminalIndex + 1)) {
      if (entry.transactionId !== transactionId) {
        addDiagnostic(
          diagnostics,
          "timeline_transaction_identity_mismatch",
          "Every active transaction route must identify the same transaction.",
        );
        break;
      }
      if (!new Set(["payment", "fulfillment", "result"]).has(entry.route)) {
        addDiagnostic(
          diagnostics,
          "active_transaction_route_replaced",
          "An active Payment or Fulfillment route was replaced before the terminal result.",
        );
        break;
      }
    }
  }

  const report: InstalledKioskSaleAcceptanceReport = {
    schemaVersion: "installed-kiosk-sale-acceptance/v1",
    status: diagnostics.length === 0 ? "passed" : "failed",
    diagnostics,
  };
  return installedKioskSaleAcceptanceReportSchema.parse(report);
}
