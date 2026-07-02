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
import {
  pageQuerySchema,
  paymentCodeAttemptAdminActionSchema,
  paymentCodeAttemptQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { AuditService } from "../audit/audit.service";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PaymentCodeAttemptsService } from "./payment-code-attempts.service";
import { PaymentCodeOrchestratorService } from "./payment-code-orchestrator.service";

@ApiTags("payment-code")
@ApiBearerAuth()
@Controller("payments/payment-code-attempts")
export class PaymentCodeController {
  constructor(
    private readonly attempts: PaymentCodeAttemptsService,
    private readonly orchestrator: PaymentCodeOrchestratorService,
    private readonly auditService: AuditService,
  ) {}

  @RequirePermissions("payments.read")
  @Get()
  async listAttempts(
    @Query(
      new ZodValidationPipe(
        paymentCodeAttemptQuerySchema.extend(pageQuerySchema.shape),
      ),
    )
    query: z.infer<typeof paymentCodeAttemptQuerySchema> &
      z.infer<typeof pageQuerySchema>,
  ) {
    return await this.attempts.listAttempts(query);
  }

  @RequirePermissions("payments.configure")
  @Post(":id/query")
  async queryAttempt(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(paymentCodeAttemptAdminActionSchema))
    body: z.infer<typeof paymentCodeAttemptAdminActionSchema>,
  ) {
    const result = this.attempts.toDto(await this.orchestrator.manualQuery(id));
    await this.auditService.record({
      adminUserId: admin.id,
      action: "payments.payment_code_attempt.query",
      resourceType: "payment_code_attempt",
      resourceId: id,
      afterJson: { reason: body.reason, result },
    });
    return result;
  }

  @RequirePermissions("payments.configure")
  @Post(":id/reverse")
  async reverseAttempt(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(paymentCodeAttemptAdminActionSchema))
    body: z.infer<typeof paymentCodeAttemptAdminActionSchema>,
  ) {
    const result = this.attempts.toDto(
      await this.orchestrator.manualReverse(id, body.reason),
    );
    await this.auditService.record({
      adminUserId: admin.id,
      action: "payments.payment_code_attempt.reverse",
      resourceType: "payment_code_attempt",
      resourceId: id,
      afterJson: { reason: body.reason, result },
    });
    return result;
  }
}
