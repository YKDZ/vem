import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  maintenanceWorkOrders,
  type DrizzleClient,
  type DrizzleTransaction,
} from "@vem/db";
import { pageQuerySchema } from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type PageQueryInput = z.infer<typeof pageQuerySchema>;

@Injectable()
export class MaintenanceWorkOrdersService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async createWorkOrder(
    tx: DrizzleTransaction,
    input: {
      machineId?: string | null;
      slotId?: string | null;
      orderId?: string | null;
      commandId?: string | null;
      title: string;
      description: string;
      priority?: string;
      dedupeKey: string;
    },
  ): Promise<void> {
    const no = `WO${Date.now()}`;
    await tx
      .insert(maintenanceWorkOrders)
      .values({
        workOrderNo: no,
        machineId: input.machineId ?? null,
        slotId: input.slotId ?? null,
        orderId: input.orderId ?? null,
        commandId: input.commandId ?? null,
        title: input.title,
        description: input.description,
        priority: input.priority ?? "medium",
        status: "open",
        dedupeKey: input.dedupeKey,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: maintenanceWorkOrders.dedupeKey });
  }

  async list(query: PageQueryInput & { status?: string }) {
    const wheres = [];
    if (query.status) {
      wheres.push(eq(maintenanceWorkOrders.status, query.status));
    }
    const items = await this.db
      .select()
      .from(maintenanceWorkOrders)
      .where(wheres.length > 0 ? and(...wheres) : undefined)
      .orderBy(desc(maintenanceWorkOrders.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(maintenanceWorkOrders)
      .where(wheres.length > 0 ? and(...wheres) : undefined);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async resolve(id: string, adminUserId: string, resolutionNote: string) {
    const [updated] = await this.db
      .update(maintenanceWorkOrders)
      .set({
        status: "resolved",
        assigneeAdminUserId: adminUserId,
        resolutionNote,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(maintenanceWorkOrders.id, id),
          inArray(maintenanceWorkOrders.status, ["open", "in_progress"]),
        ),
      )
      .returning();

    if (!updated) {
      throw new NotFoundException("Work order not found or already resolved");
    }
    return updated;
  }
}
