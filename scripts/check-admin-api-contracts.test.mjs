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
