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

const productListQuerySchema = pageQuerySchema.extend({
  keyword: z.string().max(128).optional(),
  status: z.enum(["draft", "active", "inactive"]).optional(),
});

const productVariantListQuerySchema = pageQuerySchema.extend({
  productId: z.uuid().optional(),
});

type ProductListQuery = z.infer<typeof productListQuerySchema>;
type ProductVariantListQuery = z.infer<typeof productVariantListQuerySchema>;

@ApiTags("products")
@ApiBearerAuth()
@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @RequirePermissions("products.read")
  @Get("products")
  async listProducts(
    @Query(new ZodValidationPipe(productListQuerySchema))
    query: ProductListQuery,
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
    @Query(new ZodValidationPipe(productVariantListQuerySchema))
    query: ProductVariantListQuery,
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
