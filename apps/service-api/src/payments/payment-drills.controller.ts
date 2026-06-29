import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  createProtectedPaymentDrillSchema,
  protectedPaymentDrillRecoveryActionSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PaymentDrillsService } from "./payment-drills.service";

@ApiTags("payment-drills")
@ApiBearerAuth()
@Controller("payments/drills")
export class PaymentDrillsController {
  constructor(private readonly paymentDrillsService: PaymentDrillsService) {}

  @RequirePermissions("payments.configure")
  @Post()
  async createDrill(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createProtectedPaymentDrillSchema))
    body: z.infer<typeof createProtectedPaymentDrillSchema>,
  ) {
    return await this.paymentDrillsService.createDrill(admin.id, body);
  }

  @RequirePermissions("payments.configure")
  @Post(":orderId/recovery-actions")
  async createRecoveryAction(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("orderId", ParseUUIDPipe) orderId: string,
    @Body(new ZodValidationPipe(protectedPaymentDrillRecoveryActionSchema))
    body: z.infer<typeof protectedPaymentDrillRecoveryActionSchema>,
  ) {
    return await this.paymentDrillsService.applyRecoveryAction(
      orderId,
      admin.id,
      body,
    );
  }
}
