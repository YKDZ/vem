import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildRawBodyExcerpt,
  buildStoredEventPayload,
} from "./payment-redaction.util";

describe("payment redaction utils", () => {
  it("redacts form-urlencoded sign and app_private_key fields in excerpts", () => {
    const excerpt = buildRawBodyExcerpt(
      "app_id=20210001&sign=abcdef&buyer_id=2088&app_private_key=secret",
    );
    expect(excerpt).toContain("buyer_id");
    expect(excerpt).toContain("[REDACTED");
    expect(excerpt).not.toContain("abcdef");
    expect(excerpt).not.toContain("secret");
  });

  it("stores event payload as hash, excerpt and redacted payload", () => {
    const stored = buildStoredEventPayload({
      out_trade_no: "PAY001",
      sign: "provider-signature",
    });
    expect(stored["payloadSha256"]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).toContain("PAY001");
    expect(JSON.stringify(stored)).not.toContain("provider-signature");
  });

  it("scheduled reconciliation queries honor next_retry_at gates", () => {
    const paymentSource = readFileSync(
      "src/payments/payments.service.ts",
      "utf8",
    );
    const refundSource = readFileSync("src/refunds/refunds.service.ts", "utf8");
    expect(paymentSource).toContain("from payment_reconciliation_attempts pra");
    expect(paymentSource).toContain("pra.next_retry_at >");
    expect(refundSource).toContain("from refund_reconciliation_attempts rra");
    expect(refundSource).toContain("rra.next_retry_at >");
  });
});
