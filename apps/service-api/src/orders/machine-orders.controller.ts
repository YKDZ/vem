import type { Request } from "express";

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  createMachineOrderSchema,
  machineOrderStatusQuerySchema,
  paymentCodeSubmitSchema,
} from "@vem/shared";
import { z } from "zod";

import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AppConfigService } from "../config/app-config.service";
import {
  CurrentMachine,
  type AuthenticatedMachine,
} from "../machine-auth/current-machine.decorator";
import { MachineAuthGuard } from "../machine-auth/machine-auth.guard";
import { PaymentCodeOrchestratorService } from "../payments/payment-code-orchestrator.service";
import { PaymentsService } from "../payments/payments.service";
import { OrdersService } from "./orders.service";

type CreateMachineOrderInput = z.infer<typeof createMachineOrderSchema>;
type MachineOrderStatusQuery = z.infer<typeof machineOrderStatusQuerySchema>;

@ApiTags("machine-orders")
@Controller("machine-orders")
export class MachineOrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly paymentsService: PaymentsService,
    private readonly paymentCodeOrchestrator: PaymentCodeOrchestratorService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get("payment-options")
  async listPaymentOptions(@CurrentMachine() machine: AuthenticatedMachine) {
    return await this.ordersService.listMachinePaymentOptions(machine.id);
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post()
  async createMachineOrder(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Body(new ZodValidationPipe(createMachineOrderSchema))
    body: CreateMachineOrderInput,
  ) {
    return await this.ordersService.createMachineOrder({
      ...body,
      machineCode:
        body.machineCode === machine.code ? machine.code : "__forbidden__",
    });
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Get(":orderNo/status")
  async getMachineOrderStatus(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("orderNo") orderNo: string,
    @Query(new ZodValidationPipe(machineOrderStatusQuerySchema))
    query: MachineOrderStatusQuery,
  ) {
    const machineCode =
      query.machineCode === machine.code ? machine.code : "__forbidden__";
    return await this.ordersService.getMachineOrderStatus(orderNo, {
      machineCode,
    });
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post(":orderNo/payment-code/submit")
  async submitPaymentCode(
    @CurrentMachine() machine: AuthenticatedMachine,
    @Param("orderNo") orderNo: string,
    @Body(new ZodValidationPipe(paymentCodeSubmitSchema))
    body: z.infer<typeof paymentCodeSubmitSchema>,
    @Req() req: Request,
  ) {
    const machineCode =
      body.machineCode === machine.code ? machine.code : "__forbidden__";
    const remoteIp =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
        : null) ??
      req.ip ??
      req.socket?.remoteAddress ??
      null;
    return await this.paymentCodeOrchestrator.submit({
      ...body,
      machineCode,
      orderNo,
      clientIp: remoteIp,
    });
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post(":orderNo/mock-payment/succeed")
  async mockPaymentSucceed(
    @CurrentMachine() _machine: AuthenticatedMachine,
    @Param("orderNo") orderNo: string,
  ) {
    if (!this.config.paymentMockEnabled) {
      throw new ForbiddenException("Mock payment is not enabled");
    }
    const order = await this.ordersService.getMachineOrderStatus(orderNo, {
      machineCode: _machine.code,
    });
    return await this.paymentsService.markMockSucceeded(
      order.payment.paymentNo,
      null,
    );
  }

  @Public()
  @UseGuards(MachineAuthGuard)
  @Post(":orderNo/mock-payment/fail")
  async mockPaymentFail(
    @CurrentMachine() _machine: AuthenticatedMachine,
    @Param("orderNo") orderNo: string,
  ) {
    if (!this.config.paymentMockEnabled) {
      throw new ForbiddenException("Mock payment is not enabled");
    }
    const order = await this.ordersService.getMachineOrderStatus(orderNo, {
      machineCode: _machine.code,
    });
    return await this.paymentsService.markMockFailed(
      order.payment.paymentNo,
      "mock_failed",
      null,
    );
  }
}
