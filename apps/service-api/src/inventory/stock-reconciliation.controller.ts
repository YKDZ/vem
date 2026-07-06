import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminStockReconciliationListQuerySchema,
  adminStockReconciliationResolveRequestSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { StockReconciliationService } from "./stock-reconciliation.service";

type StockReconciliationQuery = z.infer<
  typeof adminStockReconciliationListQuerySchema
>;
type StockReconciliationResolveRequest = z.infer<
  typeof adminStockReconciliationResolveRequestSchema
>;

@ApiTags("stock-reconciliation")
@ApiBearerAuth()
@Controller("stock-reconciliation-cases")
export class StockReconciliationController {
  constructor(private readonly service: StockReconciliationService) {}

  @RequirePermissions("inventory.read")
  @Get()
  async listCases(
    @Query(new ZodValidationPipe(adminStockReconciliationListQuerySchema))
    query: StockReconciliationQuery,
  ) {
    return await this.service.listCases(query);
  }

  @RequirePermissions("inventory.read")
  @Get(":id")
  async getCase(@Param("id") id: string) {
    return await this.service.getCase(id);
  }

  @RequirePermissions("inventory.adjust")
  @Post(":id/resolve")
  async resolveCase(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(adminStockReconciliationResolveRequestSchema))
    body: StockReconciliationResolveRequest,
  ) {
    return await this.service.resolveCase(admin.id, id, body);
  }
}
