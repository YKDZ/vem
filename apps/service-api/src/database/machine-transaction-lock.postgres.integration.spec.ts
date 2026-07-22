import { DrizzleDB, eq, machines } from "@vem/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lockMachineForVendingMutation } from "./machine-transaction-lock";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe("machine mutation domain PostgreSQL serialization", () => {
  let database: DrizzleDB;

  beforeAll(async () => {
    database = new DrizzleDB(databaseUrl);
    await database.connect();
  });

  afterAll(async () => {
    await database?.disconnect();
  });

  it("serializes a command admission and planogram activation for one machine", async () => {
    const machineId = "f4d7aa66-7f69-4da4-90f0-4d913b9c9d1e";
    await database.client.delete(machines).where(eq(machines.id, machineId));
    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-MACHINE-MUTATION-LOCK",
      name: "Machine mutation lock",
      status: "online",
    });

    let releaseAdmission: (() => void) | undefined;
    const admissionReleased = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let signalAdmissionLocked: (() => void) | undefined;
    const admissionLocked = new Promise<void>((resolve) => {
      signalAdmissionLocked = resolve;
    });
    let activationEntered = false;

    const admission = database.client.transaction(async (tx) => {
      await lockMachineForVendingMutation(tx, machineId);
      signalAdmissionLocked?.();
      await admissionReleased;
    });
    await admissionLocked;

    const activation = database.client.transaction(async (tx) => {
      await lockMachineForVendingMutation(tx, machineId);
      activationEntered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activationEntered).toBe(false);

    releaseAdmission?.();
    await Promise.all([admission, activation]);
    expect(activationEntered).toBe(true);

    await database.client.delete(machines).where(eq(machines.id, machineId));
  });
});
