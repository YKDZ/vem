import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminListTryOnGarmentsByProductContract,
  adminTryOnGarmentConfirmationContract,
  adminTryOnGarmentActivationContract,
  adminTryOnGarmentAssociationContract,
  adminTryOnGarmentRetirementContract,
  adminTryOnGarmentSourceReplacementContract,
  type TryOnGarmentDraftRequest,
  type TryOnGarmentSourceReplacementRequest,
  type TryOnGarmentVariantAssociationRequest,
} from "@vem/shared";

import type { AuthenticatedAdmin } from "../common/request-user";

import { RequirePermissions } from "../access/permissions.decorator";
import { CurrentAdmin } from "../auth/current-admin.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { TryOnGarmentsService } from "./try-on-garments.service";

@ApiTags("try-on-garments")
@ApiBearerAuth()
@Controller()
export class TryOnGarmentsController {
  constructor(private readonly tryOnGarmentsService: TryOnGarmentsService) {}

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminCreateTryOnGarmentContract)
  async createDraft(
    @Body() body: TryOnGarmentDraftRequest,
    @Query() _query: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.createDraft(body, admin.id);
  }

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminGetTryOnGarmentContract)
  async getById(
    @Param() params: { id: string },
    @Query() _query: Record<string, never>,
  ) {
    return await this.tryOnGarmentsService.getById(params.id);
  }

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminListTryOnGarmentsByProductContract)
  async listByProduct(@Query() query: { productId: string }) {
    return await this.tryOnGarmentsService.listByProduct(query.productId);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentConfirmationContract)
  async confirm(
    @Param() params: { id: string },
    @Query() _query: Record<string, never>,
    @Body() _body: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.confirm(params.id, admin.id);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentActivationContract)
  async activate(
    @Param() params: { id: string },
    @Query() _query: Record<string, never>,
    @Body() _body: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.activate(params.id, admin.id);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentRetirementContract)
  async retire(
    @Param() params: { id: string },
    @Query() _query: Record<string, never>,
    @Body() _body: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.retire(params.id, admin.id);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentAssociationContract)
  async replaceVariantAssociations(
    @Param() params: { id: string },
    @Query() _query: Record<string, never>,
    @Body() body: TryOnGarmentVariantAssociationRequest,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.replaceVariantAssociations(
      params.id,
      body,
      admin.id,
    );
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentSourceReplacementContract)
  async replaceSource(
    @Param() params: { id: string },
    @Query() _query: Record<string, never>,
    @Body() body: TryOnGarmentSourceReplacementRequest,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.replaceSource(
      params.id,
      body,
      admin.id,
    );
  }
}
