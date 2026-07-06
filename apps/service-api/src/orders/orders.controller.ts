import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminOrderContractNoBodySchema,
  orderQuerySchema,
  orderRecoveryActionSchema,
  pageQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { OrdersService } from "./orders.service";

type OrderQuery = z.infer<typeof orderQuerySchema> &
  z.infer<typeof pageQuerySchema>;

@ApiTags("orders")
@ApiBearerAuth()
@Controller("orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @RequirePermissions("orders.read")
  @Get()
  async listOrders(
    @Query(
      new ZodValidationPipe(orderQuerySchema.extend(pageQuerySchema.shape)),
    )
    query: OrderQuery,
  ) {
    return await this.ordersService.listOrders(query);
  }

  @RequirePermissions("orders.read")
  @Get(":id/investigation")
  async getOrderInvestigation(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.ordersService.getOrderInvestigation(
      id,
      admin.permissions,
    );
  }

  @RequirePermissions("orders.read")
  @Get(":id")
  async getOrderDetail(@Param("id", ParseUUIDPipe) id: string) {
    return await this.ordersService.getOrderDetail(id);
  }

  @RequirePermissions("orders.refund")
  @Post(":id/refund")
  async requestRefund(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(adminOrderContractNoBodySchema))
    _body: z.infer<typeof adminOrderContractNoBodySchema>,
  ) {
    return await this.ordersService.requestMockRefund(id, admin.id);
  }

  @RequirePermissions("orders.recover")
  @Post(":id/recovery-actions")
  async createRecoveryAction(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(orderRecoveryActionSchema))
    body: z.infer<typeof orderRecoveryActionSchema>,
  ) {
    return await this.ordersService.createRecoveryAction(id, admin.id, body);
  }
}
