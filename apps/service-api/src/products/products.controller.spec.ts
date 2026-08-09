import "reflect-metadata";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  adminCreateProductContract,
  adminCreateProductVariantContract,
  adminListProductsContract,
  adminListProductVariantsContract,
  adminUpdateProductContract,
  adminUpdateProductVariantContract,
} from "@vem/shared";
import { describe, expect, it } from "vitest";

import { ADMIN_ENDPOINT_CONTRACT } from "../common/admin-endpoint-contract.decorator";
import { ProductsController } from "./products.controller";

describe("ProductsController endpoint binding", () => {
  it.each([
    ["listProducts", adminListProductsContract],
    ["createProduct", adminCreateProductContract],
    ["updateProduct", adminUpdateProductContract],
    ["listVariants", adminListProductVariantsContract],
    ["createVariant", adminCreateProductVariantContract],
    ["updateVariant", adminUpdateProductVariantContract],
  ] as const)(
    "binds %s directly to its complete shared contract",
    (method, contract) => {
      const handler = ProductsController.prototype[method];
      expect(Reflect.getMetadata(ADMIN_ENDPOINT_CONTRACT, handler)).toBe(
        contract,
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(contract.path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        ({ GET: 0, POST: 1, PATCH: 4 } as const)[contract.method],
      );
    },
  );
});
