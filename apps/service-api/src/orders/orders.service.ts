import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
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
  paymentCodeAttempts,
  paymentEvents,
  paymentProviders,
  payments,
  productVariants,
  products,
  refunds,
  sql,
  vendingCommands,
  type DrizzleClient,
  type DrizzleTransaction,
  type SQL,
} from "@vem/db";
import {
  createMachineOrderSchema,
  machineOrderStatusNextActionSchema,
  machineOrderStatusQuerySchema,
  orderQuerySchema,
  paymentCodeSourceSchema,
  pageQuerySchema,
  type MachineOrderStatusNextAction,
  type OrderStatus,
  type PaymentCodeSource,
  type PaymentStatus,
  type VendingCommandStatus,
} from "@vem/shared";
import { z } from "zod";

import { createBusinessNo } from "../common/business-no.util";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { InventoryService } from "../inventory/inventory.service";
import { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import { PaymentProviderRegistry } from "../payments/payment-provider.registry";
import { buildStoredEventPayload } from "../payments/payment-redaction.util";
import { PaymentsService } from "../payments/payments.service";
import { RefundsService } from "../refunds/refunds.service";

type CreateMachineOrderInput = z.infer<typeof createMachineOrderSchema>;
type MachineOrderStatusQuery = z.infer<typeof machineOrderStatusQuerySchema>;
type OrderQuery = z.infer<typeof orderQuerySchema> &
  z.infer<typeof pageQuerySchema>;

function readQrExpiresMinutes(
  publicConfigJson: Record<string, unknown>,
): number {
  const value = publicConfigJson["qrExpiresMinutes"];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 60
    ? value
    : 15;
}

function resolvePaymentSelection(input: CreateMachineOrderInput): {
  providerCode: "mock" | "wechat_pay" | "alipay";
  method: CreateMachineOrderInput["paymentMethod"];
} {
  if (input.paymentMethod === "mock") {
    if (
      input.paymentProviderCode !== undefined &&
      input.paymentProviderCode !== "mock"
    ) {
      throw new ConflictException(
        "mock payment method can only use mock provider",
      );
    }
    return { providerCode: "mock", method: "mock" };
  }

  if (
    input.paymentMethod === "qr_code" &&
    (input.paymentProviderCode === "wechat_pay" ||
      input.paymentProviderCode === "alipay")
  ) {
    return { providerCode: input.paymentProviderCode, method: "qr_code" };
  }

  if (
    input.paymentMethod === "payment_code" &&
    (input.paymentProviderCode === "wechat_pay" ||
      input.paymentProviderCode === "alipay")
  ) {
    return { providerCode: input.paymentProviderCode, method: "payment_code" };
  }

  throw new ConflictException(
    "Unsupported payment method/provider combination",
  );
}

type LocalPaymentDraft = {
  orderId: string;
  orderNo: string;
  paymentId: string;
  paymentNo: string;
  providerCode: string;
  paymentMethod: CreateMachineOrderInput["paymentMethod"];
  machineId: string;
  totalAmountCents: number;
  expiresAt: Date;
  reservations: Array<{ inventoryId: string; quantity: number }>;
};

type MachineOrderStatusRow = {
  orderId: string;
  orderNo: string;
  machineCode: string;
  orderStatus: OrderStatus;
  totalAmountCents: number;
  paymentId: string;
  paymentNo: string;
  paymentMethod: "mock" | "qr_code" | "payment_code" | "face_pay";
  paymentStatus: PaymentStatus;
  paymentUrl: string | null;
  paymentExpiresAt: Date | null;
  paidAt: Date | null;
  failedReason: string | null;
  paymentProviderCode: string;
};

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly inventoryService: InventoryService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly paymentProviderConfigService: PaymentProviderConfigService,
    private readonly refundsService: RefundsService,
    @Optional() private readonly paymentsService?: PaymentsService,
  ) {}

  private async findMachineOrderStatusRow(
    orderNo: string,
    machineCode: string,
  ): Promise<MachineOrderStatusRow | null> {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNo: orders.orderNo,
        machineCode: machines.code,
        orderStatus: orders.status,
        totalAmountCents: orders.totalAmountCents,
        paymentId: payments.id,
        paymentNo: payments.paymentNo,
        paymentMethod: payments.method,
        paymentStatus: payments.status,
        paymentUrl: payments.paymentUrl,
        paymentExpiresAt: payments.expiresAt,
        paidAt: payments.paidAt,
        failedReason: payments.failedReason,
        paymentProviderCode: paymentProviders.code,
      })
      .from(orders)
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .innerJoin(payments, eq(payments.id, orders.paymentId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(and(eq(orders.orderNo, orderNo), eq(machines.code, machineCode)));

    return row ?? null;
  }

  async createMachineOrder(input: CreateMachineOrderInput) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code, status: machines.status })
      .from(machines)
      .where(
        and(eq(machines.code, input.machineCode), isNull(machines.deletedAt)),
      );
    if (!machine) {
      throw new NotFoundException("Machine not found");
    }
    if (machine.status !== "online") {
      throw new ConflictException("Machine is not accepting orders");
    }

    const paymentSelection = resolvePaymentSelection(input);

    // Resolve provider config before entering the transaction
    let resolvedProviderConfig:
      | import("../payments/payment-provider-config.service").RuntimePaymentProviderConfig
      | null = null;
    if (paymentSelection.providerCode !== "mock") {
      resolvedProviderConfig =
        await this.paymentProviderConfigService.resolveForPayment({
          providerCode: paymentSelection.providerCode,
          machineId: machine.id,
        });
    }

    const qrExpiresMinutes = resolvedProviderConfig
      ? readQrExpiresMinutes(resolvedProviderConfig.publicConfigJson)
      : 15;
    const paymentExpiresAt = new Date(
      Date.now() + qrExpiresMinutes * 60 * 1000,
    );
    const draft = await this.createLocalMachineOrderDraft(
      input,
      machine.id,
      paymentExpiresAt,
      paymentSelection,
      resolvedProviderConfig,
    );

    if (paymentSelection.method === "payment_code") {
      await this.db
        .update(payments)
        .set({
          status: "pending",
          expiresAt: draft.expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, draft.paymentId));
      return {
        orderId: draft.orderId,
        orderNo: draft.orderNo,
        paymentNo: draft.paymentNo,
        paymentUrl: null,
        expiresAt: draft.expiresAt,
        totalAmountCents: draft.totalAmountCents,
        paymentProviderCode: draft.providerCode,
      };
    }

    let intent: Awaited<ReturnType<typeof this.createPaymentIntent>>;
    try {
      intent = await this.createPaymentIntent(
        draft.providerCode,
        draft.machineId,
        {
          paymentNo: draft.paymentNo,
          orderNo: draft.orderNo,
          amountCents: draft.totalAmountCents,
          expiresAt: draft.expiresAt,
        },
      );
    } catch (error) {
      await this.cancelLocalCreatedPayment(
        draft,
        "provider_create_failed",
        error,
      );
      throw error;
    }

    try {
      await this.db
        .update(payments)
        .set({
          status: "pending",
          providerTradeNo: intent.providerTradeNo,
          paymentUrl: intent.paymentUrl,
          expiresAt: draft.expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, draft.paymentId));
    } catch (error) {
      await this.cancelProviderIntentAfterDbFailure(draft);
      await this.cancelLocalCreatedPayment(
        draft,
        "provider_created_db_update_failed",
        error,
      );
      throw error;
    }

    return {
      orderId: draft.orderId,
      orderNo: draft.orderNo,
      paymentNo: draft.paymentNo,
      paymentUrl: intent.paymentUrl,
      expiresAt: draft.expiresAt,
      totalAmountCents: draft.totalAmountCents,
      paymentProviderCode: draft.providerCode,
    };
  }

  private async createLocalMachineOrderDraft(
    input: CreateMachineOrderInput,
    machineId: string,
    paymentExpiresAt: Date,
    paymentSelection: {
      providerCode: "mock" | "wechat_pay" | "alipay";
      method: CreateMachineOrderInput["paymentMethod"];
    },
    resolvedProviderConfig:
      | import("../payments/payment-provider-config.service").RuntimePaymentProviderConfig
      | null,
  ): Promise<LocalPaymentDraft> {
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
            eq(inventories.machineId, machineId),
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
          machineId,
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

      const providerCode = paymentSelection.providerCode;
      const [provider] = await tx
        .select({ id: paymentProviders.id, code: paymentProviders.code })
        .from(paymentProviders)
        .where(
          and(
            eq(paymentProviders.code, providerCode),
            eq(paymentProviders.status, "enabled"),
          ),
        );
      if (!provider) {
        throw new ConflictException("Payment provider unavailable");
      }

      const paymentNo = createBusinessNo("PAY");
      const [payment] = await tx
        .insert(payments)
        .values({
          paymentNo,
          orderId: createdOrder.id,
          providerId: provider.id,
          paymentProviderConfigId: resolvedProviderConfig?.id ?? null,
          providerConfigSnapshotJson: resolvedProviderConfig
            ? {
                id: resolvedProviderConfig.id,
                providerCode: resolvedProviderConfig.providerCode,
                merchantNo: resolvedProviderConfig.merchantNo,
                appId: resolvedProviderConfig.appId,
                publicConfigJson: resolvedProviderConfig.publicConfigJson,
              }
            : null,
          method: paymentSelection.method,
          status: "created",
          amountCents: totalAmountCents,
          providerTradeNo: null,
          paymentUrl: null,
          expiresAt: paymentExpiresAt,
        })
        .returning({
          id: payments.id,
          paymentNo: payments.paymentNo,
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
        paymentId: payment.id,
        paymentNo: payment.paymentNo,
        providerCode: provider.code,
        paymentMethod: input.paymentMethod,
        machineId,
        totalAmountCents: payment.amountCents,
        expiresAt: paymentExpiresAt,
        reservations: input.items.map((item) => ({
          inventoryId: item.inventoryId,
          quantity: item.quantity,
        })),
      };
    });
  }

  private async cancelLocalCreatedPayment(
    draft: LocalPaymentDraft,
    reason: "provider_create_failed" | "provider_created_db_update_failed",
    error: unknown,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          status: "failed",
          failedReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, draft.paymentId));

      await tx
        .update(orders)
        .set({
          status: "canceled",
          canceledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, draft.orderId));

      await tx.insert(orderStatusEvents).values({
        orderId: draft.orderId,
        fromStatus: "pending_payment",
        toStatus: "canceled",
        reason,
        metadata: {
          paymentNo: draft.paymentNo,
          message: error instanceof Error ? error.message : String(error),
        },
      });

      await tx
        .insert(paymentEvents)
        .values({
          paymentId: draft.paymentId,
          providerId: await this.findProviderIdForCode(tx, draft.providerCode),
          eventType: `payment.${reason}`,
          providerEventId: `${reason}:${draft.paymentNo}`,
          rawPayloadJson: buildStoredEventPayload({
            paymentNo: draft.paymentNo,
            reason,
            message: error instanceof Error ? error.message : String(error),
          }),
          signatureValid: true,
          handledAt: new Date(),
        })
        .onConflictDoNothing();

      await draft.reservations.reduce<Promise<void>>(
        async (previous, reservation) => {
          await previous;
          await this.inventoryService.releaseReservation(tx, {
            orderId: draft.orderId,
            inventoryId: reservation.inventoryId,
            quantity: reservation.quantity,
            reason: "payment_failed",
          });
        },
        Promise.resolve(),
      );
    });
  }

  private async cancelProviderIntentAfterDbFailure(
    draft: LocalPaymentDraft,
  ): Promise<void> {
    try {
      const provider = this.paymentProviderRegistry.get(draft.providerCode);
      const config = await this.paymentProviderConfigService
        .resolveForPayment({
          providerCode: draft.providerCode,
          machineId: draft.machineId,
        })
        .catch(() => ({
          id: "",
          providerCode: draft.providerCode,
          providerId: "",
          machineId: null,
          merchantNo: null,
          appId: null,
          publicConfigJson: {} as Record<string, unknown>,
          sensitiveConfigJson: {} as Record<string, unknown>,
        }));
      await provider.cancelPayment({
        paymentNo: draft.paymentNo,
        providerTradeNo: null,
        config,
      });
    } catch (error) {
      await this.db
        .insert(paymentEvents)
        .values({
          paymentId: draft.paymentId,
          providerId: await this.findProviderIdForCode(
            this.db,
            draft.providerCode,
          ),
          eventType: "payment.provider_cancel_after_db_failure_failed",
          providerEventId: `provider_cancel_after_db_failure_failed:${draft.paymentNo}`,
          rawPayloadJson: buildStoredEventPayload({
            paymentNo: draft.paymentNo,
            message: error instanceof Error ? error.message : String(error),
          }),
          signatureValid: true,
          handledAt: new Date(),
        })
        .onConflictDoNothing();
    }
  }

  private async findProviderIdForCode(
    db: DrizzleClient | DrizzleTransaction,
    providerCode: string,
  ): Promise<string> {
    const [row] = await db
      .select({ id: paymentProviders.id })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, providerCode))
      .limit(1);
    return row?.id ?? "unknown";
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
    return await this.refundsService.requestFullRefund({
      orderId,
      reason: "admin_refund",
      requestedByAdminUserId: adminUserId,
    });
  }

  async getMachineOrderStatus(orderNo: string, query: MachineOrderStatusQuery) {
    let row = await this.findMachineOrderStatusRow(orderNo, query.machineCode);

    if (!row) {
      throw new NotFoundException("Machine order not found");
    }

    if (
      row.paymentMethod === "qr_code" &&
      (row.paymentStatus === "pending" || row.paymentStatus === "processing")
    ) {
      await this.paymentsService
        ?.reconcilePendingPaymentOnRead(row.paymentId)
        // oxlint-disable-next-line no-empty-function -- query status should keep best-effort
        .catch(() => {});

      const refreshed = await this.findMachineOrderStatusRow(
        orderNo,
        query.machineCode,
      );
      if (refreshed) {
        row = refreshed;
      }
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

    const [refund] = await this.db
      .select({
        refundNo: refunds.refundNo,
        status: refunds.status,
        amountCents: refunds.amountCents,
        reason: refunds.reason,
        refundedAt: refunds.refundedAt,
      })
      .from(refunds)
      .where(eq(refunds.orderId, row.orderId))
      .orderBy(desc(refunds.createdAt))
      .limit(1);

    const [paymentCodeAttempt] = await this.db
      .select({
        attemptNo: paymentCodeAttempts.attemptNo,
        status: paymentCodeAttempts.status,
        maskedAuthCode: paymentCodeAttempts.authCodeMasked,
        source: paymentCodeAttempts.source,
        idempotencyKey: paymentCodeAttempts.idempotencyKey,
        submittedAt: paymentCodeAttempts.submittedAt,
        lastCheckedAt: paymentCodeAttempts.lastCheckedAt,
        failureMessage: paymentCodeAttempts.failureMessage,
        isActive: paymentCodeAttempts.isActive,
      })
      .from(paymentCodeAttempts)
      .where(eq(paymentCodeAttempts.paymentId, row.paymentId))
      .orderBy(desc(paymentCodeAttempts.createdAt))
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
        providerCode: row.paymentProviderCode,
      },
      paymentCodeAttempt: paymentCodeAttempt
        ? {
            attemptNo: paymentCodeAttempt.attemptNo,
            status: paymentCodeAttempt.status,
            maskedAuthCode: paymentCodeAttempt.maskedAuthCode,
            source: toPaymentCodeSourceOrNull(paymentCodeAttempt.source),
            idempotencyKey: paymentCodeAttempt.idempotencyKey,
            submittedAt: toIsoStringOrNull(paymentCodeAttempt.submittedAt),
            lastCheckedAt: toIsoStringOrNull(paymentCodeAttempt.lastCheckedAt),
            canRetry:
              !paymentCodeAttempt.isActive &&
              ["failed", "reversed", "canceled"].includes(
                paymentCodeAttempt.status,
              ),
            message: paymentCodeAttempt.failureMessage,
          }
        : null,
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
      refund: refund
        ? {
            refundNo: refund.refundNo,
            status: refund.status,
            amountCents: refund.amountCents,
            reason: refund.reason,
            refundedAt: toIsoStringOrNull(refund.refundedAt),
          }
        : null,
      nextAction,
      serverTime: new Date().toISOString(),
    };
  }

  async listMachinePaymentOptions(machineId: string) {
    return await this.paymentProviderConfigService.listMachinePaymentOptionsForMachine(
      machineId,
    );
  }

  private async createPaymentIntent(
    method: string,
    machineId: string,
    input: {
      paymentNo: string;
      orderNo: string;
      amountCents: number;
      expiresAt: Date;
    },
  ) {
    const provider = this.paymentProviderRegistry.get(method);
    const config = await this.paymentProviderConfigService
      .resolveForPayment({
        providerCode: method,
        machineId,
      })
      .catch(() => ({
        providerCode: method,
        merchantNo: null,
        appId: null,
        publicConfigJson: {},
        sensitiveConfigJson: {},
      }));
    return await provider.createPaymentIntent({ ...input, config });
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

function toPaymentCodeSourceOrNull(
  value: string | null,
): PaymentCodeSource | null {
  const result = paymentCodeSourceSchema.nullable().safeParse(value);
  return result.success ? result.data : null;
}
