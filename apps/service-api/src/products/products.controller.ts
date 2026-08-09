import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminProductListQuerySchema,
  adminListProductsContract,
  adminCreateProductContract,
  adminUpdateProductContract,
  adminListProductVariantsContract,
  adminCreateProductVariantContract,
  adminUpdateProductVariantContract,
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
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ProductsService } from "./products.service";

@ApiTags("products")
@ApiBearerAuth()
@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminListProductsContract)
  async listProducts(
    @Query(new ZodValidationPipe(adminProductListQuerySchema))
    query: AdminProductListQuery,
  ) {
    return await this.productsService.listProducts(query);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminCreateProductContract)
  async createProduct(
    @Body(new ZodValidationPipe(createProductSchema))
    body: AdminCreateProductRequest,
  ) {
    return await this.productsService.createProduct(body);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminUpdateProductContract)
  async updateProduct(
    @Param(new ZodValidationPipe(adminUpdateProductContract.pathParamsSchema))
    params: { id: string },
    @Body(new ZodValidationPipe(updateProductSchema))
    body: AdminUpdateProductRequest,
  ) {
    return await this.productsService.updateProduct(params.id, body);
  }

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminListProductVariantsContract)
  async listVariants(
    @Query(new ZodValidationPipe(adminProductVariantListQuerySchema))
    query: AdminProductVariantListQuery,
  ) {
    return await this.productsService.listVariants(query);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminCreateProductVariantContract)
  async createVariant(
    @Body(new ZodValidationPipe(createProductVariantSchema))
    body: AdminCreateProductVariantRequest,
  ) {
    return await this.productsService.createVariant(body);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminUpdateProductVariantContract)
  async updateVariant(
    @Param(
      new ZodValidationPipe(adminUpdateProductVariantContract.pathParamsSchema),
    )
    params: { id: string },
    @Body(new ZodValidationPipe(updateProductVariantSchema))
    body: AdminUpdateProductVariantRequest,
  ) {
    return await this.productsService.updateVariant(params.id, body);
  }
}
