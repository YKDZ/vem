#!/usr/bin/env node

import { and, DrizzleDB, eq, machines, orders, payments } from "@vem/db";
import { pathToFileURL } from "node:url";

import { INSTALLED_KIOSK_SALE_DATABASE_URL_ENV } from "./query-installed-kiosk-sale-platform.cli";

const TESTBED_MACHINE_CODE_PREFIX = "VEM-TESTBED-";
const MUTABLE_PAYMENT_STATUSES = new Set(["created", "pending", "processing"]);

export function isMutablePaymentExpiryInjectionStatus(status: string): boolean {
  return MUTABLE_PAYMENT_STATUSES.has(status);
}

export type InstalledKioskPaymentExpiryInjectionOptions = {
  databaseUrl: string;
  runId: string;
  machineCode: string;
  paymentId: string;
  expiresAt: Date;
};

function required(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required`);
  }
  return value.trim();
}

export function parseInstalledKioskPaymentExpiryInjectionArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): InstalledKioskPaymentExpiryInjectionOptions {
  const databaseUrl = env[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV]?.trim();
  if (!databaseUrl) {
    throw new Error(`${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} is required`);
  }
  try {
    const url = new URL(databaseUrl);
    if (!/^postgres(?:ql)?:$/.test(url.protocol)) throw new Error();
  } catch {
    throw new Error(
      `${INSTALLED_KIOSK_SALE_DATABASE_URL_ENV} must be a PostgreSQL URL`,
    );
  }
  const machineCode = required(args, "machine-code");
  if (!machineCode.startsWith(TESTBED_MACHINE_CODE_PREFIX)) {
    throw new Error("--machine-code must be a VEM-TESTBED-* identity");
  }
  const expiresAt = new Date(required(args, "expires-at"));
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("--expires-at must be an ISO timestamp");
  }
  return {
    databaseUrl,
    runId: required(args, "run-id"),
    machineCode,
    paymentId: required(args, "payment-id"),
    expiresAt,
  };
}

export async function injectInstalledKioskPaymentExpiry(
  options: InstalledKioskPaymentExpiryInjectionOptions,
) {
  const database = new DrizzleDB(options.databaseUrl);
  try {
    return await database.client.transaction(async (client) => {
      const [before] = await client
        .select({
          paymentId: payments.id,
          paymentNo: payments.paymentNo,
          paymentStatus: payments.status,
          orderId: orders.id,
          machineCode: machines.code,
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .innerJoin(machines, eq(machines.id, orders.machineId))
        .where(
          and(
            eq(payments.id, options.paymentId),
            eq(machines.code, options.machineCode),
          ),
        );
      if (!before) {
        throw new Error("testbed payment was not found for the machine");
      }
      if (!isMutablePaymentExpiryInjectionStatus(before.paymentStatus)) {
        throw new Error(
          `payment ${before.paymentId} is not mutable for expiry injection (${before.paymentStatus})`,
        );
      }
      const [after] = await client
        .update(payments)
        .set({ expiresAt: options.expiresAt, updatedAt: new Date() })
        .where(
          and(
            eq(payments.id, before.paymentId),
            eq(payments.status, before.paymentStatus),
          ),
        )
        .returning({ expiresAt: payments.expiresAt, status: payments.status });
      if (!after) {
        throw new Error("payment changed while applying expiry injection");
      }
      return {
        source: "testbed_payment_expiry_time_injection",
        runId: options.runId,
        machineCode: options.machineCode,
        paymentId: before.paymentId,
        paymentNo: before.paymentNo,
        orderId: before.orderId,
        beforePaymentStatus: before.paymentStatus,
        expiresAt: after.expiresAt?.toISOString() ?? null,
      };
    });
  } finally {
    await database.disconnect();
  }
}

async function main(): Promise<void> {
  const options = parseInstalledKioskPaymentExpiryInjectionArgs(
    process.argv.slice(2),
  );
  process.stdout.write(
    `${JSON.stringify(await injectInstalledKioskPaymentExpiry(options))}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().catch(() => {
    console.error("installed kiosk payment expiry injection failed");
    process.exitCode = 1;
  });
}
