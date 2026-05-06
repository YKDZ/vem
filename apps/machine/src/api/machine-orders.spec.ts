import { describe, expect, it } from "vitest";

import type { MachineApiClient } from "./request";

import { createMachineOrder, getMachineOrderStatus } from "./machine-orders";

function createMockClient(): MachineApiClient & {
  lastPostBody: unknown;
  lastGetConfig: unknown;
} {
  return {
    lastPostBody: null,
    lastGetConfig: null,
    async get<T>(_url: string, config?: unknown) {
      this.lastGetConfig = config;
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
        },
        vending: null,
        refund: null,
        nextAction: "wait_payment",
        serverTime: "2026-05-04T11:45:00.000Z",
      } as T;
    },
    async post<T, TBody>(_url: string, body?: TBody) {
      this.lastPostBody = body;
      return {
        orderId: "00000000-0000-4000-8000-000000000001",
        orderNo: "ORD-1",
        paymentNo: "PAY-1",
        paymentUrl: "https://pay.example/mock/PAY-1",
        expiresAt: "2026-05-04T12:00:00.000Z",
        totalAmountCents: 599,
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

  it("queries status with machineCode", async () => {
    const client = createMockClient();
    const status = await getMachineOrderStatus(client, {
      orderNo: "ORD-1",
      machineCode: "M001",
    });

    expect(status.nextAction).toBe("wait_payment");
    expect(client.lastGetConfig).toEqual({ params: { machineCode: "M001" } });
  });
});
