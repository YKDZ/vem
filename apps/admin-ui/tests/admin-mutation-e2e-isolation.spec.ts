import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const MUTATION_SPECS = [
  "apps/admin-ui/tests/admin-smoke.spec.ts",
  "apps/admin-ui/tests/payment-operations-admin-contract.spec.ts",
  "apps/admin-ui/tests/product-catalog-admin-contract.spec.ts",
];

function read(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

test.describe("Admin UI mutation E2E isolation", () => {
  for (const specPath of MUTATION_SPECS) {
    test(`${specPath} requires the mutation E2E guard`, () => {
      expect(read(specPath)).toContain(
        "skipUnlessAdminMutationE2eEnabled(test)",
      );
    });
  }

  test("the CI admin browser job explicitly runs mutation tests only on its isolated backend", () => {
    const checkCi = read("tools/check-ci.mjs");

    expect(checkCi).toContain("VEM_ADMIN_MUTATION_E2E_TARGET");
    expect(checkCi).toContain('mutationTarget: "isolated"');
  });

  test("the operator manual distinguishes live-safe read-only checks from isolated mutation tests", () => {
    const manual = read("public/manual/operator-manual.md");

    expect(manual).toContain("admin-tabbed-contract.spec.ts");
    expect(manual).toContain("VEM_ADMIN_MUTATION_E2E_TARGET=isolated");
    expect(manual).toContain("不要在现场 VPS 上运行会新增或修改业务数据的测试");
  });
});
