import { Controller, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminGetDashboardCustomerProfileContract,
  adminGetDashboardSalesTrendContract,
  adminGetDashboardSummaryContract,
  adminGetDashboardTopProductsContract,
  dashboardDateRangeQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { DashboardService } from "./dashboard.service";

type DashboardDateRangeQuery = z.infer<typeof dashboardDateRangeQuerySchema>;

@ApiTags("dashboard")
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @RequirePermissions("dashboard.read")
  @AdminEndpointContract(adminGetDashboardSummaryContract)
  async summary() {
    return await this.dashboardService.getSummary();
  }

  @RequirePermissions("dashboard.read")
  @AdminEndpointContract(adminGetDashboardSalesTrendContract)
  async salesTrend(@Query() query: DashboardDateRangeQuery) {
    return await this.dashboardService.getSalesTrend(query);
  }

  @RequirePermissions("dashboard.read")
  @AdminEndpointContract(adminGetDashboardTopProductsContract)
  async topProducts(@Query() query: DashboardDateRangeQuery) {
    return await this.dashboardService.getTopProducts(query);
  }

  @RequirePermissions("dashboard.read")
  @AdminEndpointContract(adminGetDashboardCustomerProfileContract)
  async customerProfile(@Query() query: DashboardDateRangeQuery) {
    return await this.dashboardService.getCustomerProfile(query);
  }
}
