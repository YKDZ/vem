import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminTryOnGarmentConfirmationContract,
  type TryOnGarmentDraftRequest,
} from "@vem/shared";

import { RequirePermissions } from "../access/permissions.decorator";
import { AdminResponseContract } from "../common/admin-response-contract.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TryOnGarmentsService } from "./try-on-garments.service";

@ApiTags("try-on-garments")
@ApiBearerAuth()
@Controller()
export class TryOnGarmentsController {
  constructor(private readonly tryOnGarmentsService: TryOnGarmentsService) {}

  @RequirePermissions("products.write")
  @Post(adminCreateTryOnGarmentContract.path)
  @AdminResponseContract(adminCreateTryOnGarmentContract)
  async createDraft(
    @Body(new ZodValidationPipe(adminCreateTryOnGarmentContract.bodySchema))
    body: TryOnGarmentDraftRequest,
  ) {
    return await this.tryOnGarmentsService.createDraft(body);
  }

  @RequirePermissions("products.read")
  @Get(adminGetTryOnGarmentContract.path)
  @AdminResponseContract(adminGetTryOnGarmentContract)
  async getById(
    @Param(new ZodValidationPipe(adminGetTryOnGarmentContract.pathParamsSchema))
    params: { id: string },
  ) {
    return await this.tryOnGarmentsService.getById(params.id);
  }

  @RequirePermissions("products.write")
  @Post(adminTryOnGarmentConfirmationContract.path)
  @AdminResponseContract(adminTryOnGarmentConfirmationContract)
  async confirm(
    @Param(
      new ZodValidationPipe(
        adminTryOnGarmentConfirmationContract.pathParamsSchema,
      ),
    )
    params: { id: string },
  ) {
    return await this.tryOnGarmentsService.confirm(params.id);
  }
}
