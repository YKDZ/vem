import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  count,
  desc,
  eq,
  and,
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

  async createMachineOfflineNotification(
    tx: DrizzleTransaction,
    input: {
      machineId: string;
      machineCode: string;
      lastSeenAt: Date | null;
      timeoutSeconds: number;
      detectedAt: Date;
    },
  ): Promise<void> {
    const lastSeenText = input.lastSeenAt
      ? input.lastSeenAt.toISOString()
      : "never";
    const content = `机器 ${input.machineCode} 心跳超时：最后心跳 ${lastSeenText}，超时阈值 ${input.timeoutSeconds} 秒`;
    await tx
      .insert(notifications)
      .values({
        type: "machine_offline",
        title: "机器心跳超时",
        content,
        severity: "critical",
        resourceType: "machine",
        resourceId: input.machineId,
        status: "unread",
        dedupeKey: `machine_offline_timeout:${input.machineId}`,
        updatedAt: input.detectedAt,
      })
      .onConflictDoUpdate({
        target: notifications.dedupeKey,
        set: {
          title: "机器心跳超时",
          content,
          severity: "critical",
          status: "unread",
          updatedAt: input.detectedAt,
        },
      });
  }

  async resolveMachineOfflineNotification(
    tx: DrizzleTransaction,
    input: {
      machineId: string;
      machineCode: string;
      recoveredAt: Date;
      lastSeenAt: Date;
    },
  ): Promise<void> {
    await tx
      .update(notifications)
      .set({
        title: "机器心跳已恢复",
        content: `机器 ${input.machineCode} 心跳已恢复：服务端最后接收时间 ${input.lastSeenAt.toISOString()}`,
        severity: "info",
        status: "archived",
        updatedAt: input.recoveredAt,
      })
      .where(
        and(
          eq(notifications.type, "machine_offline"),
          eq(
            notifications.dedupeKey,
            `machine_offline_timeout:${input.machineId}`,
          ),
        ),
      );
  }

  async createOperationalNotification(
    tx: DrizzleTransaction,
    input: {
      type: (typeof notifications.$inferInsert)["type"];
      title: string;
      content: string;
      severity: (typeof notifications.$inferInsert)["severity"];
      resourceType: string;
      resourceId?: string | null;
      dedupeKey: string;
    },
  ): Promise<void> {
    await tx
      .insert(notifications)
      .values({
        type: input.type,
        title: input.title,
        content: input.content,
        severity: input.severity,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        dedupeKey: input.dedupeKey,
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
