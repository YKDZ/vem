import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { dashboardDateRangeQuerySchema } from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { DashboardService } from "./dashboard.service";

type DashboardDateRangeQuery = z.infer<typeof dashboardDateRangeQuerySchema>;

@ApiTags("dashboard")
@ApiBearerAuth()
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @RequirePermissions("dashboard.read")
  @Get("summary")
  async summary() {
    return await this.dashboardService.getSummary();
  }

  @RequirePermissions("dashboard.read")
  @Get("sales-trend")
  async salesTrend(
    @Query(new ZodValidationPipe(dashboardDateRangeQuerySchema))
    query: DashboardDateRangeQuery,
  ) {
    return await this.dashboardService.getSalesTrend(query);
  }

  @RequirePermissions("dashboard.read")
  @Get("top-products")
  async topProducts(
    @Query(new ZodValidationPipe(dashboardDateRangeQuerySchema))
    query: DashboardDateRangeQuery,
  ) {
    return await this.dashboardService.getTopProducts(query);
  }

  @RequirePermissions("dashboard.read")
  @Get("customer-profile")
  async customerProfile(
    @Query(new ZodValidationPipe(dashboardDateRangeQuerySchema))
    query: DashboardDateRangeQuery,
  ) {
    return await this.dashboardService.getCustomerProfile(query);
  }
}
