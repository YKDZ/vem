import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertCustomerPaymentCopy } from "./check-machine-customer-payment-copy.mjs";

describe("Machine customer payment copy boundary", () => {
  it("rejects environment-specific customer text and accepts production-safe copy", () => {
    assert.doesNotThrow(() =>
      assertCustomerPaymentCopy("请使用支付宝扫码完成支付。", "PaymentView.js"),
    );
    for (const text of [
      "沙箱钱包",
      "sandbox wallet",
      "testbed only",
      "测试环境支付",
    ]) {
      assert.throws(
        () => assertCustomerPaymentCopy(text, "PaymentView.js"),
        /provider environment vocabulary/i,
      );
    }
  });
});
