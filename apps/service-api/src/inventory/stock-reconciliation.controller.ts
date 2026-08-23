import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminGetStockReconciliationCaseContract,
  adminListStockReconciliationCasesContract,
  adminResolveStockReconciliationCaseContract,
  adminStockReconciliationListQuerySchema,
  adminStockReconciliationResolveRequestSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { StockReconciliationService } from "./stock-reconciliation.service";

type StockReconciliationQuery = z.infer<
  typeof adminStockReconciliationListQuerySchema
>;
type StockReconciliationResolveRequest = z.infer<
  typeof adminStockReconciliationResolveRequestSchema
>;

@ApiTags("stock-reconciliation")
@ApiBearerAuth()
@Controller()
export class StockReconciliationController {
  constructor(private readonly service: StockReconciliationService) {}

  @RequirePermissions("inventory.read")
  @AdminEndpointContract(adminListStockReconciliationCasesContract)
  async listCases(@Query() query: StockReconciliationQuery) {
    return await this.service.listCases(query);
  }

  @RequirePermissions("inventory.read")
  @AdminEndpointContract(adminGetStockReconciliationCaseContract)
  async getCase(@Param() params: { id: string }) {
    return await this.service.getCase(params.id);
  }

  @RequirePermissions("inventory.adjust")
  @AdminEndpointContract(adminResolveStockReconciliationCaseContract)
  async resolveCase(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: StockReconciliationResolveRequest,
  ) {
    return await this.service.resolveCase(admin.id, params.id, body);
  }
}
