import type { Response } from "express";
import type { Request } from "express";

import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminCreatePaymentIncidentActionContract,
  adminGetPaymentChannelPolicyContract,
  adminListPaymentEventsContract,
  adminListPaymentProvidersContract,
  adminListPaymentProviderConfigsContract,
  adminListPaymentProviderNotifyUrlChecksContract,
  adminListPaymentReconciliationAttemptsContract,
  adminListPaymentRefundsContract,
  adminListPaymentWebhookAttemptsContract,
  adminListPaymentsContract,
  adminManualReconcilePaymentContract,
  adminMockPaymentFailContract,
  adminMockPaymentSucceedContract,
  adminQueryPaymentRefundContract,
  adminUpdatePaymentChannelPolicyContract,
  adminUpdatePaymentProviderConfigContract,
  adminUpdatePaymentProviderContract,
  adminUpsertPaymentProviderConfigContract,
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
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
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

@ApiTags("payments")
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly paymentChannelPolicyService: PaymentChannelPolicyService,
  ) {}

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminListPaymentsContract)
  async listPayments(@Query() query: PaymentQuery) {
    return await this.paymentsService.listPayments(query);
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminMockPaymentSucceedContract)
  async markMockSucceeded(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { paymentNo: string },
    @Body() _body: z.infer<typeof paymentAdminNoBodySchema>,
  ) {
    return await this.paymentsService.markMockSucceeded(
      params.paymentNo,
      admin.id,
    );
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminMockPaymentFailContract)
  async markMockFailed(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { paymentNo: string },
    @Body() _body: z.infer<typeof paymentAdminNoBodySchema>,
  ) {
    return await this.paymentsService.markMockFailed(
      params.paymentNo,
      "mock_failed",
      admin.id,
    );
  }

  @Public()
  @Post("payments/mock/:paymentNo/complete")
  async completeMockPaymentFromProvider(@Param("paymentNo") paymentNo: string) {
    return await this.paymentsService.completeMockPaymentFromProvider(
      paymentNo,
    );
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminListPaymentProvidersContract)
  async listProviders(@Query() query: PaymentProviderQuery) {
    return await this.paymentsService.listProviders(query);
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminUpdatePaymentProviderContract)
  async updateProvider(
    @Param() params: { id: string },
    @Body() body: UpdatePaymentProviderInput,
  ) {
    return await this.paymentsService.updateProvider(params.id, body);
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminListPaymentProviderConfigsContract)
  async listProviderConfigs() {
    return await this.paymentsService.listProviderConfigs();
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminListPaymentProviderNotifyUrlChecksContract)
  async listProviderNotifyUrlChecks() {
    return await this.paymentsService.listProviderNotifyUrlChecks();
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminUpdatePaymentProviderConfigContract)
  async updateProviderConfig(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: UpdatePaymentProviderConfigInput,
  ) {
    return await this.paymentsService.updateProviderConfig(
      params.id,
      admin.id,
      body,
    );
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminUpsertPaymentProviderConfigContract)
  async upsertProviderConfig(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: UpsertPaymentProviderConfigInput,
  ) {
    return await this.paymentsService.upsertProviderConfig(admin.id, body);
  }

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminGetPaymentChannelPolicyContract)
  async getChannelPolicy() {
    return await this.paymentChannelPolicyService.getPolicy();
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminUpdatePaymentChannelPolicyContract)
  async updateChannelPolicy(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body() body: UpdatePaymentChannelPolicyInput,
  ) {
    return await this.paymentChannelPolicyService.updatePolicy(admin.id, body);
  }

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminListPaymentEventsContract)
  async listPaymentEvents(@Query() query: PaymentEventQuery) {
    return await this.paymentsService.listPaymentEvents(query);
  }

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminListPaymentWebhookAttemptsContract)
  async listWebhookAttempts(@Query() query: WebhookAttemptQuery) {
    return await this.paymentsService.listWebhookAttempts(query);
  }

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminListPaymentReconciliationAttemptsContract)
  async listReconciliationAttempts(@Query() query: ReconciliationAttemptQuery) {
    return await this.paymentsService.listReconciliationAttempts(query);
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminCreatePaymentIncidentActionContract)
  async paymentIncidentAction(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: PaymentIncidentActionInput,
  ) {
    return await this.paymentsService.handlePaymentIncidentAction(
      params.id,
      admin.id,
      body,
    );
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminManualReconcilePaymentContract)
  async manualReconcile(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: z.infer<typeof paymentOperatorReasonSchema>,
  ) {
    return await this.paymentsService.manualReconcile(
      params.id,
      admin.id,
      body.reason,
    );
  }

  @RequirePermissions("payments.read")
  @AdminEndpointContract(adminListPaymentRefundsContract)
  async listRefunds(@Query() query: RefundListQuery) {
    return await this.paymentsService.listRefunds(query);
  }

  @RequirePermissions("payments.configure")
  @AdminEndpointContract(adminQueryPaymentRefundContract)
  async queryRefund(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param() params: { id: string },
    @Body() body: z.infer<typeof paymentOperatorReasonSchema>,
  ) {
    return await this.paymentsService.manualReconcileRefund(
      params.id,
      admin.id,
      body.reason,
    );
  }

  @Public()
  @Post("payments/webhooks/:providerCode")
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
