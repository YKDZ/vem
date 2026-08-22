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
@Controller()
export class StockReconciliationController {
  constructor(private readonly service: StockReconciliationService) {}

  @RequirePermissions("inventory.read")
  @AdminEndpointContract(adminListStockReconciliationCasesContract)
  async listCases(
    @Query(
      new ZodValidationPipe(
        adminListStockReconciliationCasesContract.querySchema,
      ),
    )
    query: StockReconciliationQuery,
  ) {
    return await this.service.listCases(query);
  }

  @RequirePermissions("inventory.read")
  @AdminEndpointContract(adminGetStockReconciliationCaseContract)
  async getCase(
    @Param(
      new ZodValidationPipe(
        adminGetStockReconciliationCaseContract.pathParamsSchema,
      ),
    )
    params: { id: string },
  ) {
    return await this.service.getCase(params.id);
  }

  @RequirePermissions("inventory.adjust")
  @AdminEndpointContract(adminResolveStockReconciliationCaseContract)
  async resolveCase(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(
      new ZodValidationPipe(
        adminResolveStockReconciliationCaseContract.pathParamsSchema,
      ),
    )
    params: { id: string },
    @Body(new ZodValidationPipe(adminStockReconciliationResolveRequestSchema))
    body: StockReconciliationResolveRequest,
  ) {
    return await this.service.resolveCase(admin.id, params.id, body);
  }
}
