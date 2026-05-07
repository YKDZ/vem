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
  type DrizzleClient,
} from "@vem/db";

import { createBusinessNo } from "../common/business-no.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import { PaymentProviderRegistry } from "../payments/payment-provider.registry";
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
      .resolveForPayment({
        providerCode: created.row.providerCode,
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
          await tx
            .insert(refundEvents)
            .values({
              refundId: created.refund.id,
              paymentId: created.row.paymentId,
              providerId: created.row.providerId,
              eventType: "refund.succeeded",
              providerEventId: `sync_succeeded:${created.refund.refundNo}`,
              providerRefundNo: result.providerRefundNo,
              status: "succeeded",
              rawPayloadJson: {},
              signatureValid: true,
              handledAt: new Date(),
            })
            .onConflictDoNothing();
        } else if (result.status === "processing") {
          // Schedule reconciliation for processing refunds — no extra event needed
          this.logger.log(
            `Refund ${created.refund.refundNo} is processing, will be reconciled later`,
          );
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
        await tx
          .insert(refundEvents)
          .values({
            refundId: created.refund.id,
            paymentId: created.row.paymentId,
            providerId: created.row.providerId,
            eventType: "refund.failed",
            providerEventId: `sync_failed:${created.refund.refundNo}:${Date.now()}`,
            status: "failed",
            rawPayloadJson: {
              error: error instanceof Error ? error.message : String(error),
            },
            signatureValid: true,
            handledAt: new Date(),
          })
          .onConflictDoNothing();
        return [refund];
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
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(eq(refunds.status, "processing"))
      .limit(20);

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
          await this.db.insert(refundReconciliationAttempts).values({
            refundId: refund.id,
            providerId: refund.providerId,
            trigger: "scheduled",
            attemptNo,
            status: "max_attempts_exceeded",
            startedAt: now,
            finishedAt: now,
          });
          continue;
        }

        const config = await this.paymentProviderConfigService
          .resolveForPayment({
            providerCode: refund.providerCode,
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
          await tx
            .update(refunds)
            .set({
              status: dbRefundStatus,
              providerRefundNo:
                result.providerRefundNo ?? refund.providerRefundNo,
              refundedAt: result.refundedAt ?? null,
              updatedAt: new Date(),
            })
            .where(eq(refunds.id, refund.id));

          await tx
            .insert(refundEvents)
            .values({
              refundId: refund.id,
              paymentId: refund.paymentId,
              providerId: refund.providerId,
              eventType: `refund.${dbRefundStatus}`,
              providerEventId: `reconcile_${dbRefundStatus}:${refund.refundNo}:${now.getTime()}`,
              providerRefundNo:
                result.providerRefundNo ?? refund.providerRefundNo,
              status: dbRefundStatus,
              rawPayloadJson: {},
              signatureValid: true,
              handledAt: new Date(),
            })
            .onConflictDoNothing();

          if (dbRefundStatus === "succeeded") {
            await tx
              .update(payments)
              .set({ status: "refunded", updatedAt: new Date() })
              .where(eq(payments.id, refund.paymentId));
            await tx
              .update(orders)
              .set({ status: "refunded", updatedAt: new Date() })
              .where(eq(orders.id, refund.orderId));
            await tx.insert(orderStatusEvents).values({
              orderId: refund.orderId,
              fromStatus: "refund_pending",
              toStatus: "refunded",
              reason: "reconcile_refund_succeeded",
              metadata: {
                refundNo: refund.refundNo,
                providerRefundNo: result.providerRefundNo,
              },
            });
          } else {
            await tx
              .update(orders)
              .set({ status: "manual_handling", updatedAt: new Date() })
              .where(eq(orders.id, refund.orderId));
            await tx.insert(orderStatusEvents).values({
              orderId: refund.orderId,
              fromStatus: "refund_pending",
              toStatus: "manual_handling",
              reason: "reconcile_refund_failed",
            });
          }
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
  }
}
