import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminListMaintenanceWorkOrdersContract,
  adminMaintenanceWorkOrderListQuerySchema,
  adminMaintenanceWorkOrderResolveRequestSchema,
  adminResolveMaintenanceWorkOrderContract,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { MaintenanceWorkOrdersService } from "./maintenance-work-orders.service";

@ApiTags("maintenance-work-orders")
@ApiBearerAuth()
@Controller()
export class MaintenanceWorkOrdersController {
  constructor(private readonly service: MaintenanceWorkOrdersService) {}

  @RequirePermissions("maintenanceWorkOrders.read")
  @AdminEndpointContract(adminListMaintenanceWorkOrdersContract)
  async list(
    @Query() query: z.infer<typeof adminMaintenanceWorkOrderListQuerySchema>,
  ) {
    return this.service.list(query);
  }

  @RequirePermissions("maintenanceWorkOrders.write")
  @AdminEndpointContract(adminResolveMaintenanceWorkOrderContract)
  async resolve(
    @Param() params: { id: string },
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: z.infer<typeof adminMaintenanceWorkOrderResolveRequestSchema>,
  ) {
    return this.service.resolve(params.id, admin.id, body);
  }
}
