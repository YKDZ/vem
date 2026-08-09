import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkAdminApiContracts } from "./check-admin-api-contracts.mjs";

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), "vem-admin-contracts-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolutePath = join(root, path);
      mkdirSync(join(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, content);
    }
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("admin api contract guard", () => {
  const tryOnFixture = (
    providerDecorator = "AdminEndpointContract",
    caller = true,
  ) => ({
    "packages/shared/src/schemas/try-on-garments.ts": `
      const z = { strictObject: () => ({}) };
      const defineAdminEndpointContract = (value) => value;
      const garmentPathParamsSchema = z.strictObject({});
      const noQuerySchema = z.strictObject({});
      const noBodySchema = z.strictObject({});
      const tryOnGarmentDraftRequestSchema = z.strictObject({});
      const tryOnGarmentResponseSchema = z.strictObject({});
      const tryOnGarmentMediaAssetSchema = z.strictObject({});
      export const adminTryOnGarmentUploadContract = defineAdminEndpointContract({ method: "POST", path: "/media-assets/try-on-garments", pathParamsSchema: z.strictObject({}), querySchema: noQuerySchema, bodySchema: z.strictObject({}), responseSchema: tryOnGarmentMediaAssetSchema });
      export const adminCreateTryOnGarmentContract = defineAdminEndpointContract({ method: "POST", path: "/try-on-garments", pathParamsSchema: z.strictObject({}), querySchema: noQuerySchema, bodySchema: tryOnGarmentDraftRequestSchema, responseSchema: tryOnGarmentResponseSchema });
      export const adminGetTryOnGarmentContract = defineAdminEndpointContract({ method: "GET", path: "/try-on-garments/:id", pathParamsSchema: garmentPathParamsSchema, querySchema: noQuerySchema, bodySchema: noBodySchema, responseSchema: tryOnGarmentResponseSchema });
      export const adminTryOnGarmentConfirmationContract = defineAdminEndpointContract({ method: "POST", path: "/try-on-garments/:id/confirmation", pathParamsSchema: garmentPathParamsSchema, querySchema: noQuerySchema, bodySchema: noBodySchema, responseSchema: tryOnGarmentResponseSchema });
    `,
    "apps/service-api/src/try-on-garments/try-on-garments.controller.ts": `
      class TryOnGarmentsController {
        @${providerDecorator}(adminCreateTryOnGarmentContract) createDraft() {}
        @${providerDecorator}(adminGetTryOnGarmentContract) getById() {}
        @${providerDecorator}(adminTryOnGarmentConfirmationContract) confirm() {}
      }
    `,
    "apps/service-api/src/media-assets/media-assets.controller.ts": `
      class MediaAssetsController {
        @${providerDecorator}(adminTryOnGarmentUploadContract) uploadTryOnGarment() {}
      }
    `,
    "apps/service-api/src/try-on-garments/try-on-garments.module.ts": `
      @Module({ controllers: [TryOnGarmentsController] })
      class TryOnGarmentsModule {}
    `,
    "apps/service-api/src/media-assets/media-assets.module.ts": `
      @Module({ controllers: [MediaAssetsController] })
      class MediaAssetsModule {}
    `,
    ...(caller
      ? {
          "apps/admin-ui/src/api/try-on-garments.ts": `
            export async function uploadTryOnGarment() { return callAdminEndpointContract(adminTryOnGarmentUploadContract, {}); }
            export async function createTryOnGarmentDraft() { return callAdminEndpointContract(adminCreateTryOnGarmentContract, {}); }
            export async function getTryOnGarment() { return callAdminEndpointContract(adminGetTryOnGarmentContract, {}); }
            export async function confirmTryOnGarment() { return callAdminEndpointContract(adminTryOnGarmentConfirmationContract, {}); }
          `,
        }
      : {}),
  });

  it("requires executable provider bindings, not response-only metadata", () => {
    withFixture(tryOnFixture("AdminResponseContract"), (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(
        result.failures.join("\n"),
        /try-on endpoint contract provider missing: adminCreateTryOnGarmentContract/,
      );
    });
  });

  it("ignores comments and dead code and rejects a missing caller", () => {
    const files = tryOnFixture();
    files["apps/admin-ui/src/api/try-on-garments.ts"] = `
      // callAdminEndpointContract(adminTryOnGarmentUploadContract, {})
      export async function uploadTryOnGarment() {
        if (false) return callAdminEndpointContract(adminTryOnGarmentUploadContract, {});
        return undefined;
      }
      export async function createTryOnGarmentDraft() { return callAdminEndpointContract(adminCreateTryOnGarmentContract, {}); }
      export async function getTryOnGarment() { return callAdminEndpointContract(adminGetTryOnGarmentContract, {}); }
      export async function confirmTryOnGarment() { return callAdminEndpointContract(adminTryOnGarmentConfirmationContract, {}); }
    `;
    withFixture(files, (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(
        result.failures.join("\n"),
        /try-on endpoint contract caller missing: adminTryOnGarmentUploadContract/,
      );
    });
  });

  it("does not count a contract call after an unconditional return", () => {
    const files = tryOnFixture();
    files["apps/admin-ui/src/api/try-on-garments.ts"] = `
      export async function uploadTryOnGarment() {
        return undefined;
        return callAdminEndpointContract(adminTryOnGarmentUploadContract, {});
      }
      export async function createTryOnGarmentDraft() { return callAdminEndpointContract(adminCreateTryOnGarmentContract, {}); }
      export async function getTryOnGarment() { return callAdminEndpointContract(adminGetTryOnGarmentContract, {}); }
      export async function confirmTryOnGarment() { return callAdminEndpointContract(adminTryOnGarmentConfirmationContract, {}); }
    `;
    withFixture(files, (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(
        result.failures.join("\n"),
        /try-on endpoint contract caller missing: adminTryOnGarmentUploadContract/,
      );
    });
  });

  it("rejects incomplete or unknown schemas in every try-on contract", () => {
    const files = tryOnFixture();
    files["packages/shared/src/schemas/try-on-garments.ts"] = files[
      "packages/shared/src/schemas/try-on-garments.ts"
    ]
      .replace(
        "bodySchema: z.strictObject({}), responseSchema: tryOnGarmentMediaAssetSchema",
        "bodySchema: z.unknown(), responseSchema: tryOnGarmentMediaAssetSchema",
      )
      .replace(
        "bodySchema: tryOnGarmentDraftRequestSchema, responseSchema: tryOnGarmentResponseSchema",
        "bodySchema: tryOnGarmentDraftRequestSchema",
      );
    withFixture(files, (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(
        result.failures.join("\n"),
        /adminCreateTryOnGarmentContract missing responseSchema/,
      );
      assert.match(
        result.failures.join("\n"),
        /adminTryOnGarmentUploadContract uses unknown schema for bodySchema/,
      );
    });
  });

  it("rejects a schema reference drift even when the replacement is a known schema", () => {
    const files = tryOnFixture();
    files["packages/shared/src/schemas/try-on-garments.ts"] = files[
      "packages/shared/src/schemas/try-on-garments.ts"
    ].replace("querySchema: noQuerySchema", "querySchema: noBodySchema");
    withFixture(files, (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(
        result.failures.join("\n"),
        /adminTryOnGarmentUploadContract querySchema expected noQuerySchema/,
      );
    });
  });

  it("rejects a provider controller that is not registered by a Nest module", () => {
    const files = tryOnFixture();
    delete files["apps/service-api/src/media-assets/media-assets.module.ts"];
    withFixture(files, (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(
        result.failures.join("\n"),
        /provider controller unregistered: adminTryOnGarmentUploadContract/,
      );
    });
  });

  it("rejects a provider or caller bound to another exact contract", () => {
    const files = tryOnFixture();
    files["apps/service-api/src/media-assets/media-assets.controller.ts"] =
      files[
        "apps/service-api/src/media-assets/media-assets.controller.ts"
      ].replace(
        "adminTryOnGarmentUploadContract) uploadTryOnGarment",
        "adminCreateTryOnGarmentContract) uploadTryOnGarment",
      );
    files["apps/admin-ui/src/api/try-on-garments.ts"] = files[
      "apps/admin-ui/src/api/try-on-garments.ts"
    ].replace(
      "adminTryOnGarmentUploadContract, {}",
      "adminCreateTryOnGarmentContract, {}",
    );
    withFixture(files, (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(
        result.failures.join("\n"),
        /provider missing: adminTryOnGarmentUploadContract/,
      );
      assert.match(
        result.failures.join("\n"),
        /caller missing: adminTryOnGarmentUploadContract/,
      );
    });
  });

  it("rejects method and path drift in the shared contract registry", () => {
    const files = tryOnFixture();
    files["packages/shared/src/schemas/try-on-garments.ts"] = files[
      "packages/shared/src/schemas/try-on-garments.ts"
    ].replace(
      'method: "GET", path: "/try-on-garments/:id"',
      'method: "POST", path: "/wrong"',
    );
    withFixture(files, (root) => {
      const result = checkAdminApiContracts({ root });
      assert.equal(result.ok, false);
      assert.match(result.failures.join("\n"), /method drift/);
      assert.match(result.failures.join("\n"), /path drift/);
    });
  });

  it("accepts a write caller that uses schema-bound helpers", () => {
    withFixture(
      {
        "apps/admin-ui/src/api/products.ts": `
          import type { z } from "zod";
          import { createProductSchema, adminProductResponseSchema } from "@vem/shared";
          import { postContract } from "./request";

          export async function createProduct(body: z.input<typeof createProductSchema>) {
            return await postContract("/products", createProductSchema, adminProductResponseSchema, body);
          }
        `,
      },
      (root) => {
        const result = checkAdminApiContracts({ root });

        assert.equal(result.ok, true);
        assert.deepEqual(result.failures, []);
      },
    );
  });

  it("fails write callers that use unbound helpers", () => {
    withFixture(
      {
        "apps/admin-ui/src/api/inventory.ts": `
          import { post } from "./request";

          export async function createInventory(body: { machineId: string }) {
            return await post("/inventories", body);
          }
        `,
      },
      (root) => {
        const result = checkAdminApiContracts({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin write caller uses unbound post: apps\/admin-ui\/src\/api\/inventory\.ts#createInventory/,
        );
        assert.match(
          result.failures.join("\n"),
          /admin write caller missing schema-bound helper: apps\/admin-ui\/src\/api\/inventory\.ts#createInventory/,
        );
      },
    );
  });

  it("fails exported async arrow write callers that use unbound helpers", () => {
    withFixture(
      {
        "apps/admin-ui/src/api/inventory.ts": `
          import { post } from "./request";

          export const createInventory = async (body: { machineId: string }) => {
            return await post("/inventories", body);
          };
        `,
      },
      (root) => {
        const result = checkAdminApiContracts({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin write caller uses unbound post: apps\/admin-ui\/src\/api\/inventory\.ts#createInventory/,
        );
      },
    );
  });

  it("fails write callers that drift back to unbound helpers or local body types", () => {
    withFixture(
      {
        "apps/admin-ui/src/api/products.ts": `
          import { post } from "./request";

          type CreateProductInput = { name: string };

          export async function createProduct(body: CreateProductInput) {
            return await post("/products", body);
          }
        `,
      },
      (root) => {
        const result = checkAdminApiContracts({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin write caller uses unbound post: apps\/admin-ui\/src\/api\/products\.ts#createProduct/,
        );
        assert.match(
          result.failures.join("\n"),
          /admin write caller uses local body type: apps\/admin-ui\/src\/api\/products\.ts#createProduct/,
        );
      },
    );
  });

  it("fails write callers that use generic local body type shortcuts", () => {
    withFixture(
      {
        "apps/admin-ui/src/api/payments.ts": `
          import { patchContract } from "./request";

          type PaymentProvider = { name: string; status: string; capabilities: string[] };

          export async function updatePaymentProvider(
            id: string,
            body: Partial<Pick<PaymentProvider, "name" | "status" | "capabilities">>,
          ) {
            return await patchContract("/payments/providers/" + id, updateProviderSchema, paymentProviderSchema, body);
          }
        `,
      },
      (root) => {
        const result = checkAdminApiContracts({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin write caller uses local body type: apps\/admin-ui\/src\/api\/payments\.ts#updatePaymentProvider/,
        );
      },
    );
  });

  it("fails broad query shortcuts inside admin api modules with writes", () => {
    withFixture(
      {
        "apps/admin-ui/src/api/products.ts": `
          import type { z } from "zod";
          import { createProductSchema, adminProductResponseSchema } from "@vem/shared";
          import { get, postContract } from "./request";

          export async function listProducts(query?: Record<string, unknown>) {
            return await get("/products", { params: query });
          }

          export async function createProduct(body: z.input<typeof createProductSchema>) {
            return await postContract("/products", createProductSchema, adminProductResponseSchema, body);
          }
        `,
      },
      (root) => {
        const result = checkAdminApiContracts({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin api write module uses broad query type: apps\/admin-ui\/src\/api\/products\.ts#listProducts/,
        );
      },
    );
  });
});
