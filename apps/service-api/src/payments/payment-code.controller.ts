import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminListPaymentCodeAttemptsContract,
  adminQueryPaymentCodeAttemptContract,
  adminReversePaymentCodeAttemptContract,
  pageQuerySchema,
  paymentCodeAttemptAdminActionSchema,
  paymentCodeAttemptQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";
import type { PaymentCodeAttemptRow } from "./payment-code-attempts.service";

import { RequirePermissions } from "../access/permissions.decorator";
import { AuditService } from "../audit/audit.service";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { PaymentCodeAttemptsService } from "./payment-code-attempts.service";
import { PaymentCodeOrchestratorService } from "./payment-code-orchestrator.service";

@ApiTags("payment-code")
@ApiBearerAuth()
@Controller()
export class PaymentCodeController {
  constructor(
    private readonly attempts: PaymentCodeAttemptsService,
    private readonly orchestrator: PaymentCodeOrchestratorService,
    private readonly auditService: AuditService,
  ) {}

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminListPaymentCodeAttemptsContract)
  async listAttempts(
    @Query() query: z.infer<typeof paymentCodeAttemptQuerySchema> &
      z.infer<typeof pageQuerySchema>,
  ) {
    return await this.attempts.listAttempts(query);
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminQueryPaymentCodeAttemptContract)
  async queryAttempt(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: z.infer<typeof paymentCodeAttemptAdminActionSchema>,
  ) {
    const result = await this.toAdminAttemptDto(
      params.id,
      await this.orchestrator.manualQuery(params.id),
    );
    await this.auditService.record({
      adminUserId: admin.id,
      action: "payments.payment_code_attempt.query",
      resourceType: "payment_code_attempt",
      resourceId: params.id,
      afterJson: { reason: body.reason, result },
    });
    return result;
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminReversePaymentCodeAttemptContract)
  async reverseAttempt(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: z.infer<typeof paymentCodeAttemptAdminActionSchema>,
  ) {
    const result = await this.toAdminAttemptDto(
      params.id,
      await this.orchestrator.manualReverse(params.id, body.reason),
    );
    await this.auditService.record({
      adminUserId: admin.id,
      action: "payments.payment_code_attempt.reverse",
      resourceType: "payment_code_attempt",
      resourceId: params.id,
      afterJson: { reason: body.reason, result },
    });
    return result;
  }

  private async toAdminAttemptDto(
    id: string,
    row: PaymentCodeAttemptRow & {
      orderNo?: string;
      paymentNo?: string;
      providerCode?: string;
    },
  ) {
    if (
      typeof row.orderNo === "string" &&
      typeof row.paymentNo === "string" &&
      typeof row.providerCode === "string"
    ) {
      return this.attempts.toDto(row);
    }

    const context = await this.attempts.getContextById(id);
    return this.attempts.toDto({
      ...context.attempt,
      orderNo: context.orderNo,
      paymentNo: context.paymentNo,
      providerCode: context.providerCode,
    });
  }
}
