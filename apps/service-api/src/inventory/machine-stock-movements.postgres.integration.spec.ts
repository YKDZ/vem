import {
  DrizzleDB,
  inventories,
  inventoryReservations,
  machinePlanogramSlots,
  machinePlanogramVersions,
  machineSlots,
  machines,
  orderItems,
  orders,
  productVariants,
  products,
  vendingCommands,
} from "@vem/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MachineStockMovementsRepository } from "./machine-stock-movements.repository";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

postgresDescribe("machine stock movement PostgreSQL identity binding", () => {
  let database: DrizzleDB;

  beforeAll(async () => {
    database = new DrizzleDB(databaseUrl);
    await database.connect();
  });

  afterAll(async () => {
    await database?.disconnect();
  });

  it("accepts an order-bound dispense despite divergent display labels", async () => {
    const suffix = randomUUID();
    const machineId = randomUUID();
    const productId = randomUUID();
    const variantId = randomUUID();
    const slotId = randomUUID();
    const inventoryId = randomUUID();
    const planogramId = randomUUID();
    const orderId = randomUUID();
    const orderItemId = randomUUID();
    const commandId = randomUUID();
    const orderNo = `ORD-PG-MOVEMENT-${suffix}`;
    const commandNo = `CMD-PG-MOVEMENT-${suffix}`;

    await database.client.insert(machines).values({
      id: machineId,
      code: `PG-MOVEMENT-${suffix}`,
      name: "Movement identity regression",
      status: "online",
    });
    await database.client.insert(products).values({
      id: productId,
      name: "Movement product",
      status: "active",
    });
    await database.client.insert(productVariants).values({
      id: variantId,
      productId,
      sku: `PG-MOVEMENT-SKU-${suffix}`,
      priceCents: 100,
      status: "active",
    });
    await database.client.insert(machineSlots).values({
      id: slotId,
      machineId,
      rowNo: 1,
      cellNo: 1,
      capacity: 8,
      status: "enabled",
    });
    await database.client.insert(inventories).values({
      id: inventoryId,
      machineId,
      slotId,
      variantId,
      onHandQty: 3,
      reservedQty: 1,
    });
    await database.client.insert(machinePlanogramVersions).values({
      id: planogramId,
      machineId,
      planogramVersion: "PG-MOVEMENT-V1",
      status: "active",
      acknowledgedAt: new Date(),
      activeAt: new Date(),
    });
    await database.client.insert(machinePlanogramSlots).values({
      id: randomUUID(),
      machinePlanogramVersionId: planogramId,
      slotId,
      rowNo: 1,
      cellNo: 1,
      capacity: 8,
      parLevel: 1,
      inventoryId,
      variantId,
      productId,
      productName: "Movement product",
      sku: `PG-MOVEMENT-SKU-${suffix}`,
      priceCents: 100,
      productSortOrder: 1,
    });
    await database.client.insert(orders).values({
      id: orderId,
      orderNo,
      machineId,
      totalAmountCents: 100,
    });
    await database.client.insert(orderItems).values({
      id: orderItemId,
      orderId,
      inventoryId,
      slotId,
      variantId,
      quantity: 1,
      unitPriceCents: 100,
      productSnapshot: {
        planogramVersion: "PG-MOVEMENT-V1",
        slotId,
        inventoryId,
        variantId,
        productId,
        slotDisplayLabel: "R1C1",
        vendingCommandQuantity: 1,
      },
    });
    await database.client.insert(inventoryReservations).values({
      orderId,
      orderItemId,
      inventoryId,
      quantity: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await database.client.insert(vendingCommands).values({
      id: commandId,
      commandNo,
      orderId,
      orderItemId,
      machineId,
      slotId,
      payloadJson: { quantity: 1, slot: { slotDisplayLabel: "renamed-label" } },
    });

    const repository = new MachineStockMovementsRepository(
      database.client,
      {} as never,
    );
    const context = await repository.getOrderBoundDispenseConfirmationContext(
      machineId,
      {
        movementId: `MOVE-PG-${suffix}`,
        planogramVersion: "PG-MOVEMENT-V1",
        slotId,
        movementType: "dispense_succeeded",
        quantity: 1,
        source: "sale",
        occurredAt: new Date().toISOString(),
        orderContext: {
          orderNo,
          orderItemId,
          inventoryId,
          vendingCommandNo: commandNo,
        },
      },
    );

    expect(context).toEqual({
      orderId,
      orderItemId,
      inventoryId,
      quantity: 1,
      vendingCommandId: commandId,
    });
  });
});
