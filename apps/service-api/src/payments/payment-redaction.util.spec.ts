import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildRawBodyExcerpt,
  buildStoredEventPayload,
  hashPaymentCode,
  maskPaymentCode,
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

  it("masks and hashes payment auth codes without storing plaintext", () => {
    const code = "28763443825664394";
    expect(maskPaymentCode(code)).toBe("2876****4394");
    expect(hashPaymentCode(code)).toMatch(/^[a-f0-9]{64}$/);
    const stored = buildStoredEventPayload({
      auth_code: code,
      payment_code: code,
    });
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(JSON.stringify(stored)).toContain("[REDACTED");
  });

  it("does not normalize payment auth codes before masking or hashing", () => {
    const accepted = "2876 3443825664394";
    const boundaryWhitespace = ` ${accepted}`;

    expect(maskPaymentCode(accepted)).toBe("2876****4394");
    expect(maskPaymentCode(boundaryWhitespace)).toBe(" 287****4394");
    expect(hashPaymentCode(boundaryWhitespace)).not.toBe(
      hashPaymentCode(accepted),
    );
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
