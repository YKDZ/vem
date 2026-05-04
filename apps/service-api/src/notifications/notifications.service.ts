import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  count,
  desc,
  eq,
  notifications,
  type DrizzleClient,
  type DrizzleTransaction,
} from "@vem/db";
import { pageQuerySchema } from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type PageQueryInput = z.infer<typeof pageQuerySchema>;

@Injectable()
export class NotificationsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async createLowStockNotification(
    tx: DrizzleTransaction,
    input: { machineId: string; slotId: string; availableQty: number },
  ): Promise<void> {
    await tx
      .insert(notifications)
      .values({
        type: input.availableQty === 0 ? "sold_out" : "low_stock",
        title: input.availableQty === 0 ? "商品售罄" : "库存不足",
        content: `机器 ${input.machineId} 格口 ${input.slotId} 当前可售库存 ${input.availableQty}`,
        severity: input.availableQty === 0 ? "critical" : "warning",
        resourceType: "machine_slot",
        resourceId: input.slotId,
        dedupeKey: `low_stock:${input.machineId}:${input.slotId}`,
      })
      .onConflictDoNothing({ target: notifications.dedupeKey });
  }

  async createDispenseFailedNotification(
    tx: DrizzleTransaction,
    input: { orderId: string; commandId: string; message: string },
  ): Promise<void> {
    await tx
      .insert(notifications)
      .values({
        type: "dispense_failed",
        title: "出货失败",
        content: input.message,
        severity: "critical",
        resourceType: "order",
        resourceId: input.orderId,
        dedupeKey: `dispense_failed:${input.commandId}`,
      })
      .onConflictDoNothing({ target: notifications.dedupeKey });
  }

  async list(query: PageQueryInput) {
    const items = await this.db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(notifications);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async markRead(id: string) {
    const [updated] = await this.db
      .update(notifications)
      .set({ status: "read", updatedAt: new Date() })
      .where(eq(notifications.id, id))
      .returning();
    if (!updated) {
      throw new NotFoundException("Notification not found");
    }
    return updated;
  }
}
