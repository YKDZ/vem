import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { orderPaymentStates } from "./enums/order-status";
import { paymentCodeAttemptStatuses } from "./enums/payment-status";
import { orderRecoveryActionSchema } from "./schemas/orders";

const currentDir = dirname(fileURLToPath(import.meta.url));
const whitepaperPath = resolve(
  currentDir,
  "../../../public/v1-operations-whitepaper.md",
);

function readWhitepaper(): string {
  return readFileSync(whitepaperPath, "utf8");
}

describe("public V1 operations whitepaper", () => {
  it("is present in the public artifact path and maps recovery states to shipped surfaces", () => {
    const content = readWhitepaper();

    expect(content).toContain("# VEM V1 运维白皮书");
    expect(content).toContain("/orders");
    expect(content).toContain("/payments");
    expect(content).toContain("/machines/:id");
    expect(content).toContain("machine UI `#/maintenance`");

    const requiredTokens = [
      "Payment Result Reconciliation",
      "Payment Code Attempt",
      "Refund Decision",
      "Unknown Dispense Result",
      "Stock Reconciliation Case",
      "Whole Machine Maintenance Lock",
      "`POST /api/orders/:id/recovery-actions`",
      "`POST /api/payments/:id/reconcile`",
      "`POST /api/payments/refunds/:id/query`",
      "`POST /api/payments/payment-code-attempts/:id/query`",
      "`POST /api/payments/payment-code-attempts/:id/reverse`",
      "`POST /v1/maintenance/whole-machine-lock/clear`",
      "`accept_machine_stock`",
      "`reject_machine_stock`",
      "`manual_correct`",
      "`clearBlocker`",
      "`PAYMENT_MOCK_ENABLED=false`",
      "`NO_PAYMENT_OPTIONS`",
      "`PRODUCTION_DISPENSE_PATH_MOCK`",
      "`PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR`",
      "`SCANNER_UNAVAILABLE`",
    ];
    for (const token of requiredTokens) {
      expect(content).toContain(token);
    }

    for (const action of orderRecoveryActionSchema.shape.action.options) {
      expect(content).toContain(`\`${action}\``);
    }

    for (const state of ["awaiting_payment", "paid"] as const) {
      expect(orderPaymentStates).toContain(state);
      expect(content).toContain(`Payment State \`${state}\``);
    }

    for (const status of [
      "unknown",
      "user_confirming",
      "querying",
      "manual_handling",
    ] as const) {
      expect(paymentCodeAttemptStatuses).toContain(status);
      expect(content).toContain(status);
    }

    expect(content).not.toContain("/api/admin");
    expect(content).not.toContain("Payment State `pending_payment`");
    expect(content).not.toMatch(/Payment Code Attempt[^\n|]*`processing`/);
    expect(content).not.toMatch(
      /直接(?:执行)?\s*SQL|手(?:动|工).*(?:SQL|数据库|补库)|(?:改|修改|修正|补|补丁|patch).*(?:数据库|DB|database)|(?:manual|direct).*(?:SQL|DB|database)|(?:DB|database)\s*patch/i,
    );
  });
});
