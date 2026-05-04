export type PaymentIntentInput = {
  paymentNo: string;
  orderNo: string;
  amountCents: number;
  expiresAt: Date;
};

export type PaymentIntentResult = {
  providerTradeNo: string;
  paymentUrl: string;
};

export interface PaymentProvider {
  readonly code: string;
  createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>;
}
