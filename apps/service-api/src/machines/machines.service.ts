import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  inventories,
  isNull,
  machineSlots,
  machines,
  productVariants,
  products,
  sql,
  type DrizzleClient,
} from "@vem/db";
import {
  createMachineSchema,
  createMachineSlotSchema,
  pageQuerySchema,
  updateMachineSchema,
} from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type PageQueryInput = z.infer<typeof pageQuerySchema>;
type CreateMachineInput = z.infer<typeof createMachineSchema>;
type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
type CreateMachineSlotInput = z.infer<typeof createMachineSlotSchema>;

@Injectable()
export class MachinesService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async listMachines(query: PageQueryInput) {
    const items = await this.db
      .select()
      .from(machines)
      .where(isNull(machines.deletedAt))
      .orderBy(desc(machines.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(machines)
      .where(isNull(machines.deletedAt));

    return toPageResult(items, query, Number(totalRow.total));
  }

  async createMachine(input: CreateMachineInput) {
    const [created] = await this.db
      .insert(machines)
      .values({
        code: input.code,
        name: input.name,
        locationText: input.locationText ?? null,
        status: input.status,
        mqttClientId: input.mqttClientId ?? null,
      })
      .returning();
    return created;
  }

  async updateMachine(id: string, input: UpdateMachineInput) {
    const [updated] = await this.db
      .update(machines)
      .set({
        code: input.code,
        name: input.name,
        locationText: input.locationText,
        status: input.status,
        mqttClientId: input.mqttClientId,
        updatedAt: new Date(),
      })
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Machine not found");
    }
    return updated;
  }

  async listSlots(machineId: string) {
    return await this.db
      .select()
      .from(machineSlots)
      .where(
        and(
          eq(machineSlots.machineId, machineId),
          isNull(machineSlots.deletedAt),
        ),
      )
      .orderBy(machineSlots.layerNo, machineSlots.cellNo);
  }

  async createSlot(machineId: string, input: CreateMachineSlotInput) {
    const [created] = await this.db
      .insert(machineSlots)
      .values({
        machineId,
        layerNo: input.layerNo,
        cellNo: input.cellNo,
        slotCode: input.slotCode,
        capacity: input.capacity,
        status: input.status,
      })
      .returning();
    return created;
  }

  async getCatalogByMachineCode(code: string) {
    return await this.db
      .select({
        machineCode: machines.code,
        slotId: machineSlots.id,
        slotCode: machineSlots.slotCode,
        layerNo: machineSlots.layerNo,
        cellNo: machineSlots.cellNo,
        inventoryId: inventories.id,
        variantId: productVariants.id,
        productName: products.name,
        sku: productVariants.sku,
        size: productVariants.size,
        color: productVariants.color,
        priceCents: productVariants.priceCents,
        availableQty: sql<number>`${inventories.onHandQty} - ${inventories.reservedQty}`,
      })
      .from(machines)
      .innerJoin(
        machineSlots,
        and(
          eq(machineSlots.machineId, machines.id),
          isNull(machineSlots.deletedAt),
          eq(machineSlots.status, "enabled"),
        ),
      )
      .innerJoin(inventories, eq(inventories.slotId, machineSlots.id))
      .innerJoin(
        productVariants,
        and(
          eq(productVariants.id, inventories.variantId),
          isNull(productVariants.deletedAt),
          eq(productVariants.status, "active"),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.id, productVariants.productId),
          isNull(products.deletedAt),
          eq(products.status, "active"),
        ),
      )
      .where(
        and(
          eq(machines.code, code),
          isNull(machines.deletedAt),
          inArray(machines.status, ["online", "maintenance"]),
          sql`${inventories.onHandQty} - ${inventories.reservedQty} > 0`,
        ),
      )
      .orderBy(machineSlots.layerNo, machineSlots.cellNo);
  }
}
