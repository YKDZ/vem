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
  adminMaintenanceWorkOrderListQuerySchema,
  adminMaintenanceWorkOrderResolveRequestSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { MaintenanceWorkOrdersService } from "./maintenance-work-orders.service";

@ApiTags("maintenance-work-orders")
@ApiBearerAuth()
@Controller("maintenance-work-orders")
export class MaintenanceWorkOrdersController {
  constructor(private readonly service: MaintenanceWorkOrdersService) {}

  @Get()
  @RequirePermissions("maintenanceWorkOrders.read")
  async list(
    @Query(new ZodValidationPipe(adminMaintenanceWorkOrderListQuerySchema))
    query: z.infer<typeof adminMaintenanceWorkOrderListQuerySchema>,
  ) {
    return this.service.list(query);
  }

  @Post(":id/resolve")
  @RequirePermissions("maintenanceWorkOrders.write")
  async resolve(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(adminMaintenanceWorkOrderResolveRequestSchema))
    body: z.infer<typeof adminMaintenanceWorkOrderResolveRequestSchema>,
  ) {
    return this.service.resolve(id, admin.id, body);
  }
}
