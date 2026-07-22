import { NotFoundException } from "@nestjs/common";
import {
  inventories,
  machines,
  orders,
  sql,
  type DrizzleTransaction,
} from "@vem/db";

/** Serializes machine-local command and planogram mutations in one database transaction. */
export async function lockMachineForVendingMutation(
  tx: DrizzleTransaction,
  machineId: string,
): Promise<void> {
  const locked = await tx.execute(sql`
    select id
    from ${machines}
    where id = ${machineId}
    for update
  `);
  if ((locked.rowCount ?? 0) !== 1) {
    throw new NotFoundException("Machine not found");
  }
}

export async function lockOrderForVendingMutation(
  tx: DrizzleTransaction,
  orderId: string,
): Promise<void> {
  const locked = await tx.execute(sql`
    select id
    from ${orders}
    where id = ${orderId}
    for update
  `);
  if ((locked.rowCount ?? 0) !== 1) {
    throw new NotFoundException("Order not found");
  }
}

export async function lockInventoriesForVendingMutation(
  tx: DrizzleTransaction,
  inventoryIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(inventoryIds)].sort();
  if (ids.length === 0) return;
  const locked = await tx.execute(sql`
    select id
    from ${inventories}
    where id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    order by id
    for update
  `);
  if ((locked.rowCount ?? 0) !== ids.length) {
    throw new NotFoundException("Inventory not found");
  }
}
