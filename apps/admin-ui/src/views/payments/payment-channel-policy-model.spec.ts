import { describe, expect, it } from "vitest";

import {
  buildPaymentChannelPolicyPayload,
  createPaymentChannelPolicyForm,
  movePaymentChannelPolicyRow,
  paymentChannelDisplayName,
} from "./payment-channel-policy-model";

describe("payment-channel-policy-model", () => {
  it("maps policy contract keys to concise Chinese operator labels", () => {
    expect(paymentChannelDisplayName("qr_code:alipay")).toBe("支付宝扫码");
    expect(paymentChannelDisplayName("payment_code:alipay")).toBe(
      "支付宝付款码",
    );
    expect(paymentChannelDisplayName("qr_code:wechat_pay")).toBe("微信扫码");
    expect(paymentChannelDisplayName("payment_code:wechat_pay")).toBe(
      "微信付款码",
    );
  });

  it("creates editable form rows from a policy response without using raw keys as labels", () => {
    const form = createPaymentChannelPolicyForm({
      channels: [
        { channelKey: "payment_code:wechat_pay", enabled: true, rank: 1 },
        { channelKey: "qr_code:wechat_pay", enabled: true, rank: 2 },
        { channelKey: "payment_code:alipay", enabled: false, rank: 3 },
        { channelKey: "qr_code:alipay", enabled: true, rank: 4 },
      ],
      defaultChannelKey: "payment_code:wechat_pay",
      updatedAt: "2026-07-08T00:00:00.000Z",
      updatedByAdminUserId: null,
    });

    expect(form.rows.map((row) => row.label)).toEqual([
      "微信付款码",
      "微信扫码",
      "支付宝付款码",
      "支付宝扫码",
    ]);
    expect(form.defaultChannelKey).toBe("payment_code:wechat_pay");
    expect(form.rows[0]?.label).not.toBe(form.rows[0]?.channelKey);
  });

  it("builds a schema payload from the editable form", () => {
    const form = createPaymentChannelPolicyForm({
      channels: [
        { channelKey: "qr_code:alipay", enabled: true, rank: 1 },
        { channelKey: "payment_code:alipay", enabled: true, rank: 2 },
        { channelKey: "qr_code:wechat_pay", enabled: false, rank: 3 },
        { channelKey: "payment_code:wechat_pay", enabled: false, rank: 4 },
      ],
      defaultChannelKey: "qr_code:alipay",
      updatedAt: null,
      updatedByAdminUserId: null,
    });
    movePaymentChannelPolicyRow(form, "payment_code:wechat_pay", "up");
    movePaymentChannelPolicyRow(form, "payment_code:wechat_pay", "up");
    movePaymentChannelPolicyRow(form, "payment_code:wechat_pay", "up");
    movePaymentChannelPolicyRow(form, "qr_code:wechat_pay", "up");
    movePaymentChannelPolicyRow(form, "qr_code:wechat_pay", "up");
    const wechatCode = form.rows.find(
      (row) => row.channelKey === "payment_code:wechat_pay",
    );
    if (!wechatCode) throw new Error("wechat payment-code row missing");
    wechatCode.enabled = true;
    form.defaultChannelKey = "payment_code:wechat_pay";

    expect(buildPaymentChannelPolicyPayload(form)).toEqual({
      channels: [
        { channelKey: "payment_code:wechat_pay", enabled: true, rank: 1 },
        { channelKey: "qr_code:wechat_pay", enabled: false, rank: 2 },
        { channelKey: "qr_code:alipay", enabled: true, rank: 3 },
        { channelKey: "payment_code:alipay", enabled: true, rank: 4 },
      ],
      defaultChannelKey: "payment_code:wechat_pay",
    });
  });

  it("normalizes row order into contiguous ranks before save", () => {
    const form = createPaymentChannelPolicyForm({
      channels: [
        { channelKey: "qr_code:alipay", enabled: true, rank: 1 },
        { channelKey: "payment_code:alipay", enabled: true, rank: 2 },
        { channelKey: "qr_code:wechat_pay", enabled: true, rank: 3 },
        { channelKey: "payment_code:wechat_pay", enabled: true, rank: 4 },
      ],
      defaultChannelKey: "qr_code:alipay",
      updatedAt: null,
      updatedByAdminUserId: null,
    });
    form.rows[0].rank = 10;
    form.rows[1].rank = 10;
    form.rows[2].rank = 99;
    form.rows[3].rank = 2;

    expect(buildPaymentChannelPolicyPayload(form).channels).toEqual([
      { channelKey: "qr_code:alipay", enabled: true, rank: 1 },
      { channelKey: "payment_code:alipay", enabled: true, rank: 2 },
      { channelKey: "qr_code:wechat_pay", enabled: true, rank: 3 },
      { channelKey: "payment_code:wechat_pay", enabled: true, rank: 4 },
    ]);
  });

  it("reorders payment channels through explicit move operations", () => {
    const form = createPaymentChannelPolicyForm({
      channels: [
        { channelKey: "qr_code:alipay", enabled: true, rank: 1 },
        { channelKey: "payment_code:alipay", enabled: true, rank: 2 },
        { channelKey: "qr_code:wechat_pay", enabled: true, rank: 3 },
        { channelKey: "payment_code:wechat_pay", enabled: true, rank: 4 },
      ],
      defaultChannelKey: "qr_code:alipay",
      updatedAt: null,
      updatedByAdminUserId: null,
    });

    movePaymentChannelPolicyRow(form, "qr_code:wechat_pay", "up");
    movePaymentChannelPolicyRow(form, "qr_code:alipay", "up");
    movePaymentChannelPolicyRow(form, "payment_code:wechat_pay", "down");

    expect(form.rows.map((row) => [row.channelKey, row.rank])).toEqual([
      ["qr_code:alipay", 1],
      ["qr_code:wechat_pay", 2],
      ["payment_code:alipay", 3],
      ["payment_code:wechat_pay", 4],
    ]);
  });
});
