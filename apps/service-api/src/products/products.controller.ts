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
  createProductSchema,
  createProductVariantSchema,
  pageQuerySchema,
  updateProductSchema,
  updateProductVariantSchema,
} from "@vem/shared";
import { z } from "zod";

import { RequirePermissions } from "../access/permissions.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ProductsService } from "./products.service";

type CreateProductInput = z.infer<typeof createProductSchema>;
type UpdateProductInput = z.infer<typeof updateProductSchema>;
type CreateProductVariantInput = z.infer<typeof createProductVariantSchema>;
type UpdateProductVariantInput = z.infer<typeof updateProductVariantSchema>;
type PageQueryInput = z.infer<typeof pageQuerySchema>;

@ApiTags("products")
@ApiBearerAuth()
@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @RequirePermissions("products.read")
  @Get("products")
  async listProducts(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQueryInput,
  ) {
    return await this.productsService.listProducts(query);
  }

  @RequirePermissions("products.write")
  @Post("products")
  async createProduct(
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ) {
    return await this.productsService.createProduct(body);
  }

  @RequirePermissions("products.write")
  @Patch("products/:id")
  async updateProduct(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ) {
    return await this.productsService.updateProduct(id, body);
  }

  @RequirePermissions("products.read")
  @Get("product-variants")
  async listVariants(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQueryInput,
  ) {
    return await this.productsService.listVariants(query);
  }

  @RequirePermissions("products.write")
  @Post("product-variants")
  async createVariant(
    @Body(new ZodValidationPipe(createProductVariantSchema))
    body: CreateProductVariantInput,
  ) {
    return await this.productsService.createVariant(body);
  }

  @RequirePermissions("products.write")
  @Patch("product-variants/:id")
  async updateVariant(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductVariantSchema))
    body: UpdateProductVariantInput,
  ) {
    return await this.productsService.updateVariant(id, body);
  }
}
