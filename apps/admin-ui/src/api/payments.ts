import type { PaymentProviderStatus, PaymentProviderType } from "@vem/shared";

import { get, patch, post } from "./request";

export type Payment = {
  id: string;
  paymentNo: string;
  orderId: string;
  providerCode: string;
  method: string;
  status: string;
  amountCents: number;
  expiresAt: string | null;
  paidAt: string | null;
  failedReason: string | null;
  createdAt: string;
};

export type PaymentProvider = {
  id: string;
  code: string;
  name: string;
  type: PaymentProviderType;
  status: PaymentProviderStatus;
  capabilities: Record<string, unknown>;
};

export type PaymentSecretStatus = {
  configured: boolean;
  updatedAt: string | null;
  fingerprintSha256?: string | null;
  certificateExpiresAt?: string | null;
  errorCode?: string | null;
};

export type PaymentProviderConfig = {
  id: string;
  providerId: string;
  providerCode: "wechat_pay" | "alipay" | "mock";
  providerName: string;
  machineId: string | null;
  merchantNo: string | null;
  appId: string | null;
  publicConfigJson: Record<string, unknown>;
  derivedNotifyUrl: string | null;
  secretStatusJson: Record<string, PaymentSecretStatus>;
  status: string;
  updatedByAdminUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentProviderNotifyUrlCheck = {
  providerCode: "wechat_pay" | "alipay";
  notifyUrl: string;
  usesHttps: boolean;
  isLocalhost: boolean;
  pathMatchesWebhookRoute: boolean;
  reachable: boolean;
  statusCode: number | null;
  errorCode: string | null;
  checkedAt: string;
};

export type PaymentEvent = {
  id: string;
  paymentId: string;
  paymentNo: string;
  providerId: string;
  providerCode: string;
  eventType: string;
  providerEventId: string | null;
  signatureValid: boolean | null;
  handledAt: string | null;
  createdAt: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listPayments(
  query?: Record<string, unknown>,
): Promise<PageResult<Payment>> {
  return await get<PageResult<Payment>>("/payments", { params: query });
}

export async function mockSucceed(paymentNo: string): Promise<void> {
  await post<void>(`/payments/mock/${paymentNo}/succeed`);
}

export async function mockFail(paymentNo: string): Promise<void> {
  await post<void>(`/payments/mock/${paymentNo}/fail`);
}

export async function listPaymentProviders(
  query?: Record<string, unknown>,
): Promise<PaymentProvider[]> {
  return await get<PaymentProvider[]>("/payments/providers", { params: query });
}

export async function updatePaymentProvider(
  id: string,
  body: Partial<Pick<PaymentProvider, "name" | "status" | "capabilities">>,
): Promise<PaymentProvider> {
  return await patch<PaymentProvider>(`/payments/providers/${id}`, body);
}

export async function listPaymentProviderConfigs(): Promise<
  PaymentProviderConfig[]
> {
  return await get<PaymentProviderConfig[]>("/payments/provider-configs");
}

export async function updatePaymentProviderConfig(
  id: string,
  body: Partial<
    Pick<
      PaymentProviderConfig,
      "merchantNo" | "appId" | "publicConfigJson" | "status"
    >
  >,
): Promise<PaymentProviderConfig> {
  return await patch<PaymentProviderConfig>(
    `/payments/provider-configs/${id}`,
    body,
  );
}

export async function upsertPaymentProviderConfig(body: {
  providerCode: "wechat_pay" | "alipay";
  machineId?: string | null;
  merchantNo?: string | null;
  appId?: string | null;
  publicConfigJson?: Record<string, unknown>;
  sensitiveConfigJson?: Record<string, string | number | boolean | null>;
  status?: "enabled" | "disabled";
}): Promise<PaymentProviderConfig> {
  return await post<PaymentProviderConfig>(`/payments/provider-configs`, body);
}

export async function listPaymentEvents(
  query?: Record<string, unknown>,
): Promise<PageResult<PaymentEvent>> {
  return await get<PageResult<PaymentEvent>>("/payments/events", {
    params: query,
  });
}

export async function listPaymentProviderNotifyUrlChecks(): Promise<
  PaymentProviderNotifyUrlCheck[]
> {
  return await get<PaymentProviderNotifyUrlCheck[]>(
    "/payments/provider-configs/notify-url-checks",
  );
}
