import {
  DrizzleDB,
  eq,
  inventoryReservations,
  mockPaymentCodeTrades,
  orders,
  paymentCodeAttempts,
  payments,
} from "@vem/db";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupBusinessTables,
  getMachineAuthHeader,
  machineOrderBody,
  seedSingleSlotInventory,
  type ApiResponse,
  type CreatedOrderPayload,
} from "./flow-test-helpers";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;
const execFile = promisify(execFileCallback);

type ServiceProcess = {
  child: ChildProcess;
  baseUrl: string;
  output: () => string;
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate Service API port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<T> => {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return await poll();
  };
  return await poll();
}

async function startService(responseDelayMs: number): Promise<ServiceProcess> {
  const port = await freePort();
  let logs = "";
  const child = spawn("pnpm", ["run", "start"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl!,
      SERVICE_HOST: "127.0.0.1",
      SERVICE_PORT: String(port),
      JWT_SECRET: "payment-code-restart-jwt-secret-0000000000000001",
      JWT_REFRESH_SECRET: "payment-code-restart-refresh-secret-000000000000001",
      MACHINE_JWT_SECRET: "payment-code-restart-machine-jwt-secret-00000000001",
      MACHINE_CREDENTIAL_ENCRYPTION_KEY:
        "payment-code-restart-machine-credential-key-00001",
      MQTT_URL: "mqtt://127.0.0.1:9",
      MACHINE_MQTT_URL: "mqtt://127.0.0.1:9",
      MACHINE_PROVISIONING_PROFILE: "testbed",
      MAINTENANCE_RELAY_PEER_ID: "550e8400-e29b-41d4-a716-446655440010",
      MAINTENANCE_RELAY_ENDPOINT: "127.0.0.1:51820",
      MAINTENANCE_RELAY_PUBLIC_KEY:
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      MAINTENANCE_RELAY_TUNNEL_ADDRESS: "10.91.0.1",
      PAYMENT_MOCK_ENABLED: "true",
      PAYMENT_MOCK_PROVIDER_RESPONSE_DELAY_MS: String(responseDelayMs),
      PAYMENT_WEBHOOK_BASE_URL: `http://127.0.0.1:${port}/api/payments/webhooks`,
      MACHINE_API_BASE_URL: `http://127.0.0.1:${port}/api`,
      PAYMENT_RECONCILE_INTERVAL_SECONDS: "30",
      BOOTSTRAP_ADMIN_PASSWORD:
        "payment-code-restart-admin-password-0000000001",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer) => {
    logs = `${logs}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitFor(async () => {
      if (child.exitCode !== null) {
        throw new Error(`Service API exited during startup:\n${logs}`);
      }
      try {
        await fetch(`${baseUrl}/api`);
        return true;
      } catch {
        return null;
      }
    });
  } catch (error) {
    await stopService({ child, baseUrl, output: () => logs });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nService API output:\n${logs}`,
      { cause: error },
    );
  }
  return { child, baseUrl, output: () => logs };
}

async function stopService(service: ServiceProcess): Promise<void> {
  if (service.child.exitCode !== null || service.child.signalCode !== null)
    return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    service.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      if (service.child.pid) process.kill(-service.child.pid, "SIGKILL");
      else service.child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      clearTimeout(timeout);
      resolve();
    }
  });
}

postgresDescribe(
  "payment-code Service API process restart",
  { concurrent: false },
  () => {
    let db: DrizzleDB;
    const services: ServiceProcess[] = [];

    beforeAll(async () => {
      await execFile("pnpm", ["--filter", "@vem/db", "build"], {
        cwd: resolve(process.cwd(), "../.."),
        timeout: 30_000,
      });
      db = new DrizzleDB(databaseUrl);
      await db.connect();
      await cleanupBusinessTables(db);
    });

    afterAll(async () => {
      await Promise.all(services.map(stopService));
      if (db) await db.disconnect();
    });

    it("recovers a provider-accepted charge after SIGKILL with a genuinely fresh provider process", async () => {
      const first = await startService(30_000);
      services.push(first);
      const seeded = await seedSingleSlotInventory(db, {
        machineCode: `M-PC-RESTART-${Date.now().toString(36)}`,
        onHandQty: 3,
        lowStockThreshold: 1,
        slotCode: "R1",
        layerNo: 1,
        cellNo: 1,
      });
      const firstApi = request(first.baseUrl);
      const machineAuth = await getMachineAuthHeader(
        firstApi,
        seeded.machineCode,
        seeded.machineSecret,
      );
      const orderResponse = await firstApi
        .post("/api/machine-orders")
        .set(machineAuth)
        .send({
          ...machineOrderBody(seeded, "payment_code"),
          paymentProviderCode: "mock",
        });
      expect(orderResponse.status).toBe(201);
      const order = (orderResponse.body as ApiResponse<CreatedOrderPayload>)
        .data;
      const submitBody = {
        machineCode: seeded.machineCode,
        authCode: "28763443825664394",
        idempotencyKey: `restart-accepted-${order.paymentNo}`,
        source: "serial_text",
        scannerHealth: { online: true, adapter: "restart-test" },
      };
      const lostResponse = firstApi
        .post(`/api/machine-orders/${order.orderNo}/payment-code/submit`)
        .set(machineAuth)
        .send(submitBody)
        .then(
          (response) => response,
          (error: unknown) => error,
        );

      const acceptedTrade = await waitFor(async () => {
        const [trade] = await db.client
          .select()
          .from(mockPaymentCodeTrades)
          .limit(1);
        return trade ?? null;
      });
      expect(acceptedTrade.chargeAcceptedCount).toBe(1);

      await stopService(first);
      const responseAfterKill = await lostResponse;
      expect(responseAfterKill).toBeInstanceOf(Error);

      const [afterKill] = await db.client
        .select({
          attemptStatus: paymentCodeAttempts.status,
          attemptActive: paymentCodeAttempts.isActive,
          paymentStatus: payments.status,
          orderStatus: orders.status,
          reservationStatus: inventoryReservations.status,
        })
        .from(paymentCodeAttempts)
        .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
        .innerJoin(orders, eq(orders.id, paymentCodeAttempts.orderId))
        .innerJoin(
          inventoryReservations,
          eq(inventoryReservations.orderId, orders.id),
        )
        .where(eq(orders.orderNo, order.orderNo));
      expect(afterKill).toEqual({
        attemptStatus: "submitting",
        attemptActive: true,
        paymentStatus: "pending",
        orderStatus: "pending_payment",
        reservationStatus: "active",
      });
      await db.client
        .update(paymentCodeAttempts)
        .set({
          recoveryLeaseExpiresAt: new Date(Date.now() - 1),
          recoveryNextAt: new Date(Date.now() - 1),
          updatedAt: new Date(),
        })
        .where(
          eq(
            paymentCodeAttempts.providerPaymentNo,
            acceptedTrade.providerPaymentNo,
          ),
        );

      const second = await startService(0);
      services.push(second);
      await waitFor(async () => {
        const [state] = await db.client
          .select({
            attemptStatus: paymentCodeAttempts.status,
            attemptActive: paymentCodeAttempts.isActive,
            paymentStatus: payments.status,
            orderStatus: orders.status,
          })
          .from(paymentCodeAttempts)
          .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
          .innerJoin(orders, eq(orders.id, paymentCodeAttempts.orderId))
          .where(eq(orders.orderNo, order.orderNo));
        return state?.attemptStatus === "succeeded" ? state : null;
      });

      const secondApi = request(second.baseUrl);
      const secondAuth = await getMachineAuthHeader(
        secondApi,
        seeded.machineCode,
        seeded.machineSecret,
      );
      const replay = await secondApi
        .post(`/api/machine-orders/${order.orderNo}/payment-code/submit`)
        .set(secondAuth)
        .send(submitBody);
      expect(replay.status).toBe(201);
      expect((replay.body as ApiResponse<{ status: string }>).data.status).toBe(
        "succeeded",
      );

      const [converged] = await db.client
        .select({
          attemptStatus: paymentCodeAttempts.status,
          attemptActive: paymentCodeAttempts.isActive,
          paymentStatus: payments.status,
          orderStatus: orders.status,
          reservationStatus: inventoryReservations.status,
          chargeAcceptedCount: mockPaymentCodeTrades.chargeAcceptedCount,
        })
        .from(paymentCodeAttempts)
        .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
        .innerJoin(orders, eq(orders.id, paymentCodeAttempts.orderId))
        .innerJoin(
          inventoryReservations,
          eq(inventoryReservations.orderId, orders.id),
        )
        .innerJoin(
          mockPaymentCodeTrades,
          eq(
            mockPaymentCodeTrades.providerPaymentNo,
            paymentCodeAttempts.providerPaymentNo,
          ),
        )
        .where(eq(orders.orderNo, order.orderNo));
      expect(converged).toEqual({
        attemptStatus: "succeeded",
        attemptActive: false,
        paymentStatus: "succeeded",
        orderStatus: "paid",
        reservationStatus: "active",
        chargeAcceptedCount: 1,
      });
    }, 90_000);
  },
);
