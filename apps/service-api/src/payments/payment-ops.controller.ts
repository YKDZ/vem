import { Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminGetPaymentMachinePreflightContract,
  adminGetPaymentOpsMetricsContract,
  adminGetPaymentOpsReadinessContract,
} from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { PaymentOpsService } from "./payment-ops.service";

@ApiTags("payment-ops")
@ApiBearerAuth()
@Controller()
export class PaymentOpsController {
  constructor(private readonly paymentOpsService: PaymentOpsService) {}

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminGetPaymentOpsReadinessContract)
  async getReadiness() {
    return await this.paymentOpsService.getReadiness();
  }

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminGetPaymentOpsMetricsContract)
  async getMetrics(
    @Query() query: z.infer<
      typeof adminGetPaymentOpsMetricsContract.querySchema
    >,
  ) {
    return await this.paymentOpsService.getMetrics(query.windowMinutes);
  }

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminGetPaymentMachinePreflightContract)
  async getMachinePreflight(@Param() params: { machineId: string }) {
    return await this.paymentOpsService.getMachinePreflight(params.machineId);
  }
}
