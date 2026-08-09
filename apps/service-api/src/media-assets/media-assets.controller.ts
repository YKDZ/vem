import type { Response } from "express";

import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiTags } from "@nestjs/swagger";
import {
  adminProductDisplayImageUploadContract,
  adminTryOnGarmentUploadContract,
  adminTryOnSilhouetteUploadContract,
} from "@vem/shared";

import { RequirePermissions } from "../access/permissions.decorator";
import { Public } from "../auth/public.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { AdminResponseContract } from "../common/admin-response-contract.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  MAX_PRODUCT_DISPLAY_IMAGE_BYTES,
  MAX_TRY_ON_SILHOUETTE_BYTES,
  MAX_TRY_ON_GARMENT_BYTES,
  MediaAssetsService,
  managedMediaAssetReference,
} from "./media-assets.service";

type UploadedImageFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

const emptyMultipartFieldsSchema = adminTryOnGarmentUploadContract.querySchema
  .optional()
  .transform(() => ({}));

@ApiTags("media-assets")
@ApiBearerAuth()
@Controller()
export class MediaAssetsController {
  constructor(private readonly mediaAssetsService: MediaAssetsService) {}

  @RequirePermissions("products.write")
  @Post(adminProductDisplayImageUploadContract.path)
  @ApiConsumes("multipart/form-data")
  @AdminResponseContract(adminProductDisplayImageUploadContract)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_PRODUCT_DISPLAY_IMAGE_BYTES },
    }),
  )
  async uploadProductDisplayImage(
    @UploadedFile()
    file: UploadedImageFile,
  ) {
    return toAdminMediaAssetSummary(
      await this.mediaAssetsService.storeProductDisplayImage(file),
    );
  }

  @RequirePermissions("products.write")
  @Post(adminTryOnSilhouetteUploadContract.path)
  @ApiConsumes("multipart/form-data")
  @AdminResponseContract(adminTryOnSilhouetteUploadContract)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_TRY_ON_SILHOUETTE_BYTES },
    }),
  )
  async uploadTryOnSilhouette(
    @UploadedFile()
    file: UploadedImageFile,
  ) {
    return toAdminMediaAssetSummary(
      await this.mediaAssetsService.storeTryOnSilhouette(file),
    );
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminTryOnGarmentUploadContract)
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_TRY_ON_GARMENT_BYTES },
    }),
  )
  async uploadTryOnGarment(
    @UploadedFile()
    file: UploadedImageFile | undefined,
    @Query(new ZodValidationPipe(adminTryOnGarmentUploadContract.querySchema))
    _query: Record<string, never>,
    @Body(new ZodValidationPipe(emptyMultipartFieldsSchema))
    _fields: Record<string, never>,
  ) {
    return toTryOnGarmentMediaAsset(
      await this.mediaAssetsService.storeTryOnGarment(file),
    );
  }

  @Public()
  @Get("/media-assets/:id/content")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  async readPublicContent(
    @Param("id", ParseUUIDPipe) id: string,
    @Res() response: Response,
  ) {
    const content = await this.mediaAssetsService.openPublicContent(id);
    response.contentType(content.contentType);
    content.stream.pipe(response);
  }
}

function toTryOnGarmentMediaAsset(asset: {
  id: string;
  publicUrl: string;
  purpose: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  hasTransparency: boolean | null;
  sha256: string;
}) {
  return {
    id: asset.id,
    managedReference: managedMediaAssetReference(asset.id),
    purpose: asset.purpose,
    contentType: asset.contentType,
    byteSize: asset.byteSize,
    width: asset.width,
    height: asset.height,
    hasTransparency: asset.hasTransparency,
    sha256: asset.sha256,
  };
}

function toAdminMediaAssetSummary(asset: {
  id: string;
  publicUrl: string;
  contentType: string;
}) {
  return {
    id: asset.id,
    publicUrl: asset.publicUrl,
    contentType: asset.contentType,
  };
}
