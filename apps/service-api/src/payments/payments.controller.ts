import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  pageQuerySchema,
  paymentEventQuerySchema,
  paymentProviderQuerySchema,
  paymentQuerySchema,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
  upsertPaymentProviderConfigSchema,
} from "@vem/shared";
import { z } from "zod";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { Public } from "../auth/public.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PaymentsService } from "./payments.service";

type PaymentQuery = z.infer<typeof paymentQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type PaymentProviderQuery = z.infer<typeof paymentProviderQuerySchema>;
type UpdatePaymentProviderInput = z.infer<typeof updatePaymentProviderSchema>;
type UpdatePaymentProviderConfigInput = z.infer<
  typeof updatePaymentProviderConfigSchema
>;
type UpsertPaymentProviderConfigInput = z.infer<
  typeof upsertPaymentProviderConfigSchema
>;
type PaymentEventQuery = z.infer<typeof paymentEventQuerySchema> &
  z.infer<typeof pageQuerySchema>;

const paymentEventListQuerySchema = paymentEventQuerySchema.extend(
  pageQuerySchema.shape,
);

@ApiTags("payments")
@ApiBearerAuth()
@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

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
  ) {
    return await this.paymentsService.markMockSucceeded(paymentNo, admin.id);
  }

  @RequirePermissions("payments.configure")
  @Post("mock/:paymentNo/fail")
  async markMockFailed(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("paymentNo") paymentNo: string,
  ) {
    return await this.paymentsService.markMockFailed(
      paymentNo,
      "mock_failed",
      admin.id,
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
  @Get("events")
  async listPaymentEvents(
    @Query(new ZodValidationPipe(paymentEventListQuerySchema))
    query: PaymentEventQuery,
  ) {
    return await this.paymentsService.listPaymentEvents(query);
  }

  @Public()
  @Post("webhooks/:providerCode")
  async handleWebhook(
    @Param("providerCode") providerCode: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: unknown,
    @Req() req: { rawBody?: Buffer },
  ) {
    const rawBodyText = req.rawBody?.toString("utf8") ?? JSON.stringify(body);
    return await this.paymentsService.handleProviderWebhook(
      providerCode,
      headers,
      body,
      rawBodyText,
    );
  }
}
