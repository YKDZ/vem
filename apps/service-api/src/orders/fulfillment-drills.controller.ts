import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  createProtectedFulfillmentDrillSchema,
  protectedFulfillmentDrillRecoveryActionSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { FulfillmentDrillsService } from "./fulfillment-drills.service";

@ApiTags("fulfillment-drills")
@ApiBearerAuth()
@Controller("orders/fulfillment-drills")
export class FulfillmentDrillsController {
  constructor(
    private readonly fulfillmentDrillsService: FulfillmentDrillsService,
  ) {}

  @RequirePermissions("orders.recover")
  @Post()
  async createDrill(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(createProtectedFulfillmentDrillSchema))
    body: z.infer<typeof createProtectedFulfillmentDrillSchema>,
  ) {
    return await this.fulfillmentDrillsService.createDrill(admin.id, body);
  }

  @RequirePermissions("orders.recover")
  @Post(":orderId/recovery-actions")
  async createRecoveryAction(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("orderId", ParseUUIDPipe) orderId: string,
    @Body(new ZodValidationPipe(protectedFulfillmentDrillRecoveryActionSchema))
    body: z.infer<typeof protectedFulfillmentDrillRecoveryActionSchema>,
  ) {
    return await this.fulfillmentDrillsService.applyRecoveryAction(
      orderId,
      admin.id,
      body,
    );
  }
}
