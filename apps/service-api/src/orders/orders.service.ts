import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  inventories,
  inventoryMovements,
  isNull,
  machineSlots,
  machines,
  orderItems,
  orders,
  orderStatusEvents,
  paymentEvents,
  paymentProviders,
  payments,
  productVariants,
  products,
  refunds,
  sql,
  vendingCommands,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import {
  createMachineOrderSchema,
  machineOrderStatusNextActionSchema,
  machineOrderStatusQuerySchema,
  orderQuerySchema,
  pageQuerySchema,
  type MachineOrderStatusNextAction,
  type OrderStatus,
  type PaymentStatus,
  type VendingCommandStatus,
} from "@vem/shared";
import { z } from "zod";

import { createBusinessNo } from "../common/business-no.util";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { InventoryService } from "../inventory/inventory.service";
import { MockPaymentProvider } from "../payments/mock-payment.provider";

type CreateMachineOrderInput = z.infer<typeof createMachineOrderSchema>;
type MachineOrderStatusQuery = z.infer<typeof machineOrderStatusQuerySchema>;
type OrderQuery = z.infer<typeof orderQuerySchema> &
  z.infer<typeof pageQuerySchema>;

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly inventoryService: InventoryService,
    private readonly mockPaymentProvider: MockPaymentProvider,
  ) {}

  async createMachineOrder(input: CreateMachineOrderInput) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(
        and(
          eq(machines.code, input.machineCode),
          isNull(machines.deletedAt),
          inArray(machines.status, ["online", "offline", "maintenance"]),
        ),
      );
    if (!machine) {
      throw new NotFoundException("Machine not found or disabled");
    }

    const paymentExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    return await this.db.transaction(async (tx) => {
      const inventoryIds = [
        ...new Set(input.items.map((item) => item.inventoryId)),
      ];
      const availableRows = await tx
        .select({
          inventoryId: inventories.id,
          variantId: productVariants.id,
          productName: products.name,
          sku: productVariants.sku,
          size: productVariants.size,
          color: productVariants.color,
          unitPriceCents: productVariants.priceCents,
          slotId: machineSlots.id,
          slotCode: machineSlots.slotCode,
          layerNo: machineSlots.layerNo,
          cellNo: machineSlots.cellNo,
        })
        .from(inventories)
        .innerJoin(machineSlots, eq(machineSlots.id, inventories.slotId))
        .innerJoin(
          productVariants,
          eq(productVariants.id, inventories.variantId),
        )
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          and(
            inArray(inventories.id, inventoryIds),
            eq(inventories.machineId, machine.id),
            eq(machineSlots.status, "enabled"),
            eq(productVariants.status, "active"),
            eq(products.status, "active"),
          ),
        );

      const itemDetails = input.items.map((item) => {
        const row = availableRows.find(
          (candidate) => candidate.inventoryId === item.inventoryId,
        );
        if (!row) {
          throw new NotFoundException(
            `Inventory ${item.inventoryId} not found`,
          );
        }
        return {
          ...row,
          quantity: item.quantity,
        };
      });

      const totalAmountCents = itemDetails.reduce(
        (sum, item) => sum + item.unitPriceCents * item.quantity,
        0,
      );
      const orderNo = createBusinessNo("ORD");

      const [createdOrder] = await tx
        .insert(orders)
        .values({
          orderNo,
          machineId: machine.id,
          status: "pending_payment",
          totalAmountCents,
          currency: "CNY",
          profileSnapshot: input.profileSnapshot ?? null,
          createdFrom: "machine_ui",
        })
        .returning({
          id: orders.id,
          orderNo: orders.orderNo,
          totalAmountCents: orders.totalAmountCents,
        });

      await itemDetails.reduce<Promise<void>>(async (previous, item) => {
        await previous;
        await this.inventoryService.reserveForOrder(tx, {
          orderId: createdOrder.id,
          inventoryId: item.inventoryId,
          quantity: item.quantity,
          expiresAt: paymentExpiresAt,
        });
        await tx.insert(orderItems).values({
          orderId: createdOrder.id,
          variantId: item.variantId,
          inventoryId: item.inventoryId,
          slotId: item.slotId,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          productSnapshot: {
            productName: item.productName,
            sku: item.sku,
            size: item.size,
            color: item.color,
            slotCode: item.slotCode,
            layerNo: item.layerNo,
            cellNo: item.cellNo,
          },
        });
      }, Promise.resolve());

      const [provider] = await tx
        .select({ id: paymentProviders.id, code: paymentProviders.code })
        .from(paymentProviders)
        .where(
          and(
            eq(paymentProviders.code, input.paymentMethod),
            eq(paymentProviders.status, "enabled"),
          ),
        );
      if (!provider) {
        throw new ConflictException("Payment provider unavailable");
      }

      const paymentNo = createBusinessNo("PAY");
      const intent = await this.createPaymentIntent(input.paymentMethod, {
        paymentNo,
        orderNo,
        amountCents: totalAmountCents,
        expiresAt: paymentExpiresAt,
      });

      const [payment] = await tx
        .insert(payments)
        .values({
          paymentNo,
          orderId: createdOrder.id,
          providerId: provider.id,
          method: input.paymentMethod,
          status: "pending",
          amountCents: totalAmountCents,
          providerTradeNo: intent.providerTradeNo,
          paymentUrl: intent.paymentUrl,
          expiresAt: paymentExpiresAt,
        })
        .returning({
          id: payments.id,
          paymentNo: payments.paymentNo,
          paymentUrl: payments.paymentUrl,
          expiresAt: payments.expiresAt,
          amountCents: payments.amountCents,
        });

      await tx
        .update(orders)
        .set({ paymentId: payment.id, updatedAt: new Date() })
        .where(eq(orders.id, createdOrder.id));

      await tx.insert(orderStatusEvents).values({
        orderId: createdOrder.id,
        toStatus: "pending_payment",
        reason: "machine_order_created",
      });

      return {
        orderId: createdOrder.id,
        orderNo: createdOrder.orderNo,
        paymentNo: payment.paymentNo,
        paymentUrl: payment.paymentUrl,
        expiresAt: payment.expiresAt,
        totalAmountCents: payment.amountCents,
      };
    });
  }

  async listOrders(query: OrderQuery) {
    const filters: SQL[] = [];
    if (query.orderNo) {
      filters.push(eq(orders.orderNo, query.orderNo));
    }
    if (query.machineId) {
      filters.push(eq(orders.machineId, query.machineId));
    }
    if (query.status) {
      filters.push(eq(orders.status, query.status));
    }
    if (query.createdFrom) {
      filters.push(sql`${orders.createdAt} >= ${new Date(query.createdFrom)}`);
    }
    if (query.createdTo) {
      filters.push(sql`${orders.createdAt} <= ${new Date(query.createdTo)}`);
    }
    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const items = await this.db
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        machineId: orders.machineId,
        machineCode: machines.code,
        status: orders.status,
        totalAmountCents: orders.totalAmountCents,
        paidAt: orders.paidAt,
        dispensedAt: orders.dispensedAt,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .where(whereClause)
      .orderBy(desc(orders.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(orders)
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async getOrderDetail(id: string) {
    const [order] = await this.db
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        machineId: orders.machineId,
        machineCode: machines.code,
        status: orders.status,
        totalAmountCents: orders.totalAmountCents,
        currency: orders.currency,
        paidAt: orders.paidAt,
        dispensedAt: orders.dispensedAt,
        canceledAt: orders.canceledAt,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .where(eq(orders.id, id));
    if (!order) {
      throw new NotFoundException("Order not found");
    }

    const items = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id))
      .orderBy(orderItems.createdAt);

    const paymentRows = await this.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, id))
      .orderBy(desc(payments.createdAt));

    const paymentIds = paymentRows.map((payment) => payment.id);
    const paymentEventRows =
      paymentIds.length === 0
        ? []
        : await this.db
            .select()
            .from(paymentEvents)
            .where(inArray(paymentEvents.paymentId, paymentIds))
            .orderBy(desc(paymentEvents.createdAt));

    const vendingCommandRows = await this.db
      .select()
      .from(vendingCommands)
      .where(eq(vendingCommands.orderId, id))
      .orderBy(desc(vendingCommands.createdAt));

    const inventoryMovementRows = await this.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.orderId, id))
      .orderBy(desc(inventoryMovements.createdAt));

    const orderStatusEventRows = await this.db
      .select()
      .from(orderStatusEvents)
      .where(eq(orderStatusEvents.orderId, id))
      .orderBy(desc(orderStatusEvents.createdAt));

    return {
      order,
      items,
      payments: paymentRows,
      paymentEvents: paymentEventRows,
      vendingCommands: vendingCommandRows,
      inventoryMovements: inventoryMovementRows,
      orderStatusEvents: orderStatusEventRows,
    };
  }

  async requestMockRefund(orderId: string, adminUserId: string) {
    return await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select({
          id: orders.id,
          status: orders.status,
          totalAmountCents: orders.totalAmountCents,
        })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (!order) {
        throw new NotFoundException("Order not found");
      }

      const refundableStatuses = new Set([
        "dispense_failed",
        "manual_handling",
        "refund_pending",
      ]);
      if (!refundableStatuses.has(order.status)) {
        throw new ConflictException(
          `Order status ${order.status} cannot be refunded`,
        );
      }

      const [payment] = await tx
        .select({ id: payments.id, amountCents: payments.amountCents })
        .from(payments)
        .where(eq(payments.orderId, orderId))
        .orderBy(desc(payments.createdAt));
      if (!payment) {
        throw new ConflictException("Payment not found for order");
      }

      if (order.status !== "refund_pending") {
        await tx
          .update(orders)
          .set({ status: "refund_pending", updatedAt: new Date() })
          .where(eq(orders.id, orderId));
        await tx.insert(orderStatusEvents).values({
          orderId,
          fromStatus: order.status,
          toStatus: "refund_pending",
          reason: "refund_requested",
          metadata: { adminUserId },
        });
      }

      const [refund] = await tx
        .insert(refunds)
        .values({
          refundNo: createBusinessNo("RFD"),
          paymentId: payment.id,
          orderId,
          amountCents: payment.amountCents,
          status: "succeeded",
          reason: "mock_refund",
          requestedByAdminUserId: adminUserId,
          refundedAt: new Date(),
        })
        .returning();

      await tx
        .update(payments)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(payments.id, payment.id));

      await tx
        .update(orders)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(orders.id, orderId));

      await tx.insert(orderStatusEvents).values({
        orderId,
        fromStatus: "refund_pending",
        toStatus: "refunded",
        reason: "mock_refund_succeeded",
        metadata: { adminUserId, refundNo: refund.refundNo },
      });

      return refund;
    });
  }

  async getMachineOrderStatus(orderNo: string, query: MachineOrderStatusQuery) {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNo: orders.orderNo,
        machineCode: machines.code,
        orderStatus: orders.status,
        totalAmountCents: orders.totalAmountCents,
        paymentNo: payments.paymentNo,
        paymentMethod: payments.method,
        paymentStatus: payments.status,
        paymentUrl: payments.paymentUrl,
        paymentExpiresAt: payments.expiresAt,
        paidAt: payments.paidAt,
        failedReason: payments.failedReason,
      })
      .from(orders)
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .innerJoin(payments, eq(payments.id, orders.paymentId))
      .where(
        and(eq(orders.orderNo, orderNo), eq(machines.code, query.machineCode)),
      );

    if (!row) {
      throw new NotFoundException("Machine order not found");
    }

    const [command] = await this.db
      .select({
        commandNo: vendingCommands.commandNo,
        status: vendingCommands.status,
        sentAt: vendingCommands.sentAt,
        ackAt: vendingCommands.ackAt,
        resultAt: vendingCommands.resultAt,
        lastError: vendingCommands.lastError,
      })
      .from(vendingCommands)
      .where(eq(vendingCommands.orderId, row.orderId))
      .orderBy(desc(vendingCommands.createdAt))
      .limit(1);

    const nextAction = resolveMachineOrderNextAction(
      row.orderStatus,
      row.paymentStatus,
      command?.status ?? null,
    );

    return {
      orderId: row.orderId,
      orderNo: row.orderNo,
      machineCode: row.machineCode,
      orderStatus: row.orderStatus,
      totalAmountCents: row.totalAmountCents,
      payment: {
        paymentNo: row.paymentNo,
        method: row.paymentMethod,
        status: row.paymentStatus,
        paymentUrl: row.paymentUrl,
        expiresAt: toIsoStringOrNull(row.paymentExpiresAt),
        paidAt: toIsoStringOrNull(row.paidAt),
        failedReason: row.failedReason,
      },
      vending: command
        ? {
            commandNo: command.commandNo,
            status: command.status,
            sentAt: toIsoStringOrNull(command.sentAt),
            ackAt: toIsoStringOrNull(command.ackAt),
            resultAt: toIsoStringOrNull(command.resultAt),
            lastError: command.lastError,
          }
        : null,
      nextAction,
      serverTime: new Date().toISOString(),
    };
  }

  private async createPaymentIntent(
    method: CreateMachineOrderInput["paymentMethod"],
    input: {
      paymentNo: string;
      orderNo: string;
      amountCents: number;
      expiresAt: Date;
    },
  ) {
    if (method === "mock") {
      return await this.mockPaymentProvider.createPaymentIntent(input);
    }
    throw new ConflictException(`Unsupported payment method: ${method}`);
  }
}

function toIsoStringOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function resolveMachineOrderNextAction(
  orderStatus: OrderStatus,
  paymentStatus: PaymentStatus,
  commandStatus: VendingCommandStatus | null,
): MachineOrderStatusNextAction {
  if (orderStatus === "fulfilled") return "success";
  if (orderStatus === "dispense_failed") return "dispense_failed";
  if (orderStatus === "manual_handling") return "manual_handling";
  if (orderStatus === "refund_pending") return "refund_pending";
  if (orderStatus === "refunded") return "refunded";
  if (orderStatus === "closed") return "closed";

  if (paymentStatus === "refund_pending") return "refund_pending";
  if (paymentStatus === "refunded" || paymentStatus === "partial_refunded") {
    return "refunded";
  }

  if (orderStatus === "payment_expired" || paymentStatus === "expired") {
    return "payment_expired";
  }
  if (
    orderStatus === "canceled" ||
    paymentStatus === "failed" ||
    paymentStatus === "canceled"
  ) {
    return "payment_failed";
  }

  if (
    (orderStatus === "paid" || orderStatus === "dispensing") &&
    (commandStatus === "failed" || commandStatus === "timeout")
  ) {
    return "manual_handling";
  }
  if (orderStatus === "paid" || orderStatus === "dispensing") {
    return "dispensing";
  }

  if (
    paymentStatus === "created" ||
    paymentStatus === "pending" ||
    paymentStatus === "processing"
  ) {
    return "wait_payment";
  }

  return machineOrderStatusNextActionSchema.parse("wait_payment");
}
