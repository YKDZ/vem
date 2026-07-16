import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildInstalledKioskSaleAcceptancePlan,
  postMinusBaselinePlatformRaw,
  runInstalledKioskSaleAcceptanceCli,
} from "./installed-kiosk-sale-acceptance.mjs";

const INSTALLED_KIOSK_SALE_DATABASE_URL_ENV =
  "VEM_INSTALLED_KIOSK_SALE_DATABASE_URL";

describe("installed kiosk sale preflight", () => {
  it("rejects a missing database binding before creating runner secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-installed-kiosk-preflight-"));
    const previousRunnerTemp = process.env.RUNNER_TEMP;
    const previousDatabaseUrl =
      process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
    process.env.RUNNER_TEMP = root;
    delete process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
    try {
      await assert.rejects(
        runInstalledKioskSaleAcceptanceCli({}),
        /VEM_INSTALLED_KIOSK_SALE_DATABASE_URL is required/,
      );
      assert.deepEqual(readdirSync(root), []);
    } finally {
      if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousRunnerTemp;
      if (previousDatabaseUrl === undefined)
        delete process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
      else
        process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV] =
          previousDatabaseUrl;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers the normal kiosk task when temporary CDP launch fails without metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-installed-kiosk-recovery-"));
    const runtimeAcceptanceReport = join(root, "runtime-acceptance.json");
    const output = join(root, "installed-kiosk-sale.json");
    const previousDatabaseUrl =
      process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
    process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV] =
      "postgresql://testbed:password@127.0.0.1:5432/vem";
    writeFileSync(
      runtimeAcceptanceReport,
      `${JSON.stringify({
        ok: true,
        runtimeAcceptanceReport: {
          schemaVersion: "runtime-acceptance-report/v1",
          kioskRuntime: {
            sessionUser: "VEMKiosk",
            sessionId: 1,
            url: "http://tauri.localhost/#/catalog",
          },
        },
      })}\n`,
    );
    const remoteScripts = [];
    try {
      await assert.rejects(
        runInstalledKioskSaleAcceptanceCli(
          {
            run_id: "RUN-LAUNCH-FAILURE",
            machine_code: "VEM-TESTBED-WINVM-RUN-LAUNCH-FAILURE",
            platform_target: "ephemeral-run-launch-failure",
            ephemeral_platform_evidence: join(root, "platform.json"),
            runtime_acceptance_report: runtimeAcceptanceReport,
            remote: "YKDZ@win10.test",
            identity: join(root, "id"),
            certificate: join(root, "id-cert.pub"),
            adapter: "runner-service-adapter",
            target_identity: "vm-target://runtime-testbed",
            approved_runtime_base: "factory-cas://sha256/abc",
            profile: "vm-normal",
            out: output,
          },
          {
            runCommand() {},
            runRemote(_remote, script) {
              remoteScripts.push(script);
              if (remoteScripts.length === 1) {
                throw new Error(
                  "temporary CDP launch terminated before metadata",
                );
              }
              return {
                ok: true,
                recovery: "launch_failure_normal_task_restart",
                normalTask: "VEMMachineUI",
                cdpListenerCount: 0,
                normal: {
                  processId: 4242,
                  principal: "VEM\\VEMKiosk",
                  sessionId: 1,
                  machineCount: 1,
                },
              };
            },
          },
        ),
        /temporary CDP launch terminated before metadata/,
      );
      assert.equal(remoteScripts.length, 2);
      assert.match(
        remoteScripts[1],
        /Start-ScheduledTask -TaskName \$normalTask/,
      );
      assert.match(remoteScripts[1], /\$normalTask = 'VEMMachineUI'/);
      assert.match(
        remoteScripts[1],
        /launch failure cleanup retained a CDP owner/,
      );
      assert.match(
        remoteScripts[1],
        /launch failure cleanup retained a detached machine\.exe/,
      );
      assert.match(remoteScripts[1], /\$machines\.Count -eq 1/);
    } finally {
      if (previousDatabaseUrl === undefined)
        delete process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
      else
        process.env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV] =
          previousDatabaseUrl;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function rawRecord(id, extras = {}) {
  return { id, ...extras };
}

function snapshot({ includeSecondOrder = false } = {}) {
  const records = {
    orders: [rawRecord("historical-order", { orderNo: "H-1" })],
    orderItems: [rawRecord("historical-item", { orderId: "historical-order" })],
    payments: [
      rawRecord("historical-payment", { orderId: "historical-order" }),
    ],
    reservations: [
      rawRecord("historical-reservation", { orderId: "historical-order" }),
    ],
    commands: [
      rawRecord("historical-command", { orderId: "historical-order" }),
    ],
    movements: [rawRecord("historical-movement")],
  };
  if (includeSecondOrder) {
    for (const [name, id] of [
      ["orders", "new-order-a"],
      ["orderItems", "new-item-a"],
      ["payments", "new-payment-a"],
      ["reservations", "new-reservation-a"],
      ["commands", "new-command-a"],
      ["movements", "new-movement-a"],
      ["orders", "new-order-b"],
      ["orderItems", "new-item-b"],
      ["payments", "new-payment-b"],
      ["reservations", "new-reservation-b"],
      ["commands", "new-command-b"],
      ["movements", "new-movement-b"],
    ]) {
      records[name].push(rawRecord(id));
    }
  }
  return {
    schemaVersion: "installed-kiosk-sale-platform-raw-records/v2",
    source: "authoritative_ephemeral_platform_database",
    scope: {
      runId: "RUN-DELTA",
      machineCode: "VEM-TESTBED-WINVM-RUN-DELTA",
      machineId: "machine-delta",
    },
    raw: records,
  };
}

describe("installed kiosk sale authoritative platform snapshots", () => {
  it("retains same-machine history yet exposes a second post-baseline order", () => {
    const delta = postMinusBaselinePlatformRaw({
      baseline: snapshot(),
      post: snapshot({ includeSecondOrder: true }),
    });

    assert.deepEqual(
      delta.raw.orders.map((record) => record.id),
      ["new-order-a", "new-order-b"],
    );
    for (const name of [
      "orderItems",
      "payments",
      "reservations",
      "commands",
      "movements",
    ]) {
      assert.equal(
        delta.raw[name].length,
        2,
        `${name} must retain both new records`,
      );
    }
  });

  it("keeps the database URL out of its persisted acceptance plan", () => {
    const plan = buildInstalledKioskSaleAcceptancePlan({
      run_id: "RUN-PLAN",
      machine_code: "VEM-TESTBED-WINVM-RUN-PLAN",
      platform_target: "ephemeral-run-plan",
      ephemeral_platform_evidence: "/tmp/ephemeral-platform.json",
      runtime_acceptance_report: "/tmp/runtime.json",
      remote: "YKDZ@win10.test",
      identity: "/tmp/id",
      certificate: "/tmp/id-cert.pub",
      adapter: "runner-service-adapter",
      target_identity: "vm-target://runtime-testbed",
      approved_runtime_base: "factory-cas://sha256/abc",
      profile: "vm-normal",
      out: "/tmp/installed-kiosk-sale-report.json",
    });

    assert.equal(JSON.stringify(plan).includes("postgresql://"), false);
    assert.equal(
      JSON.stringify(plan).includes("--ephemeral-database-url"),
      false,
    );
  });
});
