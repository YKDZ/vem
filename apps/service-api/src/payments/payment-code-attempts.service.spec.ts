import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { PaymentCodeAttemptsService } from "./payment-code-attempts.service";

function makeSelectResult(result: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(result),
          }),
        }),
      }),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function makeCountResult(total: number) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ total }]),
    }),
  };
}

function makePaymentClaimResult(result: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(result),
      }),
    }),
  };
}

describe("PaymentCodeAttemptsService", () => {
  it("rejects disabled mock payment before creating or replaying an attempt", async () => {
    const tx = { select: vi.fn(), insert: vi.fn() };
    tx.select.mockReturnValueOnce(
      makeSelectResult([
        {
          orderId: "order-1",
          orderNo: "ORD001",
          orderStatus: "pending_payment",
          paymentState: "awaiting_payment",
          fulfillmentState: "awaiting_fulfillment",
          machineId: "machine-1",
          paymentId: "payment-1",
          paymentNo: "PAY001",
          paymentProviderConfigId: null,
          amountCents: 300,
          paymentStatus: "pending",
          paymentMethod: "payment_code",
          providerId: "provider-mock",
          providerCode: "mock",
        },
      ]),
    );
    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (value: unknown) => unknown) => fn(tx)),
    };
    const service = new PaymentCodeAttemptsService(db as never);

    await expect(
      service.createOrReplay({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-disabled",
        source: "serial_text",
        mockPaymentEnabled: false,
      }),
    ).rejects.toThrow("Mock payment code is disabled");
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it("returns replayed=true for the same idempotencyKey", async () => {
    const existingAttempt = {
      id: "attempt-1",
      attemptNo: 1,
      status: "querying",
      idempotencyKey: "idem-1",
      isActive: true,
    };
    const tx = {
      select: vi.fn(),
      insert: vi.fn(),
    };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "pending_payment",
            paymentState: "awaiting_payment",
            fulfillmentState: "awaiting_fulfillment",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "pending",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([existingAttempt]));

    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const service = new PaymentCodeAttemptsService(db as never);
    const result = await service.createOrReplay({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-1",
      source: "serial_text",
    });

    expect(result.replayed).toBe(true);
    expect(result.attempt).toBe(existingAttempt);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("replays a committed succeeded attempt after the HTTP response is lost", async () => {
    const existingAttempt = {
      id: "attempt-succeeded",
      attemptNo: 1,
      status: "succeeded",
      idempotencyKey: "idem-succeeded",
      isActive: false,
    };
    const tx = { select: vi.fn(), insert: vi.fn() };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "paid",
            paymentState: "paid",
            fulfillmentState: "awaiting_fulfillment",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "succeeded",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([existingAttempt]));
    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (value: unknown) => unknown) => fn(tx)),
    };

    const result = await new PaymentCodeAttemptsService(
      db as never,
    ).createOrReplay({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-succeeded",
      source: "serial_text",
    });

    expect(result).toMatchObject({
      replayed: true,
      attempt: existingAttempt,
      payment: { status: "succeeded" },
    });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "manual-handling",
      orderStatus: "manual_handling",
      paymentState: "payment_unknown",
      fulfillmentState: "manual_handling",
      paymentStatus: "unknown",
      attemptStatus: "manual_handling",
    },
    {
      name: "expired",
      orderStatus: "payment_expired",
      paymentState: "payment_expired",
      fulfillmentState: "canceled",
      paymentStatus: "expired",
      attemptStatus: "canceled",
    },
  ])("replays a committed $name terminal attempt", async (terminal) => {
    const existingAttempt = {
      id: `attempt-${terminal.name}`,
      attemptNo: 1,
      status: terminal.attemptStatus,
      idempotencyKey: `idem-${terminal.name}`,
      isActive: terminal.attemptStatus === "manual_handling",
    };
    const tx = { select: vi.fn(), insert: vi.fn() };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: terminal.orderStatus,
            paymentState: terminal.paymentState,
            fulfillmentState: terminal.fulfillmentState,
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: terminal.paymentStatus,
            paymentMethod: "payment_code",
            expiresAt: new Date("2026-01-01T00:00:00.000Z"),
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([existingAttempt]));
    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (value: unknown) => unknown) => fn(tx)),
    };

    const result = await new PaymentCodeAttemptsService(
      db as never,
    ).createOrReplay({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: `idem-${terminal.name}`,
      source: "serial_text",
    });

    expect(result.replayed).toBe(true);
    expect(result.attempt).toBe(existingAttempt);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("throws when another active attempt already exists", async () => {
    const tx = {
      select: vi.fn(),
      insert: vi.fn(),
    };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "pending_payment",
            paymentState: "awaiting_payment",
            fulfillmentState: "awaiting_fulfillment",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "pending",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([]))
      .mockReturnValueOnce(
        makeSelectResult([
          {
            id: "attempt-active",
            orderId: "order-1",
            isActive: true,
          },
        ]),
      );

    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const service = new PaymentCodeAttemptsService(db as never);
    await expect(
      service.createOrReplay({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-2",
        source: "serial_text",
      }),
    ).rejects.toThrow(
      new ConflictException("payment_code_attempt_in_progress"),
    );
  });

  it("blocks a new attempt for incident-locked payment-code orders", async () => {
    const tx = {
      select: vi.fn(),
      insert: vi.fn(),
    };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "manual_handling",
            paymentState: "payment_unknown",
            fulfillmentState: "manual_handling",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "unknown",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([]));

    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const service = new PaymentCodeAttemptsService(db as never);
    await expect(
      service.createOrReplay({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-locked",
        source: "serial_text",
      }),
    ).rejects.toThrow(new ConflictException("payment_incident_locked"));
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("stores only hashed and masked auth code fields", async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const insertedAttempt = {
      id: "attempt-1",
      attemptNo: 1,
      status: "created",
      idempotencyKey: "idem-3",
      isActive: true,
      authCodeHash: "hashed",
      authCodeMasked: "2876****4394",
    };
    const tx = {
      select: vi.fn(),
      update: vi
        .fn()
        .mockReturnValue(makePaymentClaimResult([{ id: "payment-1" }])),
      insert: vi.fn().mockReturnValue({
        values: vi
          .fn()
          .mockImplementation((values: Record<string, unknown>) => {
            insertedValues = values;
            return {
              returning: vi.fn().mockResolvedValue([insertedAttempt]),
            };
          }),
      }),
    };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "pending_payment",
            paymentState: "awaiting_payment",
            fulfillmentState: "awaiting_fulfillment",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "pending",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([]))
      .mockReturnValueOnce(makeSelectResult([]))
      .mockReturnValueOnce(makeCountResult(0));

    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const service = new PaymentCodeAttemptsService(db as never);
    await service.createOrReplay({
      orderNo: "ORD001",
      machineCode: "M001",
      authCode: "28763443825664394",
      idempotencyKey: "idem-3",
      source: "serial_text",
      scannerHealthJson: {
        online: true,
        adapter: "serial_text",
        port: "/dev/ttyUSB1",
        message: "scanner ready",
      },
    });

    expect(insertedValues).toBeDefined();
    expect(insertedValues?.["authCodeHash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(insertedValues?.["authCodeMasked"]).toBe("2876****4394");
    expect(insertedValues?.["source"]).toBe("serial_text");
    expect(insertedValues?.["scannerHealthJson"]).toEqual({
      online: true,
      adapter: "serial_text",
      port: "/dev/ttyUSB1",
      message: "scanner ready",
    });
    expect(insertedValues).not.toHaveProperty("authCode");
    expect(JSON.stringify(insertedValues)).not.toContain("28763443825664394");
  });

  it("rejects when the durable attempt claim loses to cancellation or another attempt", async () => {
    const tx = {
      select: vi.fn(),
      update: vi.fn().mockReturnValue(makePaymentClaimResult([])),
      insert: vi.fn(),
    };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "pending_payment",
            paymentState: "awaiting_payment",
            fulfillmentState: "awaiting_fulfillment",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "pending",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([]))
      .mockReturnValueOnce(makeSelectResult([]));
    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new PaymentCodeAttemptsService(db as never);

    await expect(
      service.createOrReplay({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-cas-lost",
        source: "serial_text",
      }),
    ).rejects.toThrow(new ConflictException("payment_code_order_not_payable"));
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rejects a canceled payment-code order before an attempt can reach a provider", async () => {
    const tx = { select: vi.fn(), insert: vi.fn() };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "canceled",
            paymentState: "canceled",
            fulfillmentState: "canceled",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "canceled",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([]));
    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new PaymentCodeAttemptsService(db as never);

    await expect(
      service.createOrReplay({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-canceled",
        source: "serial_text",
      }),
    ).rejects.toThrow(new ConflictException("payment_code_order_not_payable"));
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rejects an attempt when its payment has reached expiry", async () => {
    const tx = { select: vi.fn(), insert: vi.fn() };
    tx.select
      .mockReturnValueOnce(
        makeSelectResult([
          {
            orderId: "order-1",
            orderNo: "ORD001",
            orderStatus: "pending_payment",
            paymentState: "awaiting_payment",
            fulfillmentState: "awaiting_fulfillment",
            machineId: "machine-1",
            paymentId: "payment-1",
            paymentNo: "PAY001",
            paymentProviderConfigId: "cfg-1",
            amountCents: 300,
            paymentStatus: "pending",
            paymentMethod: "payment_code",
            providerId: "provider-1",
            providerCode: "alipay",
            expiresAt: new Date(Date.now() - 1),
          },
        ]),
      )
      .mockReturnValueOnce(makeSelectResult([]));
    const db = {
      transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };
    const service = new PaymentCodeAttemptsService(db as never);

    await expect(
      service.createOrReplay({
        orderNo: "ORD001",
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-expired",
        source: "serial_text",
      }),
    ).rejects.toThrow(new ConflictException("payment_code_order_not_payable"));
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
