import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inventories,
  machines,
  notifications,
  orderItems,
  orders,
  productVariants,
  products,
  sql,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import { dashboardDateRangeQuerySchema } from "@vem/shared";
import { z } from "zod";

import { DRIZZLE_CLIENT } from "../database/database.constants";

type DashboardDateRangeQuery = z.infer<typeof dashboardDateRangeQuerySchema>;

@Injectable()
export class DashboardService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async getSummary() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [salesRow] = await this.db
      .select({
        salesCents: sql<number>`coalesce(sum(${orders.totalAmountCents}), 0)`,
        orderCount: count(),
      })
      .from(orders)
      .where(sql`${orders.createdAt} >= ${todayStart}`);

    const [lowStockRow] = await this.db
      .select({ total: count() })
      .from(inventories)
      .where(
        sql`${inventories.onHandQty} - ${inventories.reservedQty} <= ${inventories.lowStockThreshold}`,
      );

    const [onlineMachineRow] = await this.db
      .select({ total: count() })
      .from(machines)
      .where(eq(machines.status, "online"));

    const [pendingIssueRow] = await this.db
      .select({ total: count() })
      .from(notifications)
      .where(eq(notifications.status, "unread"));

    return {
      todaySalesCents: Number(salesRow.salesCents),
      todayOrderCount: Number(salesRow.orderCount),
      lowStockCount: Number(lowStockRow.total),
      onlineMachineCount: Number(onlineMachineRow.total),
      pendingIssueCount: Number(pendingIssueRow.total),
    };
  }

  async getSalesTrend(query: DashboardDateRangeQuery) {
    const filters = this.buildDateFilters(query);
    return await this.db
      .select({
        date: sql<string>`to_char(${orders.createdAt}, 'YYYY-MM-DD')`,
        salesCents: sql<number>`coalesce(sum(${orders.totalAmountCents}), 0)`,
        orderCount: count(),
      })
      .from(orders)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .groupBy(sql`to_char(${orders.createdAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${orders.createdAt}, 'YYYY-MM-DD')`);
  }

  async getTopProducts(query: DashboardDateRangeQuery) {
    const filters = this.buildDateFilters(query);
    return await this.db
      .select({
        variantId: productVariants.id,
        productName: products.name,
        sku: productVariants.sku,
        quantity: sql<number>`coalesce(sum(${orderItems.quantity}), 0)`,
        salesCents: sql<number>`coalesce(sum(${orderItems.quantity} * ${orderItems.unitPriceCents}), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(productVariants, eq(productVariants.id, orderItems.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .groupBy(productVariants.id, products.name, productVariants.sku)
      .orderBy(desc(sql`coalesce(sum(${orderItems.quantity}), 0)`))
      .limit(10);
  }

  async getCustomerProfile(query: DashboardDateRangeQuery) {
    const filters = this.buildDateFilters(query);
    return await this.db
      .select({
        label: sql<string>`coalesce(${orders.profileSnapshot}->>'ageGroup', '未知')`,
        count: count(),
      })
      .from(orders)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .groupBy(sql`coalesce(${orders.profileSnapshot}->>'ageGroup', '未知')`)
      .orderBy(desc(count()));
  }

  private buildDateFilters(query: DashboardDateRangeQuery): SQL[] {
    const filters: SQL[] = [];
    if (query.from)
      filters.push(sql`${orders.createdAt} >= ${new Date(query.from)}`);
    if (query.to)
      filters.push(sql`${orders.createdAt} <= ${new Date(query.to)}`);
    return filters;
  }
}
