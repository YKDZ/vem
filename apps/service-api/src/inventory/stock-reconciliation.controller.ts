import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { pageQuerySchema } from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  StockReconciliationService,
  type StockReconciliationResolveRequest,
} from "./stock-reconciliation.service";

const stockReconciliationQuerySchema = pageQuerySchema.extend({
  machineId: z.uuid().optional(),
});

const stockReconciliationResolveSchema = z.object({
  action: z.enum([
    "accept_machine_stock",
    "reject_machine_stock",
    "manual_correct",
  ]),
  note: z.string(),
  clearBlocker: z.boolean().optional(),
  correctedOnHandQty: z.int().nonnegative().optional(),
});

type StockReconciliationQuery = z.infer<typeof stockReconciliationQuerySchema>;

@ApiTags("stock-reconciliation")
@ApiBearerAuth()
@Controller("stock-reconciliation-cases")
export class StockReconciliationController {
  constructor(private readonly service: StockReconciliationService) {}

  @RequirePermissions("inventory.read")
  @Get()
  async listCases(
    @Query(new ZodValidationPipe(stockReconciliationQuerySchema))
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
    @Body(new ZodValidationPipe(stockReconciliationResolveSchema))
    body: StockReconciliationResolveRequest,
  ) {
    return await this.service.resolveCase(admin.id, id, body);
  }
}
