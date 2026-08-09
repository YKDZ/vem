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
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TryOnGarmentsService } from "./try-on-garments.service";

@ApiTags("try-on-garments")
@ApiBearerAuth()
@Controller()
export class TryOnGarmentsController {
  constructor(private readonly tryOnGarmentsService: TryOnGarmentsService) {}

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminCreateTryOnGarmentContract)
  async createDraft(
    @Body(new ZodValidationPipe(adminCreateTryOnGarmentContract.bodySchema))
    body: TryOnGarmentDraftRequest,
    @Query(new ZodValidationPipe(adminCreateTryOnGarmentContract.querySchema))
    _query: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.createDraft(body, admin.id);
  }

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminGetTryOnGarmentContract)
  async getById(
    @Param(new ZodValidationPipe(adminGetTryOnGarmentContract.pathParamsSchema))
    params: { id: string },
    @Query(new ZodValidationPipe(adminGetTryOnGarmentContract.querySchema))
    _query: Record<string, never>,
  ) {
    return await this.tryOnGarmentsService.getById(params.id);
  }

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminListTryOnGarmentsByProductContract)
  async listByProduct(
    @Query(
      new ZodValidationPipe(
        adminListTryOnGarmentsByProductContract.querySchema,
      ),
    )
    query: { productId: string },
  ) {
    return await this.tryOnGarmentsService.listByProduct(query.productId);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentConfirmationContract)
  async confirm(
    @Param(
      new ZodValidationPipe(
        adminTryOnGarmentConfirmationContract.pathParamsSchema,
      ),
    )
    params: { id: string },
    @Query(
      new ZodValidationPipe(adminTryOnGarmentConfirmationContract.querySchema),
    )
    _query: Record<string, never>,
    @Body(
      new ZodValidationPipe(adminTryOnGarmentConfirmationContract.bodySchema),
    )
    _body: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.confirm(params.id, admin.id);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentActivationContract)
  async activate(
    @Param(
      new ZodValidationPipe(
        adminTryOnGarmentActivationContract.pathParamsSchema,
      ),
    )
    params: { id: string },
    @Query(
      new ZodValidationPipe(adminTryOnGarmentActivationContract.querySchema),
    )
    _query: Record<string, never>,
    @Body(new ZodValidationPipe(adminTryOnGarmentActivationContract.bodySchema))
    _body: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.activate(params.id, admin.id);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentRetirementContract)
  async retire(
    @Param(
      new ZodValidationPipe(
        adminTryOnGarmentRetirementContract.pathParamsSchema,
      ),
    )
    params: { id: string },
    @Query(
      new ZodValidationPipe(adminTryOnGarmentRetirementContract.querySchema),
    )
    _query: Record<string, never>,
    @Body(new ZodValidationPipe(adminTryOnGarmentRetirementContract.bodySchema))
    _body: Record<string, never>,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.retire(params.id, admin.id);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentAssociationContract)
  async replaceVariantAssociations(
    @Param(
      new ZodValidationPipe(
        adminTryOnGarmentAssociationContract.pathParamsSchema,
      ),
    )
    params: { id: string },
    @Query(
      new ZodValidationPipe(adminTryOnGarmentAssociationContract.querySchema),
    )
    _query: Record<string, never>,
    @Body(
      new ZodValidationPipe(adminTryOnGarmentAssociationContract.bodySchema),
    )
    body: TryOnGarmentVariantAssociationRequest,
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
    @Param(
      new ZodValidationPipe(
        adminTryOnGarmentSourceReplacementContract.pathParamsSchema,
      ),
    )
    params: { id: string },
    @Query(
      new ZodValidationPipe(
        adminTryOnGarmentSourceReplacementContract.querySchema,
      ),
    )
    _query: Record<string, never>,
    @Body(
      new ZodValidationPipe(
        adminTryOnGarmentSourceReplacementContract.bodySchema,
      ),
    )
    body: TryOnGarmentSourceReplacementRequest,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return await this.tryOnGarmentsService.replaceSource(
      params.id,
      body,
      admin.id,
    );
  }
}
