import type { PaymentCodeAttemptStatus } from "@vem/shared";

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
  isNull,
  machines,
  orders,
  paymentCodeAttempts,
  paymentProviders,
  payments,
  sql,
  type DrizzleClient,
} from "@vem/db";
import { pageQuerySchema, paymentCodeAttemptQuerySchema } from "@vem/shared";
import { z } from "zod";

import { createBusinessNo } from "../common/business-no.util";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  buildStoredEventPayload,
  hashPaymentCode,
  maskPaymentCode,
} from "./payment-redaction.util";

export type CreatePaymentCodeAttemptInput = {
  orderNo: string;
  machineCode: string;
  authCode: string;
  idempotencyKey: string;
  source: string;
  scannerHealthJson?: Record<string, unknown> | null;
};

export type PaymentCodeAttemptRow = typeof paymentCodeAttempts.$inferSelect;
type PaymentCodeAttemptListQuery = z.infer<
  typeof paymentCodeAttemptQuerySchema
> &
  z.infer<typeof pageQuerySchema>;

@Injectable()
export class PaymentCodeAttemptsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async createOrReplay(input: CreatePaymentCodeAttemptInput): Promise<{
    payment: {
      id: string;
      paymentNo: string;
      amountCents: number;
      status: string;
      providerCode: string;
      providerId: string;
      orderId: string;
      machineId: string;
    };
    attempt: PaymentCodeAttemptRow;
    replayed: boolean;
  }> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          orderId: orders.id,
          orderNo: orders.orderNo,
          machineId: machines.id,
          paymentId: payments.id,
          paymentNo: payments.paymentNo,
          paymentProviderConfigId: payments.paymentProviderConfigId,
          amountCents: payments.amountCents,
          paymentStatus: payments.status,
          paymentMethod: payments.method,
          providerId: paymentProviders.id,
          providerCode: paymentProviders.code,
        })
        .from(orders)
        .innerJoin(machines, eq(machines.id, orders.machineId))
        .innerJoin(payments, eq(payments.id, orders.paymentId))
        .innerJoin(
          paymentProviders,
          eq(paymentProviders.id, payments.providerId),
        )
        .where(
          and(
            eq(orders.orderNo, input.orderNo),
            eq(machines.code, input.machineCode),
            isNull(machines.deletedAt),
          ),
        );

      if (!row) throw new NotFoundException("Machine order not found");
      if (row.paymentMethod !== "payment_code") {
        throw new ConflictException("Order is not a payment_code order");
      }
      if (row.paymentStatus === "succeeded") {
        throw new ConflictException("Payment already succeeded");
      }

      const [existingByKey] = await tx
        .select()
        .from(paymentCodeAttempts)
        .where(
          and(
            eq(paymentCodeAttempts.paymentId, row.paymentId),
            eq(paymentCodeAttempts.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existingByKey) {
        return {
          payment: this.mapPayment(row),
          attempt: existingByKey,
          replayed: true,
        };
      }

      const [active] = await tx
        .select()
        .from(paymentCodeAttempts)
        .where(
          and(
            eq(paymentCodeAttempts.orderId, row.orderId),
            eq(paymentCodeAttempts.isActive, true),
          ),
        )
        .limit(1);
      if (active) {
        throw new ConflictException("payment_code_attempt_in_progress");
      }

      const [{ total }] = await tx
        .select({ total: count() })
        .from(paymentCodeAttempts)
        .where(eq(paymentCodeAttempts.orderId, row.orderId));
      const attemptNo = Number(total) + 1;

      const [attempt] = await tx
        .insert(paymentCodeAttempts)
        .values({
          paymentId: row.paymentId,
          orderId: row.orderId,
          providerId: row.providerId,
          paymentProviderConfigId: row.paymentProviderConfigId,
          attemptNo,
          providerPaymentNo: createBusinessNo("PCA"),
          idempotencyKey: input.idempotencyKey,
          status: "created",
          isActive: true,
          amountCents: row.amountCents,
          currency: "CNY",
          authCodeHash: hashPaymentCode(input.authCode),
          authCodeMasked: maskPaymentCode(input.authCode),
          source: input.source,
          scannerHealthJson: input.scannerHealthJson ?? null,
          rawPayloadJson: buildStoredEventPayload({
            source: input.source,
            scannerHealth: input.scannerHealthJson ?? null,
          }),
        })
        .returning();

      return {
        payment: this.mapPayment(row),
        attempt,
        replayed: false,
      };
    });
  }

  async markStatus(
    id: string,
    status: PaymentCodeAttemptStatus,
    patch: Partial<typeof paymentCodeAttempts.$inferInsert> = {},
  ): Promise<PaymentCodeAttemptRow> {
    const terminal = ["succeeded", "failed", "reversed", "canceled"].includes(
      status,
    );
    const [updated] = await this.db
      .update(paymentCodeAttempts)
      .set({
        ...patch,
        status,
        isActive: terminal ? false : (patch.isActive ?? true),
        updatedAt: new Date(),
      })
      .where(eq(paymentCodeAttempts.id, id))
      .returning();
    if (!updated) throw new NotFoundException("Payment code attempt not found");
    return updated;
  }

  async getById(id: string): Promise<PaymentCodeAttemptRow> {
    const [row] = await this.db
      .select()
      .from(paymentCodeAttempts)
      .where(eq(paymentCodeAttempts.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Payment code attempt not found");
    return row;
  }

  async getContextById(id: string): Promise<{
    attempt: PaymentCodeAttemptRow;
    paymentNo: string;
    orderNo: string;
    machineId: string;
    providerCode: "wechat_pay" | "alipay";
    providerConfigId: string | null;
  }> {
    const [row] = await this.db
      .select({
        attempt: paymentCodeAttempts,
        paymentNo: payments.paymentNo,
        orderNo: orders.orderNo,
        machineId: machines.id,
        providerCode: paymentProviders.code,
        providerConfigId: payments.paymentProviderConfigId,
      })
      .from(paymentCodeAttempts)
      .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
      .innerJoin(orders, eq(orders.id, paymentCodeAttempts.orderId))
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentCodeAttempts.providerId),
      )
      .where(eq(paymentCodeAttempts.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("Payment code attempt not found");
    return {
      ...row,
      // oxlint-disable-next-line no-unsafe-type-assertion -- query is constrained by schema and runtime provider set
      providerCode: row.providerCode as "wechat_pay" | "alipay",
    };
  }

  async listAttempts(query: PaymentCodeAttemptListQuery) {
    const conditions = [];
    if (query.orderNo) {
      conditions.push(eq(orders.orderNo, query.orderNo));
    }
    if (query.paymentNo) {
      conditions.push(eq(payments.paymentNo, query.paymentNo));
    }
    if (query.providerCode) {
      conditions.push(eq(paymentProviders.code, query.providerCode));
    }
    if (query.status) {
      conditions.push(eq(paymentCodeAttempts.status, query.status));
    }
    if (query.manualOnly === true) {
      conditions.push(
        sql`${paymentCodeAttempts.status} = 'manual_handling' or ${paymentCodeAttempts.manualReason} is not null`,
      );
    }
    if (query.createdFrom) {
      conditions.push(
        sql`${paymentCodeAttempts.createdAt} >= ${new Date(query.createdFrom)}`,
      );
    }
    if (query.createdTo) {
      conditions.push(
        sql`${paymentCodeAttempts.createdAt} <= ${new Date(query.createdTo)}`,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await this.db
      .select({
        id: paymentCodeAttempts.id,
        orderNo: orders.orderNo,
        paymentNo: payments.paymentNo,
        providerCode: paymentProviders.code,
        attemptNo: paymentCodeAttempts.attemptNo,
        providerPaymentNo: paymentCodeAttempts.providerPaymentNo,
        status: paymentCodeAttempts.status,
        authCodeMasked: paymentCodeAttempts.authCodeMasked,
        source: paymentCodeAttempts.source,
        failureCode: paymentCodeAttempts.failureCode,
        failureMessage: paymentCodeAttempts.failureMessage,
        manualReason: paymentCodeAttempts.manualReason,
        submittedAt: paymentCodeAttempts.submittedAt,
        lastCheckedAt: paymentCodeAttempts.lastCheckedAt,
        reversedAt: paymentCodeAttempts.reversedAt,
        finishedAt: paymentCodeAttempts.finishedAt,
        createdAt: paymentCodeAttempts.createdAt,
      })
      .from(paymentCodeAttempts)
      .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
      .innerJoin(orders, eq(orders.id, paymentCodeAttempts.orderId))
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentCodeAttempts.providerId),
      )
      .where(whereClause)
      .orderBy(desc(paymentCodeAttempts.createdAt))
      .limit(query.pageSize ?? 20)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(paymentCodeAttempts)
      .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
      .innerJoin(orders, eq(orders.id, paymentCodeAttempts.orderId))
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentCodeAttempts.providerId),
      )
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async latestForPayment(
    paymentId: string,
  ): Promise<PaymentCodeAttemptRow | null> {
    const [row] = await this.db
      .select()
      .from(paymentCodeAttempts)
      .where(eq(paymentCodeAttempts.paymentId, paymentId))
      .orderBy(desc(paymentCodeAttempts.createdAt))
      .limit(1);
    return row ?? null;
  }

  private mapPayment(row: {
    paymentId: string;
    paymentNo: string;
    amountCents: number;
    paymentStatus: string;
    providerCode: string;
    providerId: string;
    orderId: string;
    machineId: string;
  }) {
    return {
      id: row.paymentId,
      paymentNo: row.paymentNo,
      amountCents: row.amountCents,
      status: row.paymentStatus,
      providerCode: row.providerCode,
      providerId: row.providerId,
      orderId: row.orderId,
      machineId: row.machineId,
    };
  }
}
