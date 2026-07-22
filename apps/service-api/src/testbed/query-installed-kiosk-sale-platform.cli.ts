#!/usr/bin/env node

import {
  and,
  DrizzleDB,
  eq,
  inArray,
  inventories,
  inventoryReservations,
  machineRawStockMovements,
  machines,
  orders,
  orderItems,
  paymentCodeAttempts,
  paymentReconciliationAttempts,
  payments,
  sql,
  vendingCommands,
} from "@vem/db";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "installed-kiosk-sale-platform-raw-records/v3";
export const INSTALLED_KIOSK_SALE_DATABASE_URL_ENV =
  "VEM_INSTALLED_KIOSK_SALE_DATABASE_URL";

// This is deliberately machine-scoped. Expected UI identities are compared only
// after the baseline delta is calculated by the acceptance runner.
export const installedKioskSalePlatformQueryScope = Object.freeze({
  orders: "machine_id",
  orderItems: "enumerated_order_ids",
  payments: "enumerated_order_ids",
  paymentCodeAttempts: "enumerated_order_ids",
  paymentReconciliationAttempts: "enumerated_payment_ids",
  reservations: "enumerated_order_ids",
  commands: "enumerated_order_ids",
  movements: "machine_id + dispense_succeeded",
  inventories: "machine_id",
});

export type InstalledKioskSalePlatformQueryOptions = {
  databaseUrl: string;
  runId: string;
  machineCode: string;
  outputPath?: string;
};

type PlatformRawRecords = {
  orders: Array<{
    id: string;
    orderNo: string;
    machineId: string;
    status: string;
    paymentState: string;
    fulfillmentState: string;
  }>;
  orderItems: Array<{
    id: string;
    orderId: string;
    inventoryId: string;
    slotId: string;
    quantity: number;
    fulfillmentStatus: string;
  }>;
  payments: Array<{
    id: string;
    orderId: string;
    paymentNo: string;
    status: string;
  }>;
  paymentCodeAttempts: Array<{
    id: string;
    orderId: string;
    paymentId: string;
    attemptNo: number;
    idempotencyKey: string;
    status: string;
    isActive: boolean;
    source: string | null;
    scannerEventId: string | null;
  }>;
  paymentReconciliationAttempts: Array<{
    id: string;
    paymentId: string;
    trigger: string;
    status: string;
    providerPaymentStatus: string | null;
    errorCode: string | null;
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
    slotId: string;
    commandKind: string;
    status: string;
  }>;
  movements: Array<{
    id: string;
    movementId: string;
    machineId: string;
    movementType: string;
    quantity: number;
    status: string;
    slotId: string;
    orderNo: string | null;
    orderItemId: string | null;
    inventoryId: string | null;
    commandNo: string | null;
  }>;
  inventories: Array<{
    id: string;
    machineId: string;
    slotId: string;
    onHandQty: number;
    reservedQty: number;
  }>;
};

export type InstalledKioskSalePlatformRawReport = {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "authoritative_ephemeral_platform_database";
  capturedAt: string;
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
  env: NodeJS.ProcessEnv = process.env,
): InstalledKioskSalePlatformQueryOptions {
  const databaseUrl = env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV]?.trim();
  if (!databaseUrl) {
    throw new Error(`${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} is required`);
  }
  try {
    const url = new URL(databaseUrl);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
      throw new Error();
    }
  } catch {
    throw new Error(
      `${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} must be a PostgreSQL URL`,
    );
  }
  const outputPath = args.includes("--out") ? required(args, "out") : undefined;
  return {
    databaseUrl,
    runId: required(args, "run-id"),
    machineCode: required(args, "machine-code"),
    outputPath,
  };
}

export function buildInstalledKioskSalePlatformRawReport({
  options,
  machineId,
  raw,
  capturedAt,
}: {
  options: InstalledKioskSalePlatformQueryOptions;
  machineId: string | null;
  raw: PlatformRawRecords;
  capturedAt: string;
}): InstalledKioskSalePlatformRawReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "authoritative_ephemeral_platform_database",
    capturedAt,
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
    return await database.client.transaction(
      async (client) => {
        const capturedAtResult = await client.execute(
          sql<{
            capturedAt: string;
          }>`select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "capturedAt"`,
        );
        const capturedAt = capturedAtResult.rows[0]?.capturedAt;
        if (typeof capturedAt !== "string" || !capturedAt)
          throw new Error("platform database timestamp is missing");
        const [machine] = await client
          .select({ id: machines.id })
          .from(machines)
          .where(eq(machines.code, options.machineCode));
        if (!machine) {
          return buildInstalledKioskSalePlatformRawReport({
            options,
            machineId: null,
            capturedAt,
            raw: {
              orders: [],
              orderItems: [],
              payments: [],
              paymentCodeAttempts: [],
              paymentReconciliationAttempts: [],
              reservations: [],
              commands: [],
              movements: [],
              inventories: [],
            },
          });
        }

        const orderRows = await client
          .select({
            id: orders.id,
            orderNo: orders.orderNo,
            machineId: orders.machineId,
            status: orders.status,
            paymentState: orders.paymentState,
            fulfillmentState: orders.fulfillmentState,
          })
          .from(orders)
          .where(eq(orders.machineId, machine.id));
        const orderIds = orderRows.map((row) => row.id);
        const emptyRaw = {
          orderItems: [],
          payments: [],
          paymentCodeAttempts: [],
          paymentReconciliationAttempts: [],
          reservations: [],
          commands: [],
        };
        const related =
          orderIds.length === 0
            ? emptyRaw
            : await Promise.all([
                client
                  .select({
                    id: orderItems.id,
                    orderId: orderItems.orderId,
                    inventoryId: orderItems.inventoryId,
                    slotId: orderItems.slotId,
                    quantity: orderItems.quantity,
                    fulfillmentStatus: orderItems.fulfillmentStatus,
                  })
                  .from(orderItems)
                  .where(inArray(orderItems.orderId, orderIds)),
                client
                  .select({
                    id: payments.id,
                    orderId: payments.orderId,
                    paymentNo: payments.paymentNo,
                    status: payments.status,
                  })
                  .from(payments)
                  .where(inArray(payments.orderId, orderIds)),
                client
                  .select({
                    id: paymentCodeAttempts.id,
                    orderId: paymentCodeAttempts.orderId,
                    paymentId: paymentCodeAttempts.paymentId,
                    attemptNo: paymentCodeAttempts.attemptNo,
                    idempotencyKey: paymentCodeAttempts.idempotencyKey,
                    status: paymentCodeAttempts.status,
                    isActive: paymentCodeAttempts.isActive,
                    source: paymentCodeAttempts.source,
                    scannerEventId: sql<
                      string | null
                    >`${paymentCodeAttempts.scannerHealthJson}->>'scannerEventId'`,
                  })
                  .from(paymentCodeAttempts)
                  .where(inArray(paymentCodeAttempts.orderId, orderIds)),
                client
                  .select({
                    id: inventoryReservations.id,
                    orderId: inventoryReservations.orderId,
                    orderItemId: inventoryReservations.orderItemId,
                    inventoryId: inventoryReservations.inventoryId,
                    quantity: inventoryReservations.quantity,
                    status: inventoryReservations.status,
                  })
                  .from(inventoryReservations)
                  .where(inArray(inventoryReservations.orderId, orderIds)),
                client
                  .select({
                    id: vendingCommands.id,
                    commandNo: vendingCommands.commandNo,
                    orderId: vendingCommands.orderId,
                    machineId: vendingCommands.machineId,
                    orderItemId: vendingCommands.orderItemId,
                    slotId: vendingCommands.slotId,
                    commandKind: vendingCommands.commandKind,
                    status: vendingCommands.status,
                  })
                  .from(vendingCommands)
                  .where(
                    and(
                      eq(vendingCommands.machineId, machine.id),
                      inArray(vendingCommands.orderId, orderIds),
                    ),
                  ),
              ]);
        const [
          orderItemRows,
          paymentRows,
          paymentCodeAttemptRows,
          reservationRows,
          commandRows,
        ] = Array.isArray(related)
          ? related
          : [
              related.orderItems,
              related.payments,
              related.paymentCodeAttempts,
              related.reservations,
              related.commands,
            ];
        const movementRows = await client
          .select({
            id: machineRawStockMovements.id,
            movementId: machineRawStockMovements.movementId,
            machineId: machineRawStockMovements.machineId,
            movementType: machineRawStockMovements.movementType,
            quantity: machineRawStockMovements.quantity,
            status: machineRawStockMovements.status,
            slotId: machineRawStockMovements.slotId,
            orderNo: sql<
              string | null
            >`${machineRawStockMovements.payloadJson}->'orderContext'->>'orderNo'`,
            orderItemId: sql<
              string | null
            >`${machineRawStockMovements.payloadJson}->'orderContext'->>'orderItemId'`,
            inventoryId: sql<
              string | null
            >`${machineRawStockMovements.payloadJson}->'orderContext'->>'inventoryId'`,
            commandNo: sql<
              string | null
            >`${machineRawStockMovements.payloadJson}->'orderContext'->>'vendingCommandNo'`,
          })
          .from(machineRawStockMovements)
          .where(
            and(
              eq(machineRawStockMovements.machineId, machine.id),
              eq(machineRawStockMovements.movementType, "dispense_succeeded"),
            ),
          );
        const inventoryRows = await client
          .select({
            id: inventories.id,
            machineId: inventories.machineId,
            slotId: inventories.slotId,
            onHandQty: inventories.onHandQty,
            reservedQty: inventories.reservedQty,
          })
          .from(inventories)
          .where(eq(inventories.machineId, machine.id));
        const paymentIds = paymentRows.map((row) => row.id);
        const reconciliationAttemptRows =
          paymentIds.length === 0
            ? []
            : await client
                .select({
                  id: paymentReconciliationAttempts.id,
                  paymentId: paymentReconciliationAttempts.paymentId,
                  trigger: paymentReconciliationAttempts.trigger,
                  status: paymentReconciliationAttempts.status,
                  providerPaymentStatus:
                    paymentReconciliationAttempts.providerPaymentStatus,
                  errorCode: paymentReconciliationAttempts.errorCode,
                })
                .from(paymentReconciliationAttempts)
                .where(
                  inArray(paymentReconciliationAttempts.paymentId, paymentIds),
                );

        return buildInstalledKioskSalePlatformRawReport({
          options,
          machineId: machine.id,
          capturedAt,
          raw: {
            orders: orderRows,
            orderItems: orderItemRows,
            payments: paymentRows,
            paymentCodeAttempts: paymentCodeAttemptRows,
            paymentReconciliationAttempts: reconciliationAttemptRows,
            reservations: reservationRows,
            commands: commandRows,
            movements: movementRows,
            inventories: inventoryRows,
          },
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
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
