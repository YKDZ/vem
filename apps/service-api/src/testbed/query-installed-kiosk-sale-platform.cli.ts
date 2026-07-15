#!/usr/bin/env node

import {
  and,
  DrizzleDB,
  eq,
  inventoryReservations,
  machineRawStockMovements,
  machines,
  orders,
  payments,
  sql,
  vendingCommands,
} from "@vem/db";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "installed-kiosk-sale-platform-raw-records/v1";

export type InstalledKioskSalePlatformQueryOptions = {
  databaseUrl: string;
  runId: string;
  machineCode: string;
  orderId: string;
  paymentId: string;
  orderNo: string;
  commandId: string;
  movementId: string;
  outputPath?: string;
};

type PlatformRawRecords = {
  orders: Array<{
    id: string;
    orderNo: string;
    machineId: string;
    status: string;
  }>;
  payments: Array<{
    id: string;
    orderId: string;
    paymentNo: string;
    status: string;
  }>;
  reservations: Array<{
    id: string;
    orderId: string;
    orderItemId: string | null;
    inventoryId: string;
    quantity: number;
    status: string;
  }>;
  commands: Array<{
    id: string;
    commandNo: string;
    orderId: string;
    machineId: string;
    orderItemId: string | null;
    status: string;
  }>;
  movements: Array<{
    id: string;
    movementId: string;
    machineId: string;
    movementType: string;
    quantity: number;
    status: string;
    orderNo: string | null;
    commandNo: string | null;
  }>;
};

export type InstalledKioskSalePlatformRawReport = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "authoritative_ephemeral_platform_database";
  scope: {
    runId: string;
    machineCode: string;
    machineId: string | null;
  };
  raw: PlatformRawRecords;
};

function required(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

export function parseInstalledKioskSalePlatformQueryArgs(
  args: string[],
): InstalledKioskSalePlatformQueryOptions {
  const databaseUrl = required(args, "database-url");
  try {
    const url = new URL(databaseUrl);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error("--database-url must be a PostgreSQL URL");
  }
  const outputPath = args.includes("--out") ? required(args, "out") : undefined;
  return {
    databaseUrl,
    runId: required(args, "run-id"),
    machineCode: required(args, "machine-code"),
    orderId: required(args, "order-id"),
    paymentId: required(args, "payment-id"),
    orderNo: required(args, "order-no"),
    commandId: required(args, "command-id"),
    movementId: required(args, "movement-id"),
    outputPath,
  };
}

export function buildInstalledKioskSalePlatformRawReport({
  options,
  machineId,
  raw,
}: {
  options: InstalledKioskSalePlatformQueryOptions;
  machineId: string | null;
  raw: PlatformRawRecords;
}): InstalledKioskSalePlatformRawReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "authoritative_ephemeral_platform_database",
    scope: {
      runId: options.runId,
      machineCode: options.machineCode,
      machineId,
    },
    raw,
  };
}

export async function queryInstalledKioskSalePlatform(
  options: InstalledKioskSalePlatformQueryOptions,
): Promise<InstalledKioskSalePlatformRawReport> {
  const database = new DrizzleDB(options.databaseUrl);
  try {
    const [machine] = await database.client
      .select({ id: machines.id })
      .from(machines)
      .where(eq(machines.code, options.machineCode));
    if (!machine) {
      return buildInstalledKioskSalePlatformRawReport({
        options,
        machineId: null,
        raw: {
          orders: [],
          payments: [],
          reservations: [],
          commands: [],
          movements: [],
        },
      });
    }

    const [orderRows, paymentRows, reservationRows, commandRows, movementRows] =
      await Promise.all([
        database.client
          .select({
            id: orders.id,
            orderNo: orders.orderNo,
            machineId: orders.machineId,
            status: orders.status,
          })
          .from(orders)
          .where(
            and(
              eq(orders.id, options.orderId),
              eq(orders.orderNo, options.orderNo),
              eq(orders.machineId, machine.id),
            ),
          ),
        database.client
          .select({
            id: payments.id,
            orderId: payments.orderId,
            paymentNo: payments.paymentNo,
            status: payments.status,
          })
          .from(payments)
          .where(
            and(
              eq(payments.id, options.paymentId),
              eq(payments.orderId, options.orderId),
            ),
          ),
        database.client
          .select({
            id: inventoryReservations.id,
            orderId: inventoryReservations.orderId,
            orderItemId: inventoryReservations.orderItemId,
            inventoryId: inventoryReservations.inventoryId,
            quantity: inventoryReservations.quantity,
            status: inventoryReservations.status,
          })
          .from(inventoryReservations)
          .where(eq(inventoryReservations.orderId, options.orderId)),
        database.client
          .select({
            id: vendingCommands.id,
            commandNo: vendingCommands.commandNo,
            orderId: vendingCommands.orderId,
            machineId: vendingCommands.machineId,
            orderItemId: vendingCommands.orderItemId,
            status: vendingCommands.status,
          })
          .from(vendingCommands)
          .where(
            and(
              eq(vendingCommands.id, options.commandId),
              eq(vendingCommands.orderId, options.orderId),
              eq(vendingCommands.machineId, machine.id),
            ),
          ),
        database.client
          .select({
            id: machineRawStockMovements.id,
            movementId: machineRawStockMovements.movementId,
            machineId: machineRawStockMovements.machineId,
            movementType: machineRawStockMovements.movementType,
            quantity: machineRawStockMovements.quantity,
            status: machineRawStockMovements.status,
            orderNo: sql<
              string | null
            >`${machineRawStockMovements.payloadJson}->'orderContext'->>'orderNo'`,
            commandNo: sql<
              string | null
            >`${machineRawStockMovements.payloadJson}->'orderContext'->>'vendingCommandNo'`,
          })
          .from(machineRawStockMovements)
          .where(
            and(
              eq(machineRawStockMovements.machineId, machine.id),
              eq(machineRawStockMovements.movementId, options.movementId),
            ),
          ),
      ]);

    return buildInstalledKioskSalePlatformRawReport({
      options,
      machineId: machine.id,
      raw: {
        orders: orderRows,
        payments: paymentRows,
        reservations: reservationRows,
        commands: commandRows,
        movements: movementRows,
      },
    });
  } finally {
    await database.disconnect();
  }
}

async function main(): Promise<void> {
  const options = parseInstalledKioskSalePlatformQueryArgs(
    process.argv.slice(2),
  );
  const report = await queryInstalledKioskSalePlatform(options);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    await writeFile(options.outputPath, serialized, { mode: 0o600 });
  }
  process.stdout.write(serialized);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch(() => {
    console.error("installed kiosk sale platform query failed");
    process.exitCode = 1;
  });
}
