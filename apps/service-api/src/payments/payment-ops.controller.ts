import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PaymentOpsService } from "./payment-ops.service";

const metricsQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(5).max(1440).optional(),
});

@ApiTags("payment-ops")
@ApiBearerAuth()
@Controller("payments/ops")
export class PaymentOpsController {
  constructor(private readonly paymentOpsService: PaymentOpsService) {}

  @RequirePermissions("payments.read")
  @Get("readiness")
  async getReadiness() {
    return await this.paymentOpsService.getReadiness();
  }

  @RequirePermissions("payments.read")
  @Get("metrics")
  async getMetrics(
    @Query(new ZodValidationPipe(metricsQuerySchema))
    query: z.infer<typeof metricsQuerySchema>,
  ) {
    return await this.paymentOpsService.getMetrics(query.windowMinutes);
  }

  @RequirePermissions("payments.read")
  @Get("machines/:machineId/preflight")
  async getMachinePreflight(
    @Param("machineId", ParseUUIDPipe) machineId: string,
  ) {
    return await this.paymentOpsService.getMachinePreflight(machineId);
  }
}
