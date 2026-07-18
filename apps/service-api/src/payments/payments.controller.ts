import type { Response } from "express";
import type { Request } from "express";

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  pageQuerySchema,
  paymentAdminNoBodySchema,
  paymentIncidentActionRequestSchema,
  paymentOperatorReasonSchema,
  paymentEventQuerySchema,
  paymentProviderQuerySchema,
  paymentQuerySchema,
  paymentReconciliationAttemptQuerySchema,
  paymentWebhookAttemptQuerySchema,
  refundQuerySchema,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
  updatePaymentChannelPolicySchema,
  upsertPaymentProviderConfigSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PaymentChannelPolicyService } from "./payment-channel-policy.service";
import { PaymentsService } from "./payments.service";

type PaymentQuery = z.infer<typeof paymentQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type PaymentProviderQuery = z.infer<typeof paymentProviderQuerySchema>;
type UpdatePaymentProviderInput = z.infer<typeof updatePaymentProviderSchema>;
type UpdatePaymentProviderConfigInput = z.infer<
  typeof updatePaymentProviderConfigSchema
>;
type UpdatePaymentChannelPolicyInput = z.infer<
  typeof updatePaymentChannelPolicySchema
>;
type UpsertPaymentProviderConfigInput = z.infer<
  typeof upsertPaymentProviderConfigSchema
>;
type PaymentEventQuery = z.infer<typeof paymentEventQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type WebhookAttemptQuery = z.infer<typeof paymentWebhookAttemptQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type ReconciliationAttemptQuery = z.infer<
  typeof paymentReconciliationAttemptQuerySchema
> &
  z.infer<typeof pageQuerySchema>;
type RefundListQuery = z.infer<typeof refundQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type PaymentIncidentActionInput = z.infer<
  typeof paymentIncidentActionRequestSchema
>;

const paymentEventListQuerySchema = paymentEventQuerySchema.extend(
  pageQuerySchema.shape,
);
const webhookAttemptListQuerySchema = paymentWebhookAttemptQuerySchema.extend(
  pageQuerySchema.shape,
);
const reconciliationAttemptListQuerySchema =
  paymentReconciliationAttemptQuerySchema.extend(pageQuerySchema.shape);
const refundListQuerySchema = refundQuerySchema.extend(pageQuerySchema.shape);

@ApiTags("payments")
@ApiBearerAuth()
@Controller("payments")
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly paymentChannelPolicyService: PaymentChannelPolicyService,
  ) {}

  @RequirePermissions("payments.read")
  @Get()
  async listPayments(
    @Query(
      new ZodValidationPipe(paymentQuerySchema.extend(pageQuerySchema.shape)),
    )
    query: PaymentQuery,
  ) {
    return await this.paymentsService.listPayments(query);
  }

  @RequirePermissions("payments.configure")
  @Post("mock/:paymentNo/succeed")
  async markMockSucceeded(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("paymentNo") paymentNo: string,
    @Body(new ZodValidationPipe(paymentAdminNoBodySchema))
    _body: z.infer<typeof paymentAdminNoBodySchema>,
  ) {
    return await this.paymentsService.markMockSucceeded(paymentNo, admin.id);
  }

  @RequirePermissions("payments.configure")
  @Post("mock/:paymentNo/fail")
  async markMockFailed(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("paymentNo") paymentNo: string,
    @Body(new ZodValidationPipe(paymentAdminNoBodySchema))
    _body: z.infer<typeof paymentAdminNoBodySchema>,
  ) {
    return await this.paymentsService.markMockFailed(
      paymentNo,
      "mock_failed",
      admin.id,
    );
  }

  @Public()
  @Post("mock/:paymentNo/complete")
  async completeMockPaymentFromProvider(@Param("paymentNo") paymentNo: string) {
    return await this.paymentsService.completeMockPaymentFromProvider(
      paymentNo,
    );
  }

  @RequirePermissions("payments.configure")
  @Get("providers")
  async listProviders(
    @Query(new ZodValidationPipe(paymentProviderQuerySchema))
    query: PaymentProviderQuery,
  ) {
    return await this.paymentsService.listProviders(query);
  }

  @RequirePermissions("payments.configure")
  @Patch("providers/:id")
  async updateProvider(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePaymentProviderSchema))
    body: UpdatePaymentProviderInput,
  ) {
    return await this.paymentsService.updateProvider(id, body);
  }

  @RequirePermissions("payments.configure")
  @Get("provider-configs")
  async listProviderConfigs() {
    return await this.paymentsService.listProviderConfigs();
  }

  @RequirePermissions("payments.configure")
  @Get("provider-configs/notify-url-checks")
  async listProviderNotifyUrlChecks() {
    return await this.paymentsService.listProviderNotifyUrlChecks();
  }

  @RequirePermissions("payments.configure")
  @Patch("provider-configs/:id")
  async updateProviderConfig(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePaymentProviderConfigSchema))
    body: UpdatePaymentProviderConfigInput,
  ) {
    return await this.paymentsService.updateProviderConfig(id, admin.id, body);
  }

  @RequirePermissions("payments.configure")
  @Post("provider-configs")
  async upsertProviderConfig(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(upsertPaymentProviderConfigSchema))
    body: UpsertPaymentProviderConfigInput,
  ) {
    return await this.paymentsService.upsertProviderConfig(admin.id, body);
  }

  @RequirePermissions("payments.read")
  @Get("channel-policy")
  async getChannelPolicy() {
    return await this.paymentChannelPolicyService.getPolicy();
  }

  @RequirePermissions("payments.configure")
  @Put("channel-policy")
  async updateChannelPolicy(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(updatePaymentChannelPolicySchema))
    body: UpdatePaymentChannelPolicyInput,
  ) {
    return await this.paymentChannelPolicyService.updatePolicy(admin.id, body);
  }

  @RequirePermissions("payments.read")
  @Get("events")
  async listPaymentEvents(
    @Query(new ZodValidationPipe(paymentEventListQuerySchema))
    query: PaymentEventQuery,
  ) {
    return await this.paymentsService.listPaymentEvents(query);
  }

  @RequirePermissions("payments.read")
  @Get("webhook-attempts")
  async listWebhookAttempts(
    @Query(new ZodValidationPipe(webhookAttemptListQuerySchema))
    query: WebhookAttemptQuery,
  ) {
    return await this.paymentsService.listWebhookAttempts(query);
  }

  @RequirePermissions("payments.read")
  @Get("reconciliation-attempts")
  async listReconciliationAttempts(
    @Query(new ZodValidationPipe(reconciliationAttemptListQuerySchema))
    query: ReconciliationAttemptQuery,
  ) {
    return await this.paymentsService.listReconciliationAttempts(query);
  }

  @RequirePermissions("payments.configure")
  @Post(":id/incident-actions")
  async paymentIncidentAction(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(paymentIncidentActionRequestSchema))
    body: PaymentIncidentActionInput,
  ) {
    return await this.paymentsService.handlePaymentIncidentAction(
      id,
      admin.id,
      body,
    );
  }

  @RequirePermissions("payments.configure")
  @Post(":id/reconcile")
  async manualReconcile(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(paymentOperatorReasonSchema))
    body: z.infer<typeof paymentOperatorReasonSchema>,
  ) {
    return await this.paymentsService.manualReconcile(
      id,
      admin.id,
      body.reason,
    );
  }

  @RequirePermissions("payments.read")
  @Get("refunds")
  async listRefunds(
    @Query(new ZodValidationPipe(refundListQuerySchema))
    query: RefundListQuery,
  ) {
    return await this.paymentsService.listRefunds(query);
  }

  @RequirePermissions("payments.configure")
  @Post("refunds/:id/query")
  async queryRefund(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(paymentOperatorReasonSchema))
    body: z.infer<typeof paymentOperatorReasonSchema>,
  ) {
    return await this.paymentsService.manualReconcileRefund(
      id,
      admin.id,
      body.reason,
    );
  }

  @Public()
  @Post("webhooks/:providerCode")
  async handleWebhook(
    @Param("providerCode") providerCode: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
    @Req() req: Request & { rawBody?: Buffer },
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawBodyText = req.rawBody?.toString("utf8") ?? JSON.stringify(body);
    const remoteIp =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
        : null) ??
      req.ip ??
      req.socket?.remoteAddress ??
      null;
    const userAgent =
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : null;
    const result = await this.paymentsService.handleProviderWebhook(
      providerCode,
      headers,
      body,
      rawBodyText,
      remoteIp,
      userAgent,
    );
    if (providerCode === "alipay") {
      res.type("text/plain");
      return result.handled ? "success" : "fail";
    }
    return result;
  }
}
