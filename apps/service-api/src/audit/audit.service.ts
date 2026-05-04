import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  auditLogs,
  count,
  desc,
  eq,
  sql,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import { auditLogQuerySchema, pageQuerySchema } from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type AuditLogQuery = z.infer<typeof auditLogQuerySchema> &
  z.infer<typeof pageQuerySchema>;

@Injectable()
export class AuditService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async list(query: AuditLogQuery) {
    const filters: SQL[] = [];
    if (query.adminUserId)
      filters.push(eq(auditLogs.adminUserId, query.adminUserId));
    if (query.action) filters.push(eq(auditLogs.action, query.action));
    if (query.resourceType)
      filters.push(eq(auditLogs.resourceType, query.resourceType));
    if (query.resourceId)
      filters.push(eq(auditLogs.resourceId, query.resourceId));
    if (query.createdFrom)
      filters.push(
        sql`${auditLogs.createdAt} >= ${new Date(query.createdFrom)}`,
      );
    if (query.createdTo)
      filters.push(sql`${auditLogs.createdAt} <= ${new Date(query.createdTo)}`);
    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const items = await this.db
      .select()
      .from(auditLogs)
      .where(whereClause)
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(auditLogs)
      .where(whereClause);
    return toPageResult(items, query, Number(totalRow.total));
  }

  async record(input: {
    adminUserId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    beforeJson?: Record<string, unknown>;
    afterJson?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(auditLogs).values({
      adminUserId: input.adminUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      beforeJson: input.beforeJson,
      afterJson: input.afterJson,
    });
  }
}
