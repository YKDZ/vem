import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminProductListQuerySchema,
  adminProductVariantListQuerySchema,
  createProductSchema,
  createProductVariantSchema,
  updateProductSchema,
  updateProductVariantSchema,
  type AdminCreateProductRequest,
  type AdminCreateProductVariantRequest,
  type AdminProductListQuery,
  type AdminProductVariantListQuery,
  type AdminUpdateProductRequest,
  type AdminUpdateProductVariantRequest,
} from "@vem/shared";

import { RequirePermissions } from "../access/permissions.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ProductsService } from "./products.service";

@ApiTags("products")
@ApiBearerAuth()
@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @RequirePermissions("products.read")
  @Get("products")
  async listProducts(
    @Query(new ZodValidationPipe(adminProductListQuerySchema))
    query: AdminProductListQuery,
  ) {
    return await this.productsService.listProducts(query);
  }

  @RequirePermissions("products.write")
  @Post("products")
  async createProduct(
    @Body(new ZodValidationPipe(createProductSchema))
    body: AdminCreateProductRequest,
  ) {
    return await this.productsService.createProduct(body);
  }

  @RequirePermissions("products.write")
  @Patch("products/:id")
  async updateProduct(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema))
    body: AdminUpdateProductRequest,
  ) {
    return await this.productsService.updateProduct(id, body);
  }

  @RequirePermissions("products.read")
  @Get("product-variants")
  async listVariants(
    @Query(new ZodValidationPipe(adminProductVariantListQuerySchema))
    query: AdminProductVariantListQuery,
  ) {
    return await this.productsService.listVariants(query);
  }

  @RequirePermissions("products.write")
  @Post("product-variants")
  async createVariant(
    @Body(new ZodValidationPipe(createProductVariantSchema))
    body: AdminCreateProductVariantRequest,
  ) {
    return await this.productsService.createVariant(body);
  }

  @RequirePermissions("products.write")
  @Patch("product-variants/:id")
  async updateVariant(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductVariantSchema))
    body: AdminUpdateProductVariantRequest,
  ) {
    return await this.productsService.updateVariant(id, body);
  }
}
