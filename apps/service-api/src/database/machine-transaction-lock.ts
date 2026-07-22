import { NotFoundException } from "@nestjs/common";
import { machines, sql, type DrizzleTransaction } from "@vem/db";

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
