import {
  paymentCodeAttemptAdminActionSchema,
  paymentCodeAttemptAdminResponseSchema,
} from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service";
import { PaymentCodeAttemptsService } from "./payment-code-attempts.service";
import { PaymentCodeController } from "./payment-code.controller";

describe("PaymentCodeController", () => {
  it("rejects whitespace-only manual query and reverse reasons", () => {
    expect(() =>
      paymentCodeAttemptAdminActionSchema.parse({ reason: "   " }),
    ).toThrow();
    expect(() =>
      paymentCodeAttemptAdminActionSchema.parse({ reason: "\n\t" }),
    ).toThrow();
  });

  it("returns payment code attempts list without exposing authCodeHash fields", async () => {
    const attempts = {
      listAttempts: vi.fn().mockResolvedValue({
        items: [
          {
            id: "attempt-1",
            orderNo: "ORD001",
            paymentNo: "PAY001",
            providerCode: "alipay",
            attemptNo: 1,
            providerPaymentNo: "PCA001",
            status: "querying",
            authCodeMasked: "2876****4394",
            source: "tauri_scanner",
            failureCode: null,
            failureMessage: null,
            manualReason: null,
            submittedAt: null,
            lastCheckedAt: null,
            reversedAt: null,
            finishedAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    };
    const orchestrator = {
      manualQuery: vi.fn(),
      manualReverse: vi.fn(),
    };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.listAttempts({
      page: 1,
      pageSize: 20,
    });

    expect(JSON.stringify(result)).toContain("authCodeMasked");
    expect(JSON.stringify(result)).not.toContain("authCodeHash");
    expect(JSON.stringify(result)).not.toContain("28763443825664394");
  });

  it("passes manual reverse reason through to the orchestrator", async () => {
    const attempts = new PaymentCodeAttemptsService({} as never);
    const orchestrator = {
      manualQuery: vi.fn(),
      manualReverse: vi.fn().mockResolvedValue({
        id: "attempt-1",
        orderId: "order-1",
        orderNo: "ORD001",
        paymentNo: "PAY001",
        providerCode: "alipay",
        attemptNo: 1,
        providerPaymentNo: "PCA001",
        status: "reversed",
        authCodeMasked: "2876****4394",
        source: "serial_text",
        providerTradeNo: "ALI-TXN-001",
        providerStatus: "TRADE_CLOSED",
        failureCode: null,
        failureMessage: null,
        manualReason: "admin_manual_reverse",
        submittedAt: null,
        lastCheckedAt: null,
        reversedAt: null,
        finishedAt: null,
        createdAt: new Date("2026-06-26T04:00:00.000Z"),
        authCodeHash: "secret-hash",
        rawPayloadJson: { auth_code: "28763443825664394" },
        scannerHealthJson: { port: "COM3", lastRawText: "28763443825664394" },
      }),
    };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.reverseAttempt(
      { id: "admin-1" } as never,
      "550e8400-e29b-41d4-a716-446655440000",
      {
        reason: "admin_manual_reverse",
      },
    );

    expect(orchestrator.manualReverse).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "admin_manual_reverse",
    );
    expect(JSON.stringify(result)).toContain("authCodeMasked");
    expect(JSON.stringify(result)).toContain("ALI-TXN-001");
    expect(JSON.stringify(result)).not.toContain("authCodeHash");
    expect(JSON.stringify(result)).not.toContain("rawPayloadJson");
    expect(JSON.stringify(result)).not.toContain("scannerHealthJson");
    expect(JSON.stringify(result)).not.toContain("28763443825664394");
  });

  it("returns a complete admin DTO for manual query when the raw attempt row lacks joined fields", async () => {
    const updatedAttempt = {
      id: "attempt-1",
      orderId: "order-1",
      attemptNo: 1,
      providerPaymentNo: "PCA001",
      status: "querying",
      authCodeMasked: "2876****4394",
      source: "serial_text",
      providerTradeNo: "ALI-TXN-001",
      providerStatus: "WAIT_BUYER_PAY",
      failureCode: null,
      failureMessage: null,
      manualReason: null,
      submittedAt: null,
      lastCheckedAt: new Date("2026-06-26T04:00:00.000Z"),
      reversedAt: null,
      finishedAt: null,
      createdAt: new Date("2026-06-26T03:59:00.000Z"),
    };
    const attempts = {
      toDto: vi.fn((row) => ({
        ...row,
        orderNo: row.orderNo,
        paymentNo: row.paymentNo,
        providerCode: row.providerCode,
      })),
      getContextById: vi.fn().mockResolvedValue({
        attempt: updatedAttempt,
        orderNo: "ORD001",
        paymentNo: "PAY001",
        providerCode: "alipay",
      }),
    };
    const orchestrator = {
      manualQuery: vi.fn().mockResolvedValue(updatedAttempt),
      manualReverse: vi.fn(),
    };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.queryAttempt(
      { id: "admin-1" } as never,
      "550e8400-e29b-41d4-a716-446655440000",
      { reason: "operator checked uncertain payment code result" },
    );

    const responseJson = JSON.parse(JSON.stringify(result));
    expect(paymentCodeAttemptAdminResponseSchema.parse(responseJson)).toEqual(
      expect.objectContaining({
        orderNo: "ORD001",
        paymentNo: "PAY001",
        providerCode: "alipay",
      }),
    );
  });

  it("returns a complete admin DTO for manual reverse when the raw attempt row lacks joined fields", async () => {
    const updatedAttempt = {
      id: "attempt-1",
      orderId: "order-1",
      attemptNo: 1,
      providerPaymentNo: "PCA001",
      status: "reversed",
      authCodeMasked: "2876****4394",
      source: "serial_text",
      providerTradeNo: "ALI-TXN-001",
      providerStatus: "TRADE_CLOSED",
      failureCode: null,
      failureMessage: null,
      manualReason: "customer cancelled",
      submittedAt: null,
      lastCheckedAt: new Date("2026-06-26T04:00:00.000Z"),
      reversedAt: new Date("2026-06-26T04:01:00.000Z"),
      finishedAt: new Date("2026-06-26T04:01:00.000Z"),
      createdAt: new Date("2026-06-26T03:59:00.000Z"),
    };
    const attempts = {
      toDto: vi.fn((row) => ({
        ...row,
        orderNo: row.orderNo,
        paymentNo: row.paymentNo,
        providerCode: row.providerCode,
      })),
      getContextById: vi.fn().mockResolvedValue({
        attempt: updatedAttempt,
        orderNo: "ORD001",
        paymentNo: "PAY001",
        providerCode: "alipay",
      }),
    };
    const orchestrator = {
      manualQuery: vi.fn(),
      manualReverse: vi.fn().mockResolvedValue(updatedAttempt),
    };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.reverseAttempt(
      { id: "admin-1" } as never,
      "550e8400-e29b-41d4-a716-446655440000",
      { reason: "customer cancelled" },
    );

    const responseJson = JSON.parse(JSON.stringify(result));
    expect(paymentCodeAttemptAdminResponseSchema.parse(responseJson)).toEqual(
      expect.objectContaining({
        orderNo: "ORD001",
        paymentNo: "PAY001",
        providerCode: "alipay",
        status: "reversed",
      }),
    );
  });

  it("returns sanitized manual query DTO without stored payload or scanner health", async () => {
    const attempts = new PaymentCodeAttemptsService({} as never);
    const orchestrator = {
      manualQuery: vi.fn().mockResolvedValue({
        id: "attempt-1",
        orderId: "order-1",
        orderNo: "ORD001",
        paymentNo: "PAY001",
        providerCode: "alipay",
        attemptNo: 1,
        providerPaymentNo: "PCA001",
        status: "querying",
        authCodeMasked: "2876****4394",
        source: "serial_text",
        providerTradeNo: "ALI-TXN-001",
        providerStatus: "WAIT_BUYER_PAY",
        failureCode: "PAYMENT_CODE_QUERY_UNKNOWN",
        failureMessage: "provider timeout",
        manualReason: null,
        submittedAt: null,
        lastCheckedAt: new Date("2026-06-26T04:00:00.000Z"),
        reversedAt: null,
        finishedAt: null,
        createdAt: new Date("2026-06-26T03:59:00.000Z"),
        authCodeHash: "secret-hash",
        rawPayloadJson: { auth_code: "28763443825664394" },
        scannerHealthJson: { port: "COM3", lastRawText: "28763443825664394" },
      }),
      manualReverse: vi.fn(),
    };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
      { record: vi.fn() } as unknown as AuditService,
    );

    const result = await controller.queryAttempt(
      { id: "admin-1" } as never,
      "550e8400-e29b-41d4-a716-446655440000",
      { reason: "operator checked uncertain payment code result" },
    );

    expect(JSON.stringify(result)).toContain("WAIT_BUYER_PAY");
    expect(JSON.stringify(result)).toContain("provider timeout");
    expect(JSON.stringify(result)).not.toContain("authCodeHash");
    expect(JSON.stringify(result)).not.toContain("rawPayloadJson");
    expect(JSON.stringify(result)).not.toContain("scannerHealthJson");
    expect(JSON.stringify(result)).not.toContain("28763443825664394");
  });

  it("records actor and reason for manual query without leaking payment code payload", async () => {
    const attempts = new PaymentCodeAttemptsService({} as never);
    const orchestrator = {
      manualQuery: vi.fn().mockResolvedValue({
        id: "attempt-1",
        orderId: "order-1",
        orderNo: "ORD001",
        paymentNo: "PAY001",
        providerCode: "alipay",
        attemptNo: 1,
        providerPaymentNo: "PCA001",
        status: "querying",
        authCodeMasked: "2876****4394",
        source: "serial_text",
        providerTradeNo: "ALI-TXN-001",
        providerStatus: "WAIT_BUYER_PAY",
        failureCode: "PAYMENT_CODE_QUERY_UNKNOWN",
        failureMessage: "provider timeout",
        manualReason: null,
        submittedAt: null,
        lastCheckedAt: new Date("2026-06-26T04:00:00.000Z"),
        reversedAt: null,
        finishedAt: null,
        createdAt: new Date("2026-06-26T03:59:00.000Z"),
        authCodeHash: "secret-hash",
        rawPayloadJson: { auth_code: "28763443825664394" },
        scannerHealthJson: { port: "COM3", lastRawText: "28763443825664394" },
      }),
      manualReverse: vi.fn(),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
      audit as unknown as AuditService,
    );

    const result = await controller.queryAttempt(
      { id: "admin-1" } as never,
      "550e8400-e29b-41d4-a716-446655440000",
      { reason: "customer says payment app is still confirming" },
    );

    expect(audit.record).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "payments.payment_code_attempt.query",
      resourceType: "payment_code_attempt",
      resourceId: "550e8400-e29b-41d4-a716-446655440000",
      afterJson: {
        reason: "customer says payment app is still confirming",
        result,
      },
    });
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      "28763443825664394",
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      "authCodeHash",
    );
  });
});
