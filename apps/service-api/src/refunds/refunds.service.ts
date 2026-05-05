import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  desc,
  eq,
  orders,
  orderStatusEvents,
  paymentProviders,
  payments,
  refunds,
  type DrizzleClient,
} from "@vem/db";

import { createBusinessNo } from "../common/business-no.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { PaymentProviderRegistry } from "../payments/payment-provider.registry";

export type FullRefundReason = "auto_dispense_failed" | "admin_refund";

@Injectable()
export class RefundsService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
  ) {}

  async requestFullRefund(input: {
    orderId: string;
    reason: FullRefundReason;
    requestedByAdminUserId?: string;
    metadata?: Record<string, unknown>;
  }) {
    const created = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          orderId: orders.id,
          orderStatus: orders.status,
          paymentId: payments.id,
          paymentNo: payments.paymentNo,
          providerTradeNo: payments.providerTradeNo,
          providerCode: paymentProviders.code,
          amountCents: payments.amountCents,
        })
        .from(orders)
        .innerJoin(payments, eq(payments.id, orders.paymentId))
        .innerJoin(
          paymentProviders,
          eq(paymentProviders.id, payments.providerId),
        )
        .where(eq(orders.id, input.orderId))
        .orderBy(desc(payments.createdAt));
      if (!row) throw new NotFoundException("Order payment not found");

      const [existing] = await tx
        .select()
        .from(refunds)
        .where(
          and(
            eq(refunds.orderId, input.orderId),
            eq(refunds.reason, input.reason),
          ),
        )
        .limit(1);
      if (existing) return { refund: existing, row, created: false };

      const refundableStatuses = new Set([
        "dispense_failed",
        "manual_handling",
        "refund_pending",
      ]);
      if (!refundableStatuses.has(row.orderStatus)) {
        throw new ConflictException(
          `Order status ${row.orderStatus} cannot be refunded`,
        );
      }

      await tx
        .update(orders)
        .set({ status: "refund_pending", updatedAt: new Date() })
        .where(eq(orders.id, input.orderId));
      await tx
        .update(payments)
        .set({ status: "refund_pending", updatedAt: new Date() })
        .where(eq(payments.id, row.paymentId));
      await tx.insert(orderStatusEvents).values({
        orderId: input.orderId,
        fromStatus: row.orderStatus,
        toStatus: "refund_pending",
        reason: input.reason,
        metadata: input.metadata ?? null,
      });

      const [refund] = await tx
        .insert(refunds)
        .values({
          refundNo: createBusinessNo("RFD"),
          paymentId: row.paymentId,
          orderId: input.orderId,
          amountCents: row.amountCents,
          status: "processing",
          reason: input.reason,
          requestedByAdminUserId: input.requestedByAdminUserId ?? null,
        })
        .onConflictDoNothing({ target: [refunds.orderId, refunds.reason] })
        .returning();
      if (!refund) {
        const [racedExisting] = await tx
          .select()
          .from(refunds)
          .where(
            and(
              eq(refunds.orderId, input.orderId),
              eq(refunds.reason, input.reason),
            ),
          )
          .limit(1);
        if (!racedExisting)
          throw new ConflictException("Refund conflict without existing row");
        return { refund: racedExisting, row, created: false };
      }
      return { refund, row, created: true };
    });

    if (!created.created) return created.refund;

    const provider = this.paymentProviderRegistry.get(created.row.providerCode);
    try {
      const result = await provider.refundPayment({
        refundNo: created.refund.refundNo,
        paymentNo: created.row.paymentNo,
        providerTradeNo: created.row.providerTradeNo,
        amountCents: created.row.amountCents,
        reason: input.reason,
      });
      const [updated] = await this.db.transaction(async (tx) => {
        const [refund] = await tx
          .update(refunds)
          .set({
            status: result.status,
            providerRefundNo: result.providerRefundNo,
            refundedAt: result.refundedAt,
            updatedAt: new Date(),
          })
          .where(eq(refunds.id, created.refund.id))
          .returning();
        if (result.status === "succeeded") {
          await tx
            .update(payments)
            .set({ status: "refunded", updatedAt: new Date() })
            .where(eq(payments.id, created.row.paymentId));
          await tx
            .update(orders)
            .set({ status: "refunded", updatedAt: new Date() })
            .where(eq(orders.id, input.orderId));
          await tx.insert(orderStatusEvents).values({
            orderId: input.orderId,
            fromStatus: "refund_pending",
            toStatus: "refunded",
            reason: `${input.reason}_succeeded`,
            metadata: {
              refundNo: created.refund.refundNo,
              providerRefundNo: result.providerRefundNo,
            },
          });
        }
        return [refund];
      });
      return updated;
    } catch (error) {
      const [failed] = await this.db.transaction(async (tx) => {
        const [refund] = await tx
          .update(refunds)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(refunds.id, created.refund.id))
          .returning();
        await tx
          .update(orders)
          .set({ status: "manual_handling", updatedAt: new Date() })
          .where(eq(orders.id, input.orderId));
        await tx.insert(orderStatusEvents).values({
          orderId: input.orderId,
          fromStatus: "refund_pending",
          toStatus: "manual_handling",
          reason: `${input.reason}_failed`,
          metadata: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return [refund];
      });
      return failed;
    }
  }
}
