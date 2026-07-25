import { inventoryMovements, sql, type DrizzleClient } from "@vem/db";

export async function releaseExpiredInventoryReservations(
  db: Pick<DrizzleClient, "execute">,
  now = new Date(),
): Promise<{ releasedCount: number }> {
  const result = await db.execute(sql`
    with expired_reservations as (
      update inventory_reservations
      set status = 'released', updated_at = now()
      where status = 'active'
        and expires_at <= ${now}
      returning id, inventory_id, order_id, quantity
    ),
    released_by_inventory as (
      select inventory_id, sum(quantity)::integer as quantity
      from expired_reservations
      group by inventory_id
    ),
    updated_inventories as (
      update inventories
      set
        reserved_qty = greatest(0, reserved_qty - released_by_inventory.quantity),
        updated_at = now()
      from released_by_inventory
      where inventories.id = released_by_inventory.inventory_id
      returning inventories.id
    )
    insert into ${inventoryMovements} (
      inventory_id,
      delta_qty,
      reason,
      order_id,
      note
    )
    select
      inventory_id,
      0,
      'reservation_released',
      order_id,
      'payment_expired'
    from expired_reservations
    returning id
  `);

  return { releasedCount: result.rowCount ?? 0 };
}
