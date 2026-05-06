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
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { MaintenanceWorkOrdersService } from "./maintenance-work-orders.service";

const resolveSchema = z.object({
  resolutionNote: z.string().min(1),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
});

@ApiTags("maintenance-work-orders")
@ApiBearerAuth()
@Controller("maintenance-work-orders")
export class MaintenanceWorkOrdersController {
  constructor(private readonly service: MaintenanceWorkOrdersService) {}

  @Get()
  @RequirePermissions("maintenanceWorkOrders.read")
  async list(
    @Query(new ZodValidationPipe(listQuerySchema))
    query: z.infer<typeof listQuerySchema>,
  ) {
    return this.service.list(query);
  }

  @Post(":id/resolve")
  @RequirePermissions("maintenanceWorkOrders.write")
  async resolve(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(resolveSchema)) body: z.infer<
      typeof resolveSchema
    >,
  ) {
    return this.service.resolve(id, admin.id, body.resolutionNote);
  }
}
