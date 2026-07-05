import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { checkAdminContractE2eCi } from "./check-admin-contract-e2e-ci.mjs";

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), "vem-admin-contract-ci-"));
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

const VALID_WORKFLOW = `
jobs:
  e2e-tests:
    name: E2E Tests
  admin-contract-e2e-tests:
    name: Admin Contract E2E
    # Production readiness candidate check for Admin API Contract browser flows.
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: vem_admin_contract_e2e
    steps:
      - name: Start MQTT Broker
        run: |
          docker run -d --name mosquitto-admin-contract-e2e eclipse-mosquitto:2
      - name: Build Service API
        run: pnpm turbo build --filter service-api
      - name: Run Database Migrations
        run: pnpm --filter @vem/db migrate
        env:
          DATABASE_URL: postgresql://vem:vem_password@localhost:5432/vem_admin_contract_e2e
      - name: Start Service API
        run: node dist/main.js > ../../admin-contract-service-api.log 2>&1 &
        env:
          MQTT_URL: mqtt://localhost:1883
      - name: Start Admin UI Dev Server
        run: pnpm dev > ../../admin-contract-admin-ui.log 2>&1 &
      - name: Run Admin Contract E2E Tests
        run: pnpm test:e2e:admin-contract
      - name: Upload Admin Contract Playwright Artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          path: apps/admin-ui/test-results/
          if-no-files-found: warn
      - name: Upload Admin Contract Logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          path: |
            admin-contract-service-api.log
            admin-contract-admin-ui.log
`;

const VALID_ADMIN_UI_PACKAGE = JSON.stringify({
  scripts: {
    "test:e2e:admin-contract":
      "playwright test tests/product-catalog-admin-contract.spec.ts tests/payment-operations-admin-contract.spec.ts tests/access-management-insufficient-permission.spec.ts",
  },
});

describe("Admin Contract E2E CI guard", () => {
  it("accepts a dedicated production-readiness candidate job and targeted command", () => {
    withFixture(
      {
        ".github/workflows/ci.yml": VALID_WORKFLOW,
        "apps/admin-ui/package.json": VALID_ADMIN_UI_PACKAGE,
      },
      (root) => {
        const result = checkAdminContractE2eCi({ root });

        assert.equal(result.ok, true, result.failures.join("\n"));
      },
    );
  });

  it("fails when the workflow only has the broad e2e smoke job", () => {
    withFixture(
      {
        ".github/workflows/ci.yml": `
jobs:
  e2e-tests:
    name: E2E Tests
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: vem
    steps:
      - run: pnpm test:e2e
`,
        "apps/admin-ui/package.json": VALID_ADMIN_UI_PACKAGE,
      },
      (root) => {
        const result = checkAdminContractE2eCi({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /missing dedicated admin-contract-e2e-tests job/,
        );
      },
    );
  });

  it("fails when the dedicated job runs the broad Playwright suite", () => {
    withFixture(
      {
        ".github/workflows/ci.yml": VALID_WORKFLOW.replace(
          "pnpm test:e2e:admin-contract",
          "pnpm test:e2e",
        ),
        "apps/admin-ui/package.json": VALID_ADMIN_UI_PACKAGE,
      },
      (root) => {
        const result = checkAdminContractE2eCi({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /should run pnpm test:e2e:admin-contract/,
        );
      },
    );
  });

  it("fails when the targeted package script omits a required admin contract spec", () => {
    withFixture(
      {
        ".github/workflows/ci.yml": VALID_WORKFLOW,
        "apps/admin-ui/package.json": JSON.stringify({
          scripts: {
            "test:e2e:admin-contract":
              "playwright test tests/payment-operations-admin-contract.spec.ts",
          },
        }),
      },
      (root) => {
        const result = checkAdminContractE2eCi({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin-ui test:e2e:admin-contract should include tests\/product-catalog-admin-contract\.spec\.ts/,
        );
      },
    );
  });

  it("fails when the targeted package script omits the browser permission gate contract", () => {
    withFixture(
      {
        ".github/workflows/ci.yml": VALID_WORKFLOW,
        "apps/admin-ui/package.json": JSON.stringify({
          scripts: {
            "test:e2e:admin-contract":
              "playwright test tests/product-catalog-admin-contract.spec.ts tests/payment-operations-admin-contract.spec.ts",
          },
        }),
      },
      (root) => {
        const result = checkAdminContractE2eCi({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin-ui test:e2e:admin-contract should include tests\/access-management-insufficient-permission\.spec\.ts/,
        );
      },
    );
  });

  it("fails when the workflow does not upload current Playwright failure artifacts", () => {
    withFixture(
      {
        ".github/workflows/ci.yml": VALID_WORKFLOW.replace(
          "apps/admin-ui/test-results/",
          "apps/admin-ui/missing-report/",
        ),
        "apps/admin-ui/package.json": VALID_ADMIN_UI_PACKAGE,
      },
      (root) => {
        const result = checkAdminContractE2eCi({ root });

        assert.equal(result.ok, false);
        assert.match(
          result.failures.join("\n"),
          /admin-contract-e2e-tests job should include apps\/admin-ui\/test-results\//,
        );
      },
    );
  });
});
