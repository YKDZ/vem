import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminCreateOrderRecoveryActionContract,
  adminGetOrderDetailContract,
  adminGetOrderInvestigationContract,
  adminListOrdersContract,
  adminRequestOrderRefundContract,
  adminOrderContractNoBodySchema,
  orderQuerySchema,
  orderRecoveryActionSchema,
  pageQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { toOrderDetailResponse } from "./orders.contract-mappers";
import { OrdersService } from "./orders.service";

type OrderQuery = z.infer<typeof orderQuerySchema> &
  z.infer<typeof pageQuerySchema>;

@ApiTags("orders")
@ApiBearerAuth()
@Controller()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @RequirePermissions("orders.read")
  @AdminEndpointContract(adminListOrdersContract)
  async listOrders(@Query() query: OrderQuery) {
    return await this.ordersService.listOrders(query);
  }

  @RequirePermissions("orders.read")
  @AdminEndpointContract(adminGetOrderInvestigationContract)
  async getOrderInvestigation(
    @Param() params: { id: string },
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.ordersService.getOrderInvestigation(
      params.id,
      admin.permissions,
    );
  }

  @RequirePermissions("orders.read")
  @AdminEndpointContract(adminGetOrderDetailContract)
  async getOrderDetail(@Param() params: { id: string }) {
    return toOrderDetailResponse(
      await this.ordersService.getOrderDetail(params.id),
    );
  }

  @RequirePermissions("orders.refund")
  @AdminEndpointContract(adminRequestOrderRefundContract)
  async requestRefund(
    @Param() params: { id: string },
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() _body: z.infer<typeof adminOrderContractNoBodySchema>,
  ) {
    return await this.ordersService.requestMockRefund(params.id, admin.id);
  }

  @RequirePermissions("orders.recover")
  @AdminEndpointContract(adminCreateOrderRecoveryActionContract)
  async createRecoveryAction(
    @Param() params: { id: string },
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: z.infer<typeof orderRecoveryActionSchema>,
  ) {
    return await this.ordersService.createRecoveryAction(
      params.id,
      admin.id,
      body,
    );
  }
}
