import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  buildInstalledKioskSalePlatformRawReport,
  INSTALLED_KIOSK_SALE_DATABASE_URL_ENV,
  installedKioskSalePlatformQueryScope,
  parseInstalledKioskSalePlatformQueryArgs,
} from "./query-installed-kiosk-sale-platform.cli";

const args = [
  "--run-id",
  "RUN-204",
  "--machine-code",
  "VEM-TESTBED-FACTORY-RUN-204",
];
const databaseUrl =
  "postgresql://vem:runner-only@127.0.0.1:55433/vem_factory_acceptance";

describe("installed kiosk sale platform raw query", () => {
  it("requires a PostgreSQL runner-local connection URL from its private environment", () => {
    expect(() =>
      parseInstalledKioskSalePlatformQueryArgs(args, {
        [INSTALLED_KIOSK_SALE_DATABASE_URL_ENV]:
          "https://platform.example.test",
      }),
    ).toThrow(
      `${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} must be a PostgreSQL URL`,
    );
    expect(() => parseInstalledKioskSalePlatformQueryArgs(args, {})).toThrow(
      `${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} is required`,
    );
  });

  it("emits raw records and scopes without persisting the database URL", () => {
    const options = parseInstalledKioskSalePlatformQueryArgs(args, {
      [INSTALLED_KIOSK_SALE_DATABASE_URL_ENV]: databaseUrl,
    });
    const report = buildInstalledKioskSalePlatformRawReport({
      options,
      machineId: "machine-204",
      capturedAt: "2026-07-18T08:00:00.000Z",
      raw: {
        orders: [],
        orderItems: [],
        payments: [],
        paymentCodeAttempts: [],
        reservations: [],
        commands: [],
        movements: [],
        inventories: [],
      },
    });

    expect(report).toEqual({
      schemaVersion: "installed-kiosk-sale-platform-raw-records/v3",
      source: "authoritative_ephemeral_platform_database",
      capturedAt: "2026-07-18T08:00:00.000Z",
      scope: {
        runId: "RUN-204",
        machineCode: "VEM-TESTBED-FACTORY-RUN-204",
        machineId: "machine-204",
      },
      raw: {
        orders: [],
        orderItems: [],
        payments: [],
        paymentCodeAttempts: [],
        reservations: [],
        commands: [],
        movements: [],
        inventories: [],
      },
    });
    expect(JSON.stringify(report)).not.toContain("runner-only@127.0.0.1");
  });

  it("declares a machine-scoped query contract rather than expected-primary-key filters", async () => {
    expect(installedKioskSalePlatformQueryScope).toEqual({
      orders: "machine_id",
      orderItems: "enumerated_order_ids",
      payments: "enumerated_order_ids",
      paymentCodeAttempts: "enumerated_order_ids",
      reservations: "enumerated_order_ids",
      commands: "enumerated_order_ids",
      movements: "machine_id + dispense_succeeded",
      inventories: "machine_id",
    });
    const source = await readFile(
      new URL("./query-installed-kiosk-sale-platform.cli.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(".where(eq(orders.machineId, machine.id))");
    expect(source).toContain("inArray(payments.orderId, orderIds)");
    expect(source).toContain("inArray(paymentCodeAttempts.orderId, orderIds)");
    expect(source).toContain(
      "inArray(inventoryReservations.orderId, orderIds)",
    );
    expect(source).toContain("inArray(vendingCommands.orderId, orderIds)");
    expect(source).toContain(
      'eq(machineRawStockMovements.movementType, "dispense_succeeded")',
    );
    expect(source).toContain("database.client.transaction");
    expect(source).toContain('isolationLevel: "repeatable read"');
    expect(source).toContain("transaction_timestamp()");
    expect(source).not.toMatch(
      /options\.(?:orderId|paymentId|orderNo|commandId|movementId)/,
    );
  });
});
