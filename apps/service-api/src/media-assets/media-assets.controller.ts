import type { Response } from "express";

import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiTags } from "@nestjs/swagger";
import {
  adminProductDisplayImageUploadContract,
  adminTryOnSilhouetteUploadContract,
} from "@vem/shared";

import { RequirePermissions } from "../access/permissions.decorator";
import { Public } from "../auth/public.decorator";
import { AdminResponseContract } from "../common/admin-response-contract.decorator";
import {
  MAX_PRODUCT_DISPLAY_IMAGE_BYTES,
  MAX_TRY_ON_SILHOUETTE_BYTES,
  MediaAssetsService,
} from "./media-assets.service";

type UploadedImageFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

@ApiTags("media-assets")
@ApiBearerAuth()
@Controller("media-assets")
export class MediaAssetsController {
  constructor(private readonly mediaAssetsService: MediaAssetsService) {}

  @RequirePermissions("products.write")
  @Post("product-display-images")
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
  @Post("try-on-silhouettes")
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

  @Public()
  @Get(":id/content")
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
