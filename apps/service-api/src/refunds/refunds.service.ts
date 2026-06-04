import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  machines,
  orders,
  orderStatusEvents,
  paymentProviders,
  payments,
  refundEvents,
  refundReconciliationAttempts,
  refunds,
  sql,
  type DrizzleClient,
  type DrizzleTransaction,
} from "@vem/db";

import { createBusinessNo } from "../common/business-no.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { projectOrderStatus } from "../orders/order-state-projection";
import { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import { PaymentProviderRegistry } from "../payments/payment-provider.registry";
import { buildStoredEventPayload } from "../payments/payment-redaction.util";
import { reconcileBackoffMs } from "../payments/payment-redaction.util";

export type FullRefundReason = "auto_dispense_failed" | "admin_refund";

const ACTIVE_REFUND_STATUSES = ["created", "processing", "succeeded"] as const;
const MAX_REFUND_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    Reflect.get(error, "code") === "23505"
  );
}

@Injectable()
export class RefundsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RefundsService.name);
  private reconcileTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly paymentProviderConfigService: PaymentProviderConfigService,
  ) {}

  onApplicationShutdown(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  onModuleInit(): void {
    // Reconcile processing refunds every 5 minutes
    this.reconcileTimer = setInterval(
      () => {
        void this.reconcileProcessingRefunds().catch((err: unknown) => {
          this.logger.warn(
            `reconcileProcessingRefunds failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      },
      5 * 60 * 1000,
    );
  }

  private async applyRefundTerminalState(
    tx: DrizzleTransaction,
    input: {
      refundId: string;
      paymentId: string;
      providerId: string;
      orderId: string;
      refundNo: string;
      providerRefundNo: string | null;
      status: "succeeded" | "failed";
      eventType: string;
      providerEventId: string;
      rawPayloadJson: Record<string, unknown>;
      orderEventReason: string;
      failureMessage?: string | null;
      refundedAt?: Date | null;
    },
  ): Promise<void> {
    await tx
      .update(refunds)
      .set({
        status: input.status,
        providerRefundNo: input.providerRefundNo,
        refundedAt:
          input.status === "succeeded"
            ? (input.refundedAt ?? new Date())
            : null,
        updatedAt: new Date(),
      })
      .where(eq(refunds.id, input.refundId));

    await tx
      .insert(refundEvents)
      .values({
        refundId: input.refundId,
        paymentId: input.paymentId,
        providerId: input.providerId,
        eventType: input.eventType,
        providerEventId: input.providerEventId,
        providerRefundNo: input.providerRefundNo,
        status: input.status,
        rawPayloadJson: buildStoredEventPayload(input.rawPayloadJson),
        signatureValid: true,
        handledAt: new Date(),
      })
      .onConflictDoNothing();

    if (input.status === "succeeded") {
      const refundedStatus = projectOrderStatus({
        paymentState: "refunded",
        fulfillmentState: "manual_handling",
      });
      await tx
        .update(payments)
        .set({ status: "refunded", updatedAt: new Date() })
        .where(eq(payments.id, input.paymentId));
      await tx
        .update(orders)
        .set({
          status: refundedStatus,
          paymentState: "refunded",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, input.orderId));
      await tx.insert(orderStatusEvents).values({
        orderId: input.orderId,
        fromStatus: "refund_pending",
        toStatus: refundedStatus,
        reason: input.orderEventReason,
        metadata: {
          refundNo: input.refundNo,
          providerRefundNo: input.providerRefundNo,
        },
      });
      return;
    }

    // failed path: restore payment to succeeded, move order to manual_handling
    const failedRefundStatus = projectOrderStatus({
      paymentState: "paid",
      fulfillmentState: "manual_handling",
    });
    await tx
      .update(payments)
      .set({ status: "succeeded", updatedAt: new Date() })
      .where(eq(payments.id, input.paymentId));
    await tx
      .update(orders)
      .set({
        status: failedRefundStatus,
        paymentState: "paid",
        fulfillmentState: "manual_handling",
        updatedAt: new Date(),
      })
      .where(eq(orders.id, input.orderId));
    await tx.insert(orderStatusEvents).values({
      orderId: input.orderId,
      fromStatus: "refund_pending",
      toStatus: failedRefundStatus,
      reason: input.orderEventReason,
      metadata: {
        refundNo: input.refundNo,
        providerRefundNo: input.providerRefundNo,
        message: input.failureMessage ?? null,
      },
    });
  }

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
          providerId: payments.providerId,
          amountCents: payments.amountCents,
          machineId: machines.id,
          providerConfigId: payments.paymentProviderConfigId,
        })
        .from(orders)
        .innerJoin(payments, eq(payments.id, orders.paymentId))
        .innerJoin(
          paymentProviders,
          eq(paymentProviders.id, payments.providerId),
        )
        .innerJoin(machines, eq(machines.id, orders.machineId))
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
            inArray(refunds.status, [...ACTIVE_REFUND_STATUSES]),
          ),
        )
        .limit(1);
      if (existing) return { refund: existing, row, created: false };

      const failedRefunds = await tx
        .select({ id: refunds.id })
        .from(refunds)
        .where(
          and(
            eq(refunds.orderId, input.orderId),
            eq(refunds.reason, input.reason),
            eq(refunds.status, "failed"),
          ),
        );
      if (failedRefunds.length >= MAX_REFUND_ATTEMPTS) {
        throw new UnprocessableEntityException(
          `Refund has already failed ${MAX_REFUND_ATTEMPTS} times and cannot be retried automatically`,
        );
      }

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
        .set({
          status: "refund_pending",
          paymentState: "refund_pending",
          updatedAt: new Date(),
        })
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

      try {
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
          .returning();
        return { refund, row, created: true };
      } catch (insertError) {
        if (!isUniqueViolation(insertError)) throw insertError;
        const [racedExisting] = await tx
          .select()
          .from(refunds)
          .where(
            and(
              eq(refunds.orderId, input.orderId),
              eq(refunds.reason, input.reason),
              inArray(refunds.status, [...ACTIVE_REFUND_STATUSES]),
            ),
          )
          .limit(1);
        if (!racedExisting)
          throw new ConflictException("Refund conflict without existing row");
        return { refund: racedExisting, row, created: false };
      }
    });

    if (!created.created) return created.refund;

    // Write refund.created event
    await this.db
      .insert(refundEvents)
      .values({
        refundId: created.refund.id,
        paymentId: created.row.paymentId,
        providerId: created.row.providerId,
        eventType: "refund.created",
        providerEventId: `created:${created.refund.refundNo}`,
        status: "created",
        rawPayloadJson: {},
        signatureValid: true,
        handledAt: new Date(),
      })
      .onConflictDoNothing();

    const provider = this.paymentProviderRegistry.get(created.row.providerCode);
    const providerConfig = await this.paymentProviderConfigService
      .resolveForExistingPayment({
        providerCode: created.row.providerCode,
        providerConfigId: created.row.providerConfigId ?? null,
        machineId: created.row.machineId,
      })
      .catch(() => ({
        providerCode: created.row.providerCode,
        merchantNo: null,
        appId: null,
        publicConfigJson: {},
        sensitiveConfigJson: {},
      }));
    try {
      const result = await provider.refundPayment({
        refundNo: created.refund.refundNo,
        paymentNo: created.row.paymentNo,
        providerTradeNo: created.row.providerTradeNo,
        amountCents: created.row.amountCents,
        reason: input.reason,
        config: providerConfig,
      });
      const updated = await this.db.transaction(async (tx) => {
        if (result.status === "succeeded") {
          await this.applyRefundTerminalState(tx, {
            refundId: created.refund.id,
            paymentId: created.row.paymentId,
            providerId: created.row.providerId,
            orderId: input.orderId,
            refundNo: created.refund.refundNo,
            providerRefundNo: result.providerRefundNo,
            status: "succeeded",
            eventType: "refund.succeeded",
            providerEventId: `sync_succeeded:${created.refund.refundNo}`,
            rawPayloadJson: result.rawPayload ?? {},
            orderEventReason: `${input.reason}_succeeded`,
            refundedAt: result.refundedAt ?? null,
          });
          return {
            ...created.refund,
            status: "succeeded" as const,
            providerRefundNo: result.providerRefundNo,
            refundedAt: result.refundedAt ?? null,
          };
        } else if (result.status === "failed") {
          await this.applyRefundTerminalState(tx, {
            refundId: created.refund.id,
            paymentId: created.row.paymentId,
            providerId: created.row.providerId,
            orderId: input.orderId,
            refundNo: created.refund.refundNo,
            providerRefundNo: result.providerRefundNo,
            status: "failed",
            eventType: "refund.failed",
            providerEventId: `sync_failed:${created.refund.refundNo}`,
            rawPayloadJson: result.rawPayload ?? {},
            orderEventReason: `${input.reason}_failed`,
            failureMessage: "provider_returned_failed",
            refundedAt: null,
          });
          return {
            ...created.refund,
            status: "failed" as const,
            providerRefundNo: result.providerRefundNo,
            refundedAt: null,
          };
        } else {
          // processing: update refund status and write processing event
          await tx
            .update(refunds)
            .set({
              status: "processing",
              providerRefundNo: result.providerRefundNo,
              updatedAt: new Date(),
            })
            .where(eq(refunds.id, created.refund.id));
          await tx
            .insert(refundEvents)
            .values({
              refundId: created.refund.id,
              paymentId: created.row.paymentId,
              providerId: created.row.providerId,
              eventType: "refund.processing",
              providerEventId: `sync_processing:${created.refund.refundNo}`,
              providerRefundNo: result.providerRefundNo,
              status: "processing",
              rawPayloadJson: buildStoredEventPayload(result.rawPayload ?? {}),
              signatureValid: true,
              handledAt: new Date(),
            })
            .onConflictDoNothing();
          this.logger.log(
            `Refund ${created.refund.refundNo} is processing, will be reconciled later`,
          );
          return {
            ...created.refund,
            status: "processing" as const,
            providerRefundNo: result.providerRefundNo,
          };
        }
      });
      return updated;
    } catch (error) {
      const failed = await this.db.transaction(async (tx) => {
        await this.applyRefundTerminalState(tx, {
          refundId: created.refund.id,
          paymentId: created.row.paymentId,
          providerId: created.row.providerId,
          orderId: input.orderId,
          refundNo: created.refund.refundNo,
          providerRefundNo: null,
          status: "failed",
          eventType: "refund.failed",
          providerEventId: `sync_failed:${created.refund.refundNo}:${Date.now()}`,
          rawPayloadJson: {
            error: error instanceof Error ? error.message : String(error),
          },
          orderEventReason: `${input.reason}_failed`,
          failureMessage:
            error instanceof Error ? error.message : String(error),
          refundedAt: null,
        });
        return {
          ...created.refund,
          status: "failed" as const,
          providerRefundNo: null,
          refundedAt: null,
        };
      });
      return failed;
    }
  }

  private async getProviderId(providerCode: string): Promise<string> {
    const [row] = await this.db
      .select({ id: paymentProviders.id })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, providerCode))
      .limit(1);
    return row?.id ?? "";
  }

  async reconcileProcessingRefunds(now = new Date()): Promise<void> {
    const processingRefunds = await this.db
      .select({
        id: refunds.id,
        refundNo: refunds.refundNo,
        paymentId: refunds.paymentId,
        orderId: refunds.orderId,
        amountCents: refunds.amountCents,
        providerRefundNo: refunds.providerRefundNo,
        providerCode: paymentProviders.code,
        providerId: paymentProviders.id,
        paymentNo: payments.paymentNo,
        providerTradeNo: payments.providerTradeNo,
        machineId: orders.machineId,
        providerConfigId: payments.paymentProviderConfigId,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(
        and(
          eq(refunds.status, "processing"),
          sql`not exists (
    select 1
    from refund_reconciliation_attempts rra
    where rra.refund_id = ${refunds.id}
      and rra.next_retry_at is not null
      and rra.next_retry_at > ${now}
  )`,
        ),
      )
      .limit(20);

    // oxlint-disable no-await-in-loop -- sequential retry/reconciliation loop; parallel execution would be incorrect here
    for (const refund of processingRefunds) {
      try {
        if (!this.paymentProviderRegistry.has(refund.providerCode)) continue;
        const provider = this.paymentProviderRegistry.get(refund.providerCode);
        if (!provider.queryRefund) continue;

        const [countRow] = await this.db
          .select({ total: count() })
          .from(refundReconciliationAttempts)
          .where(eq(refundReconciliationAttempts.refundId, refund.id));
        const attemptNo = Number(countRow.total) + 1;

        if (attemptNo > 12) {
          await this.db.transaction(async (tx) => {
            await tx.insert(refundReconciliationAttempts).values({
              refundId: refund.id,
              providerId: refund.providerId,
              trigger: "scheduled",
              attemptNo,
              status: "max_attempts_exceeded",
              startedAt: now,
              finishedAt: now,
            });
            await this.applyRefundTerminalState(tx, {
              refundId: refund.id,
              paymentId: refund.paymentId,
              providerId: refund.providerId,
              orderId: refund.orderId,
              refundNo: refund.refundNo,
              providerRefundNo: refund.providerRefundNo,
              status: "failed",
              eventType: "refund.failed",
              providerEventId: `max_attempts_exceeded:${refund.refundNo}:${now.getTime()}`,
              rawPayloadJson: { refundNo: refund.refundNo, attemptNo },
              orderEventReason: "refund_reconcile_max_attempts_exceeded",
              failureMessage: "refund query max attempts exceeded",
              refundedAt: null,
            });
          });
          continue;
        }

        const config = await this.paymentProviderConfigService
          .resolveForExistingPayment({
            providerCode: refund.providerCode,
            providerConfigId: refund.providerConfigId ?? null,
            machineId: refund.machineId,
          })
          .catch(() => ({
            providerCode: refund.providerCode,
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }));

        const [attempt] = await this.db
          .insert(refundReconciliationAttempts)
          .values({
            refundId: refund.id,
            providerId: refund.providerId,
            trigger: "scheduled",
            attemptNo,
            status: "pending",
            startedAt: now,
          })
          .returning({ id: refundReconciliationAttempts.id });

        let result: Awaited<
          ReturnType<NonNullable<typeof provider.queryRefund>>
        >;
        try {
          result = await provider.queryRefund({
            refundNo: refund.refundNo,
            paymentNo: refund.paymentNo,
            providerRefundNo: refund.providerRefundNo,
            providerTradeNo: refund.providerTradeNo,
            amountCents: refund.amountCents,
            config,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const backoffMs = reconcileBackoffMs(attemptNo);
          await this.db
            .update(refundReconciliationAttempts)
            .set({
              status: "network_error",
              errorCode: "query_failed",
              errorMessage: errMsg.slice(0, 500),
              nextRetryAt: new Date(now.getTime() + backoffMs),
              finishedAt: new Date(),
            })
            .where(eq(refundReconciliationAttempts.id, attempt.id));
          continue;
        }

        const refundStatus = result.status;
        if (refundStatus === "processing") {
          const backoffMs = reconcileBackoffMs(attemptNo);
          await this.db
            .update(refundReconciliationAttempts)
            .set({
              status: "processing",
              providerRefundStatus: refundStatus,
              providerRefundNo: result.providerRefundNo ?? null,
              nextRetryAt: new Date(now.getTime() + backoffMs),
              finishedAt: new Date(),
            })
            .where(eq(refundReconciliationAttempts.id, attempt.id));
          continue;
        }

        // Terminal: succeeded or failed
        await this.db.transaction(async (tx) => {
          const dbRefundStatus =
            refundStatus === "succeeded" ? "succeeded" : "failed";
          await this.applyRefundTerminalState(tx, {
            refundId: refund.id,
            paymentId: refund.paymentId,
            providerId: refund.providerId,
            orderId: refund.orderId,
            refundNo: refund.refundNo,
            providerRefundNo:
              result.providerRefundNo ?? refund.providerRefundNo,
            status: dbRefundStatus,
            eventType: `refund.${dbRefundStatus}`,
            providerEventId: `reconcile_${dbRefundStatus}:${refund.refundNo}:${now.getTime()}`,
            rawPayloadJson: {},
            orderEventReason:
              dbRefundStatus === "succeeded"
                ? "reconcile_refund_succeeded"
                : "reconcile_refund_failed",
            failureMessage:
              dbRefundStatus === "failed" ? "provider_returned_failed" : null,
            refundedAt: result.refundedAt ?? null,
          });
        });

        await this.db
          .update(refundReconciliationAttempts)
          .set({
            status: refundStatus === "succeeded" ? "succeeded" : "failed",
            providerRefundStatus: refundStatus,
            providerRefundNo: result.providerRefundNo ?? null,
            finishedAt: new Date(),
          })
          .where(eq(refundReconciliationAttempts.id, attempt.id));
      } catch (err) {
        this.logger.warn(
          `Refund reconciliation failed for ${refund.refundNo}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // oxlint-enable no-await-in-loop
  }

  async applyProviderRefundWebhook(input: {
    providerCode: string;
    refundNo: string | null;
    providerRefundNo: string | null;
    paymentNo: string | null;
    providerEventId: string;
    eventType: string;
    refundStatus: "processing" | "succeeded" | "failed" | "canceled" | null;
    rawPayload: Record<string, unknown>;
    signatureValid: boolean;
  }): Promise<{
    handled: boolean;
    duplicate?: boolean;
    reason?: string;
    providerId?: string;
    refundId?: string;
    paymentId?: string;
  }> {
    if (!input.refundNo && !input.providerRefundNo && !input.paymentNo) {
      return { handled: false, reason: "refund_identifier_missing" };
    }

    const conditions: ReturnType<typeof eq>[] = [
      eq(paymentProviders.code, input.providerCode),
    ];
    if (input.refundNo) conditions.push(eq(refunds.refundNo, input.refundNo));
    if (input.providerRefundNo)
      conditions.push(eq(refunds.providerRefundNo, input.providerRefundNo));
    if (input.paymentNo)
      conditions.push(eq(payments.paymentNo, input.paymentNo));

    const [row] = await this.db
      .select({
        refundId: refunds.id,
        refundNo: refunds.refundNo,
        status: refunds.status,
        paymentId: refunds.paymentId,
        orderId: refunds.orderId,
        providerId: paymentProviders.id,
        providerRefundNo: refunds.providerRefundNo,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(and(...conditions))
      .limit(1);

    if (!row) return { handled: false, reason: "refund_not_found" };

    const eventStatus =
      input.refundStatus === "succeeded"
        ? "succeeded"
        : input.refundStatus === "failed" || input.refundStatus === "canceled"
          ? "failed"
          : "processing";

    const inserted = await this.db
      .insert(refundEvents)
      .values({
        refundId: row.refundId,
        paymentId: row.paymentId,
        providerId: row.providerId,
        eventType: input.eventType,
        providerEventId: input.providerEventId,
        providerRefundNo: input.providerRefundNo ?? row.providerRefundNo,
        status: eventStatus,
        rawPayloadJson: buildStoredEventPayload(input.rawPayload),
        signatureValid: input.signatureValid,
        handledAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: refundEvents.id });

    if (inserted.length === 0) {
      return {
        handled: true,
        duplicate: true,
        providerId: row.providerId,
        refundId: row.refundId,
        paymentId: row.paymentId,
      };
    }

    if (input.refundStatus === "processing" || input.refundStatus === null) {
      await this.db
        .update(refunds)
        .set({
          status: "processing",
          providerRefundNo: input.providerRefundNo ?? row.providerRefundNo,
          updatedAt: new Date(),
        })
        .where(eq(refunds.id, row.refundId));
      return {
        handled: true,
        providerId: row.providerId,
        refundId: row.refundId,
        paymentId: row.paymentId,
      };
    }

    await this.db.transaction(async (tx) => {
      await this.applyRefundTerminalState(tx, {
        refundId: row.refundId,
        paymentId: row.paymentId,
        providerId: row.providerId,
        orderId: row.orderId,
        refundNo: row.refundNo,
        providerRefundNo: input.providerRefundNo ?? row.providerRefundNo,
        status: input.refundStatus === "succeeded" ? "succeeded" : "failed",
        eventType: `refund.webhook.${input.refundStatus}`,
        providerEventId: `state:${input.providerEventId}`,
        rawPayloadJson: input.rawPayload,
        orderEventReason:
          input.refundStatus === "succeeded"
            ? "webhook_refund_succeeded"
            : "webhook_refund_failed",
        failureMessage:
          input.refundStatus === "succeeded"
            ? null
            : "provider_refund_webhook_failed",
      });
    });

    return {
      handled: true,
      providerId: row.providerId,
      refundId: row.refundId,
      paymentId: row.paymentId,
    };
  }
}
