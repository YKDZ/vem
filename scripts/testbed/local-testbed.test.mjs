import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildReconstructionPlan,
  parseOptions,
  seedThroughSupportedApis,
  validateBaselineContract,
} from "./local-testbed.mjs";

function contract(root) {
  return {
    schemaVersion: "win10-kvm-baseline-current/v1",
    artifacts: {
      systemPath: join(root, "system.qcow2"),
      cachePath: join(root, "cache.qcow2"),
    },
    testbed: {
      reconstructCommand: ["/opt/vem/reset-overlay", "--run", "{runId}"],
      admitRunnerCommand: ["/opt/vem/admit-runner", "--run", "{runId}"],
      guest: {
        host: "win10-testbed.local",
        user: "baseline",
        identityFile: join(root, "id_ed25519"),
        knownHostsFile: join(root, "known_hosts"),
        stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        cacheRoot: "D:\\runtime-cache\\v1",
      },
    },
  };
}

function options(root, mode = "full") {
  return parseOptions([
    "reconstruct",
    "--mode",
    mode,
    "--run-id",
    "run-15",
    "--workspace",
    root,
    "--state-root",
    join(root, "state"),
    "--baseline-contract",
    join(root, "baseline.json"),
    "--host-private-address",
    "10.0.0.15",
    "--out",
    join(root, "out.json"),
  ]);
}

describe("local testbed orchestration", () => {
  it("requires the generic baseline contract to separate reconstruction from runner admission", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      assert.deepEqual(validateBaselineContract(value), value);
      delete value.testbed.admitRunnerCommand;
      assert.throws(
        () => validateBaselineContract(value),
        /admitRunnerCommand/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces fixed host state and C overlay before admitting the Windows runner", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      const value = contract(root);
      writeFileSync(join(root, "baseline.json"), JSON.stringify(value));
      const plan = buildReconstructionPlan(options(root), value);
      const rendered = plan.map(
        (step) => `${step.command} ${step.args.join(" ")}`,
      );
      const resetIndex = rendered.findIndex((step) =>
        step.includes("reset-overlay"),
      );
      const postgresIndex = rendered.findIndex((step) =>
        step.includes("postgres:16"),
      );
      const admissionIndex = rendered.findIndex((step) =>
        step.includes("admit-runner"),
      );
      assert.ok(
        rendered.some((step) =>
          step.includes(
            "docker rm -f vem-local-testbed-postgres vem-local-testbed-mosquitto",
          ),
        ),
      );
      assert.ok(
        rendered.some((step) =>
          step.includes(
            "docker volume rm -f vem-local-testbed-postgres-data vem-local-testbed-mosquitto-data",
          ),
        ),
      );
      assert.ok(
        resetIndex >= 0 &&
          resetIndex < postgresIndex &&
          postgresIndex < admissionIndex,
      );
      assert.ok(rendered.some((step) => step.includes("guest-input.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tracked defaults that could encode a host address", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-local-testbed-"));
    try {
      assert.throws(() => options(root, "invalid"), /--mode/);
      assert.throws(
        () =>
          parseOptions([
            "reconstruct",
            "--mode",
            "fast",
            "--run-id",
            "x",
            "--workspace",
            root,
            "--state-root",
            join(root, "state"),
            "--baseline-contract",
            join(root, "contract"),
            "--host-private-address",
            "127.0.0.1",
            "--out",
            join(root, "out"),
          ]),
        /non-loopback IPv4/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("supported API seeding", () => {
  it("uses only real Admin API endpoints with controller-compatible bodies", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/local-testbed-catalog.json", import.meta.url),
        "utf8",
      ),
    );
    const calls = [];
    const request = async (_base, path, input = {}) => {
      calls.push({ path, ...input });
      if (path === "/auth/login") return { accessToken: "admin-token" };
      if (path === "/products") return { id: `product-${calls.length}` };
      if (path === "/product-variants")
        return { id: `variant-${calls.length}`, sku: input.body.sku };
      if (path === "/payments/providers")
        return [{ id: "mock-provider", code: "mock", status: "enabled" }];
      if (path === "/machines")
        return { id: "machine-1", code: "VEM-TESTBED-LOCAL" };
      if (path.endsWith("/slots")) return { id: `slot-${calls.length}` };
      if (path === "/inventories") return { id: `inventory-${calls.length}` };
      if (path.endsWith("/planogram-versions"))
        return { planogramVersion: "LOCAL-TESTBED-V1" };
      if (path.endsWith("/claim-codes"))
        return { id: "claim-1", claimCode: "ABCD-1234" };
      if (path.includes("/payments/providers/"))
        return { id: "mock-provider", status: "enabled" };
      throw new Error(`unexpected path: ${path}`);
    };
    const result = await seedThroughSupportedApis({
      baseUrl: "http://127.0.0.1:26849/api",
      fixture,
      hostPrivateAddress: "10.0.0.15",
      request,
    });
    assert.equal(result.machine.code, "VEM-TESTBED-LOCAL");
    assert.equal(calls.filter((call) => call.path === "/products").length, 44);
    assert.deepEqual(
      calls.find((call) => call.path === "/payments/providers/mock-provider"),
      {
        path: "/payments/providers/mock-provider",
        method: "PATCH",
        token: "admin-token",
        body: {
          status: "enabled",
          capabilities: {
            createPaymentIntent: true,
            paymentCode: true,
            webhook: true,
            refund: true,
          },
        },
      },
    );
    assert.deepEqual(
      calls.find((call) => call.path.endsWith("/claim-codes")).body,
      { purpose: "first_claim" },
    );
    assert.ok(
      calls.some(
        (call) => call.path === "/inventories" && call.body.onHandQty === 3,
      ),
    );
    assert.doesNotMatch(JSON.stringify(calls), /channel-policy/);
  });
});

describe("Windows D cache contract", () => {
  it("uses tool-supported cache settings and clear_cache removes only declared directories", () => {
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    for (const required of [
      "$env:CARGO_HOME",
      "$env:RUSTC_WRAPPER",
      "sccache --show-stats",
      "pnpm config set store-dir",
      "pnpm config get store-dir",
      "--cache-dir $env:TURBO_CACHE_DIR",
      "$env:CARGO_TARGET_DIR",
      "$env:SCCACHE_DIR",
    ])
      assert.match(
        guest,
        new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    assert.match(guest, /function Clear-DeclaredCaches/);
    assert.match(guest, /Join-Path \$cacheRoot "cargo-home"/);
    assert.match(guest, /Join-Path \$cacheRoot "pnpm-store"/);
    assert.match(
      guest,
      /function Clear-DeclaredCaches \{\s+foreach \(\$path in \$declaredCachePaths\) \{\s+Remove-Item -LiteralPath \$path -Recurse -Force -ErrorAction SilentlyContinue/s,
    );
    assert.equal((guest.match(/Remove-Item -LiteralPath/g) ?? []).length, 1);
    assert.doesNotMatch(guest, /Remove-Item -LiteralPath \$cacheRoot -Recurse/);
    assert.doesNotMatch(guest, /CARGO_REGISTRY_CACHE|CARGO_GIT_CACHE/);
  });
});

describe("local testbed fixture", () => {
  it("is a tracked normalized snapshot and does not read ignored authoring material at runtime", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/local-testbed-catalog.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(fixture.schemaVersion, "vem-local-testbed-catalog/v1");
    assert.equal(fixture.products.length, 44);
    assert.deepEqual(
      fixture.slots.map((slot) => slot.slotCode),
      ["A1", "A2"],
    );
    const implementation = readFileSync(
      new URL("./local-testbed.mjs", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(implementation, /唐诗村商品列表\.xlsx/);
    assert.match(implementation, /seedThroughSupportedApis/);
    assert.match(implementation, /\/auth\/login/);
    assert.match(implementation, /\/machines\/\$\{machine\.id\}\/claim-codes/);
  });
});
