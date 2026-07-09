import type {
  PaymentChannelKey,
  PaymentChannelPolicyResponse,
  UpdatePaymentChannelPolicyInput,
} from "@vem/shared";

export type PaymentChannelPolicyFormRow = {
  channelKey: PaymentChannelKey;
  label: string;
  enabled: boolean;
  rank: number;
};

export type PaymentChannelPolicyForm = {
  rows: PaymentChannelPolicyFormRow[];
  defaultChannelKey: PaymentChannelKey;
};

export type PaymentChannelPolicyMoveDirection = "up" | "down";

const CHANNEL_LABELS: Record<PaymentChannelKey, string> = {
  "qr_code:alipay": "支付宝扫码",
  "payment_code:alipay": "支付宝付款码",
  "qr_code:wechat_pay": "微信扫码",
  "payment_code:wechat_pay": "微信付款码",
};

export function paymentChannelDisplayName(
  channelKey: PaymentChannelKey,
): string {
  return CHANNEL_LABELS[channelKey];
}

export function createPaymentChannelPolicyForm(
  policy: PaymentChannelPolicyResponse,
): PaymentChannelPolicyForm {
  return {
    rows: [...policy.channels]
      .sort((a, b) => a.rank - b.rank)
      .map((channel, index) => ({
        channelKey: channel.channelKey,
        label: paymentChannelDisplayName(channel.channelKey),
        enabled: channel.enabled,
        rank: index + 1,
      })),
    defaultChannelKey: policy.defaultChannelKey,
  };
}

function renumberRows(rows: PaymentChannelPolicyFormRow[]): void {
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
}

export function movePaymentChannelPolicyRow(
  form: PaymentChannelPolicyForm,
  channelKey: PaymentChannelKey,
  direction: PaymentChannelPolicyMoveDirection,
): void {
  const fromIndex = form.rows.findIndex((row) => row.channelKey === channelKey);
  if (fromIndex < 0) return;

  const toIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
  if (toIndex < 0 || toIndex >= form.rows.length) return;

  const [row] = form.rows.splice(fromIndex, 1);
  form.rows.splice(toIndex, 0, row);
  renumberRows(form.rows);
}

export function buildPaymentChannelPolicyPayload(
  form: PaymentChannelPolicyForm,
): UpdatePaymentChannelPolicyInput {
  return {
    channels: form.rows.map((row, index) => ({
      channelKey: row.channelKey,
      enabled: row.enabled,
      rank: index + 1,
    })),
    defaultChannelKey: form.defaultChannelKey,
  };
}
