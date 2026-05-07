import { describe, expect, it } from "vitest";

import type { MachineApiClient } from "./request";

import {
  createMachineOrder,
  getMachineOrderStatus,
  getMachinePaymentOptions,
} from "./machine-orders";

function createMockClient(overrides?: {
  getResponse?: unknown;
  postResponse?: unknown;
}): MachineApiClient & {
  lastPostBody: unknown;
  lastGetConfig: unknown;
  lastGetUrl: string;
} {
  return {
    lastPostBody: null,
    lastGetConfig: null,
    lastGetUrl: "",
    async get<T>(url: string, config?: unknown) {
      this.lastGetUrl = url;
      this.lastGetConfig = config;
      if (overrides?.getResponse !== undefined) {
        return overrides.getResponse as T;
      }
      return {
        orderId: "00000000-0000-4000-8000-000000000001",
        orderNo: "ORD-1",
        machineCode: "M001",
        orderStatus: "pending_payment",
        totalAmountCents: 599,
        payment: {
          paymentNo: "PAY-1",
          method: "mock",
          status: "pending",
          paymentUrl: "https://pay.example/mock/PAY-1",
          expiresAt: "2026-05-04T12:00:00.000Z",
          paidAt: null,
          failedReason: null,
          providerCode: "mock",
        },
        vending: null,
        refund: null,
        nextAction: "wait_payment",
        serverTime: "2026-05-04T11:45:00.000Z",
      } as T;
    },
    async post<T, TBody>(_url: string, body?: TBody) {
      this.lastPostBody = body;
      if (overrides?.postResponse !== undefined) {
        return overrides.postResponse as T;
      }
      return {
        orderId: "00000000-0000-4000-8000-000000000001",
        orderNo: "ORD-1",
        paymentNo: "PAY-1",
        paymentUrl: "https://pay.example/mock/PAY-1",
        expiresAt: "2026-05-04T12:00:00.000Z",
        totalAmountCents: 599,
        paymentProviderCode: null,
      } as T;
    },
  };
}

describe("machine order api", () => {
  it("validates create order payload and response", async () => {
    const client = createMockClient();
    const result = await createMachineOrder(client, {
      machineCode: "M001",
      items: [
        { inventoryId: "00000000-0000-4000-8000-000000000010", quantity: 1 },
      ],
      paymentMethod: "mock",
    });

    expect(result.paymentNo).toBe("PAY-1");
    expect(client.lastPostBody).toEqual({
      machineCode: "M001",
      items: [
        { inventoryId: "00000000-0000-4000-8000-000000000010", quantity: 1 },
      ],
      paymentMethod: "mock",
    });
  });

  it("sends qr_code + paymentProviderCode for real payment", async () => {
    const client = createMockClient({
      postResponse: {
        orderId: "00000000-0000-4000-8000-000000000002",
        orderNo: "ORD-2",
        paymentNo: "PAY-2",
        paymentUrl: "https://qr.alipay.com/abc123",
        expiresAt: "2026-05-04T12:00:00.000Z",
        totalAmountCents: 999,
        paymentProviderCode: "alipay",
      },
    });
    const result = await createMachineOrder(client, {
      machineCode: "M001",
      items: [
        { inventoryId: "00000000-0000-4000-8000-000000000011", quantity: 1 },
      ],
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
    });

    expect(result.paymentProviderCode).toBe("alipay");
    expect(client.lastPostBody).toEqual({
      machineCode: "M001",
      items: [
        { inventoryId: "00000000-0000-4000-8000-000000000011", quantity: 1 },
      ],
      paymentMethod: "qr_code",
      paymentProviderCode: "alipay",
    });
  });

  it("queries status with machineCode", async () => {
    const client = createMockClient();
    const status = await getMachineOrderStatus(client, {
      orderNo: "ORD-1",
      machineCode: "M001",
    });

    expect(status.nextAction).toBe("wait_payment");
    expect(client.lastGetConfig).toEqual({ params: { machineCode: "M001" } });
  });

  it("getMachinePaymentOptions parses alipay response", async () => {
    const client = createMockClient({
      getResponse: {
        options: [
          {
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝",
            description: "请使用支付宝扫码支付",
            icon: "alipay",
            recommended: true,
          },
        ],
        defaultProviderCode: "alipay",
        serverTime: "2026-05-06T12:00:00.000Z",
      },
    });
    const result = await getMachinePaymentOptions(client);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.providerCode).toBe("alipay");
    expect(result.defaultProviderCode).toBe("alipay");
  });

  it("getMachinePaymentOptions parses wechat+alipay response", async () => {
    const client = createMockClient({
      getResponse: {
        options: [
          {
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝",
            description: "请使用支付宝扫码支付",
            icon: "alipay",
            recommended: true,
          },
          {
            providerCode: "wechat_pay",
            method: "qr_code",
            displayName: "微信支付",
            description: "请使用微信扫码支付",
            icon: "wechat",
            recommended: false,
          },
        ],
        defaultProviderCode: "alipay",
        serverTime: "2026-05-06T12:00:00.000Z",
      },
    });
    const result = await getMachinePaymentOptions(client);
    expect(result.options).toHaveLength(2);
    expect(result.options.map((o) => o.providerCode)).toEqual([
      "alipay",
      "wechat_pay",
    ]);
  });

  it("getMachinePaymentOptions parses empty options (no payment methods)", async () => {
    const client = createMockClient({
      getResponse: {
        options: [],
        defaultProviderCode: null,
        serverTime: "2026-05-06T12:00:00.000Z",
      },
    });
    const result = await getMachinePaymentOptions(client);
    expect(result.options).toHaveLength(0);
    expect(result.defaultProviderCode).toBeNull();
  });
});
