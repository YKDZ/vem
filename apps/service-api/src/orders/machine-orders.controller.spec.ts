import { describe, expect, it, vi } from "vitest";

import { MachineOrdersController } from "./machine-orders.controller";

describe("MachineOrdersController", () => {
  it("submits payment code with authenticated machine code and remote ip", async () => {
    const ordersService = {
      listMachinePaymentOptions: vi.fn(),
      createMachineOrder: vi.fn(),
      getMachineOrderStatus: vi.fn(),
    };
    const paymentsService = {
      markMockSucceeded: vi.fn(),
      markMockFailed: vi.fn(),
    };
    const paymentCodeOrchestrator = {
      submit: vi.fn().mockResolvedValue({ status: "user_confirming" }),
    };
    const controller = new MachineOrdersController(
      ordersService as never,
      paymentsService as never,
      paymentCodeOrchestrator as never,
      { paymentMockEnabled: true } as never,
    );

    await controller.submitPaymentCode(
      { code: "M001" } as never,
      "ORD001",
      {
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "idem-1",
        source: "serial_text",
        scannerHealth: {
          online: true,
          adapter: "serial_text",
          port: "/dev/ttyUSB1",
          message: "scanner ready",
        },
      },
      {
        headers: { "x-forwarded-for": "10.0.0.8, 10.0.0.9" },
        ip: "127.0.0.1",
        socket: { remoteAddress: "127.0.0.2" },
      } as never,
    );

    expect(paymentCodeOrchestrator.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        orderNo: "ORD001",
        machineCode: "M001",
        clientIp: "10.0.0.8",
        scannerHealth: expect.objectContaining({
          adapter: "serial_text",
        }),
      }),
    );
  });

  it("passes __forbidden__ when machineCode does not match authenticated machine", async () => {
    const controller = new MachineOrdersController(
      {
        listMachinePaymentOptions: vi.fn(),
        createMachineOrder: vi.fn(),
        getMachineOrderStatus: vi.fn(),
      } as never,
      {
        markMockSucceeded: vi.fn(),
        markMockFailed: vi.fn(),
      } as never,
      {
        submit: vi.fn().mockResolvedValue({ status: "failed" }),
      } as never,
      { paymentMockEnabled: true } as never,
    );

    await controller.submitPaymentCode(
      { code: "M001" } as never,
      "ORD001",
      {
        machineCode: "M999",
        authCode: "28763443825664394",
        idempotencyKey: "idem-2",
        source: "browser_test",
      },
      {
        headers: {},
        ip: "127.0.0.1",
        socket: { remoteAddress: "127.0.0.2" },
      } as never,
    );

    const paymentCodeOrchestrator = (
      controller as unknown as {
        paymentCodeOrchestrator: { submit: ReturnType<typeof vi.fn> };
      }
    ).paymentCodeOrchestrator;
    expect(paymentCodeOrchestrator.submit).toHaveBeenCalledWith(
      expect.objectContaining({ machineCode: "__forbidden__" }),
    );
  });
});
