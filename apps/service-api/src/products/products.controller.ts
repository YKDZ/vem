import { Body, Controller, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import {
  adminListProductsContract,
  adminCreateProductContract,
  adminUpdateProductContract,
  adminListProductVariantsContract,
  adminCreateProductVariantContract,
  adminUpdateProductVariantContract,
  type AdminCreateProductRequest,
  type AdminCreateProductVariantRequest,
  type AdminProductListQuery,
  type AdminProductVariantListQuery,
  type AdminUpdateProductRequest,
  type AdminUpdateProductVariantRequest,
} from "@vem/shared";

import { RequirePermissions } from "../access/permissions.decorator";
import { AdminEndpointContract } from "../common/admin-endpoint-contract.decorator";
import { ProductsService } from "./products.service";

@ApiTags("products")
@ApiBearerAuth()
@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminListProductsContract)
  async listProducts(@Query() query: AdminProductListQuery) {
    return await this.productsService.listProducts(query);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminCreateProductContract)
  async createProduct(@Body() body: AdminCreateProductRequest) {
    return await this.productsService.createProduct(body);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminUpdateProductContract)
  async updateProduct(
    @Param() params: { id: string },
    @Body() body: AdminUpdateProductRequest,
  ) {
    return await this.productsService.updateProduct(params.id, body);
  }

  @RequirePermissions("products.read")
  @AdminEndpointContract(adminListProductVariantsContract)
  async listVariants(@Query() query: AdminProductVariantListQuery) {
    return await this.productsService.listVariants(query);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminCreateProductVariantContract)
  async createVariant(@Body() body: AdminCreateProductVariantRequest) {
    return await this.productsService.createVariant(body);
  }

  @RequirePermissions("products.write")
  @AdminEndpointContract(adminUpdateProductVariantContract)
  async updateVariant(
    @Param() params: { id: string },
    @Body() body: AdminUpdateProductVariantRequest,
  ) {
    return await this.productsService.updateVariant(params.id, body);
  }
}
