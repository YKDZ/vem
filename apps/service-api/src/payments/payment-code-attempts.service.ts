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
  inArray,
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
export type PaymentCodeAttemptDto = {
  id: string;
  orderId: string;
  orderNo?: string;
  paymentNo?: string;
  providerCode?: string;
  attemptNo: number;
  providerPaymentNo: string;
  status: PaymentCodeAttemptStatus;
  authCodeMasked: string;
  source: string;
  providerTradeNo: string | null;
  providerStatus: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  manualReason: string | null;
  submittedAt: Date | null;
  lastCheckedAt: Date | null;
  reversedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type PaymentCodeAttemptListQuery = z.infer<
  typeof paymentCodeAttemptQuerySchema
> &
  z.infer<typeof pageQuerySchema>;

function isIncidentLocked(row: {
  orderStatus: string;
  paymentState: string;
  fulfillmentState: string;
  paymentStatus: string;
}): boolean {
  return (
    row.orderStatus === "manual_handling" ||
    row.paymentState === "payment_unknown" ||
    row.paymentState === "manual_handling" ||
    row.fulfillmentState === "manual_handling" ||
    row.paymentStatus === "unknown" ||
    row.paymentStatus === "manual_handling"
  );
}

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
      providerConfigId: string | null;
      providerConfigSnapshotJson: unknown;
    };
    attempt: PaymentCodeAttemptRow;
    replayed: boolean;
  }> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          orderId: orders.id,
          orderNo: orders.orderNo,
          orderStatus: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
          machineId: machines.id,
          paymentId: payments.id,
          paymentNo: payments.paymentNo,
          paymentProviderConfigId: payments.paymentProviderConfigId,
          providerConfigSnapshotJson: payments.providerConfigSnapshotJson,
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
      if (isIncidentLocked(row)) {
        throw new ConflictException("payment_incident_locked");
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
    const updated = await this.tryMarkStatus(id, status, patch);
    if (!updated) throw new NotFoundException("Payment code attempt not found");
    return updated;
  }

  async markStatusIfCurrentStatusIn(
    id: string,
    status: PaymentCodeAttemptStatus,
    allowedCurrentStatuses: PaymentCodeAttemptStatus[],
    patch: Partial<typeof paymentCodeAttempts.$inferInsert> = {},
  ): Promise<PaymentCodeAttemptRow | null> {
    return await this.tryMarkStatus(id, status, patch, allowedCurrentStatuses);
  }

  private async tryMarkStatus(
    id: string,
    status: PaymentCodeAttemptStatus,
    patch: Partial<typeof paymentCodeAttempts.$inferInsert> = {},
    allowedCurrentStatuses?: PaymentCodeAttemptStatus[],
  ): Promise<PaymentCodeAttemptRow | null> {
    const terminal = ["succeeded", "failed", "reversed", "canceled"].includes(
      status,
    );
    const conditions = [eq(paymentCodeAttempts.id, id)];
    if (allowedCurrentStatuses) {
      conditions.push(
        inArray(paymentCodeAttempts.status, allowedCurrentStatuses),
      );
    }
    const [updated] = await this.db
      .update(paymentCodeAttempts)
      .set({
        ...patch,
        status,
        isActive: terminal ? false : (patch.isActive ?? true),
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning();
    return updated ?? null;
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
    providerConfigSnapshotJson: unknown;
  }> {
    const [row] = await this.db
      .select({
        attempt: paymentCodeAttempts,
        paymentNo: payments.paymentNo,
        orderNo: orders.orderNo,
        machineId: machines.id,
        providerCode: paymentProviders.code,
        providerConfigId: payments.paymentProviderConfigId,
        providerConfigSnapshotJson: payments.providerConfigSnapshotJson,
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
        orderId: paymentCodeAttempts.orderId,
        orderNo: orders.orderNo,
        paymentNo: payments.paymentNo,
        providerCode: paymentProviders.code,
        attemptNo: paymentCodeAttempts.attemptNo,
        providerPaymentNo: paymentCodeAttempts.providerPaymentNo,
        status: paymentCodeAttempts.status,
        authCodeMasked: paymentCodeAttempts.authCodeMasked,
        source: paymentCodeAttempts.source,
        providerTradeNo: paymentCodeAttempts.providerTradeNo,
        providerStatus: paymentCodeAttempts.providerStatus,
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

  toDto(
    row: PaymentCodeAttemptRow & {
      orderNo?: string;
      paymentNo?: string;
      providerCode?: string;
    },
  ): PaymentCodeAttemptDto {
    return {
      id: row.id,
      orderId: row.orderId,
      orderNo: row.orderNo,
      paymentNo: row.paymentNo,
      providerCode: row.providerCode,
      attemptNo: row.attemptNo,
      providerPaymentNo: row.providerPaymentNo,
      status: row.status,
      authCodeMasked: row.authCodeMasked,
      source: row.source,
      providerTradeNo: row.providerTradeNo,
      providerStatus: row.providerStatus,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      manualReason: row.manualReason,
      submittedAt: row.submittedAt,
      lastCheckedAt: row.lastCheckedAt,
      reversedAt: row.reversedAt,
      finishedAt: row.finishedAt,
      createdAt: row.createdAt,
    };
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
    paymentProviderConfigId: string | null;
    providerConfigSnapshotJson: unknown;
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
      providerConfigId: row.paymentProviderConfigId,
      providerConfigSnapshotJson: row.providerConfigSnapshotJson,
    };
  }
}
