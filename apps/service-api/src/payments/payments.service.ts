import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  inventoryReservations,
  orderStatusEvents,
  orders,
  paymentEvents,
  paymentProviderConfigs,
  paymentProviders,
  paymentReconciliationAttempts,
  paymentWebhookAttempts,
  payments,
  refunds,
  sql,
  type DrizzleClient,
  type DrizzleTransaction,
  type SQL,
} from "@vem/db";
import {
  pageQuerySchema,
  paymentEventQuerySchema,
  paymentProviderQuerySchema,
  paymentQuerySchema,
  paymentReconciliationAttemptQuerySchema,
  paymentWebhookAttemptQuerySchema,
  refundQuerySchema,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
  upsertPaymentProviderConfigSchema,
  alipayPublicConfigSchema,
  wechatPayPublicConfigSchema,
} from "@vem/shared";
import { z } from "zod";

import type { PaymentProviderRuntimeConfig } from "./payment-provider.interface";

import { AuditService } from "../audit/audit.service";
import { getOffset, toPageResult } from "../common/pagination.util";
import { AppConfigService } from "../config/app-config.service";
import { isEncryptedJson } from "../crypto/encrypted-json.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { InventoryService } from "../inventory/inventory.service";
import { RefundsService } from "../refunds/refunds.service";
import { VendingService } from "../vending/vending.service";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";
import {
  buildStoredEventPayload,
  reconcileBackoffMs,
  sha256Hex,
} from "./payment-redaction.util";
import { PaymentWebhookAttemptRecorderService } from "./payment-webhook-attempt-recorder.service";

type PaymentQuery = z.infer<typeof paymentQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type PaymentProviderQuery = z.infer<typeof paymentProviderQuerySchema>;
type UpdatePaymentProviderInput = z.infer<typeof updatePaymentProviderSchema>;
type UpdatePaymentProviderConfigInput = z.infer<
  typeof updatePaymentProviderConfigSchema
>;
type UpsertPaymentProviderConfigInput = z.infer<
  typeof upsertPaymentProviderConfigSchema
>;
type PaymentEventQuery = z.infer<typeof paymentEventQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type WebhookAttemptQuery = z.infer<typeof paymentWebhookAttemptQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type ReconciliationAttemptQuery = z.infer<
  typeof paymentReconciliationAttemptQuerySchema
> &
  z.infer<typeof pageQuerySchema>;
type RefundListQuery = z.infer<typeof refundQuerySchema> &
  z.infer<typeof pageQuerySchema>;

type ProviderWebhookBusinessValidation =
  | { ok: true }
  | { ok: false; reason: string };

type PaymentForWebhookValidation = {
  paymentNo: string;
  amountCents: number;
  machineId: string;
};

function rawString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function alipayAmountFromCents(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

function readTimeoutCompensationSeconds(publicConfigJson: unknown): number {
  if (
    typeof publicConfigJson !== "object" ||
    publicConfigJson === null ||
    !("timeoutCompensationSeconds" in publicConfigJson)
  ) {
    return 120;
  }
  const { timeoutCompensationSeconds: value } = publicConfigJson as {
    timeoutCompensationSeconds: unknown;
  };
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 120;
}

@Injectable()
export class PaymentsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentsService.name);
  private expireInterval?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly inventoryService: InventoryService,
    private readonly vendingService: VendingService,
    private readonly config: AppConfigService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly auditService: AuditService,
    private readonly paymentConfigSecrets: PaymentConfigSecretService,
    private readonly paymentProviderConfigService: PaymentProviderConfigService,
    private readonly webhookAttemptRecorder: PaymentWebhookAttemptRecorderService,
    private readonly refundsService: RefundsService,
  ) {}

  private assertMockPaymentEnabled(): void {
    if (!this.config.paymentMockEnabled) {
      throw new NotFoundException("Mock payment endpoint is disabled");
    }
  }

  onModuleInit(): void {
    this.expireInterval = setInterval(() => {
      void this.expireOverduePayments().catch((error: unknown) => {
        this.logger.warn(
          `expireOverduePayments failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 60_000);
  }

  onApplicationShutdown(): void {
    if (this.expireInterval) {
      clearInterval(this.expireInterval);
      this.expireInterval = undefined;
    }
  }

  private async releaseActiveReservationsForOrder(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      reason: "payment_failed" | "payment_expired" | "canceled";
    },
  ): Promise<void> {
    const reservations = await tx
      .select({
        inventoryId: inventoryReservations.inventoryId,
        quantity: inventoryReservations.quantity,
      })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.orderId, input.orderId),
          eq(inventoryReservations.status, "active"),
        ),
      );

    await reservations.reduce<Promise<void>>(async (previous, reservation) => {
      await previous;
      await this.inventoryService.releaseReservation(tx, {
        orderId: input.orderId,
        inventoryId: reservation.inventoryId,
        quantity: reservation.quantity,
        reason: input.reason,
      });
    }, Promise.resolve());
  }

  async listPayments(query: PaymentQuery) {
    const filters: SQL[] = [];
    if (query.orderNo) {
      filters.push(eq(orders.orderNo, query.orderNo));
    }
    if (query.paymentNo) {
      filters.push(eq(payments.paymentNo, query.paymentNo));
    }
    if (query.providerCode) {
      filters.push(eq(paymentProviders.code, query.providerCode));
    }
    if (query.status) {
      filters.push(eq(payments.status, query.status));
    }
    if (query.createdFrom) {
      filters.push(
        sql`${payments.createdAt} >= ${new Date(query.createdFrom)}`,
      );
    }
    if (query.createdTo) {
      filters.push(sql`${payments.createdAt} <= ${new Date(query.createdTo)}`);
    }
    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const items = await this.db
      .select({
        id: payments.id,
        paymentNo: payments.paymentNo,
        orderId: payments.orderId,
        orderNo: orders.orderNo,
        providerCode: paymentProviders.code,
        method: payments.method,
        status: payments.status,
        amountCents: payments.amountCents,
        paymentUrl: payments.paymentUrl,
        expiresAt: payments.expiresAt,
        paidAt: payments.paidAt,
        failedReason: payments.failedReason,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(whereClause)
      .orderBy(desc(payments.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async markMockSucceeded(paymentNo: string, adminUserId: string | null) {
    this.assertMockPaymentEnabled();
    const transition = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          paymentId: payments.id,
          paymentNo: payments.paymentNo,
          paymentStatus: payments.status,
          providerId: payments.providerId,
          providerCode: paymentProviders.code,
          orderId: orders.id,
          orderStatus: orders.status,
        })
        .from(payments)
        .innerJoin(
          paymentProviders,
          eq(paymentProviders.id, payments.providerId),
        )
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(eq(payments.paymentNo, paymentNo));
      if (!row) {
        throw new NotFoundException("Payment not found");
      }
      if (row.providerCode !== "mock") {
        throw new ConflictException("Only mock provider can use this endpoint");
      }

      const inserted = await tx
        .insert(paymentEvents)
        .values({
          paymentId: row.paymentId,
          providerId: row.providerId,
          eventType: "mock.payment.succeeded",
          providerEventId: `mock:succeed:${paymentNo}`,
          rawPayloadJson: buildStoredEventPayload({
            paymentNo,
            event: "succeed",
          }),
          signatureValid: true,
          handledAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: paymentEvents.id });
      if (inserted.length === 0) {
        return {
          paymentNo: row.paymentNo,
          paymentId: row.paymentId,
          status: row.paymentStatus,
          orderId: row.orderId,
          alreadyHandled: true,
        };
      }

      if (row.paymentStatus !== "succeeded") {
        await tx
          .update(payments)
          .set({
            status: "succeeded",
            paidAt: new Date(),
            failedReason: null,
            updatedAt: new Date(),
          })
          .where(eq(payments.id, row.paymentId));
      }

      if (row.orderStatus !== "paid" && row.orderStatus !== "dispensing") {
        await tx
          .update(orders)
          .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
          .where(eq(orders.id, row.orderId));
        await tx.insert(orderStatusEvents).values({
          orderId: row.orderId,
          fromStatus: row.orderStatus,
          toStatus: "paid",
          reason: "payment_succeeded",
        });
      }

      const reservations = await tx
        .select({
          inventoryId: inventoryReservations.inventoryId,
          quantity: inventoryReservations.quantity,
        })
        .from(inventoryReservations)
        .where(
          and(
            eq(inventoryReservations.orderId, row.orderId),
            eq(inventoryReservations.status, "active"),
          ),
        );

      await reservations.reduce<Promise<void>>(
        async (previous, reservation) => {
          await previous;
          await this.inventoryService.confirmReservation(tx, {
            orderId: row.orderId,
            inventoryId: reservation.inventoryId,
            quantity: reservation.quantity,
          });
        },
        Promise.resolve(),
      );

      return {
        paymentNo: row.paymentNo,
        paymentId: row.paymentId,
        status: "succeeded",
        orderId: row.orderId,
        alreadyHandled: false,
      };
    });

    if (!transition.alreadyHandled) {
      await this.vendingService.createAndDispatchCommands(transition.orderId);
      await this.auditService.record({
        adminUserId,
        action: "payments.mock.succeed",
        resourceType: "payment",
        resourceId: transition.paymentId,
        afterJson: {
          paymentNo: transition.paymentNo,
          orderId: transition.orderId,
          alreadyHandled: transition.alreadyHandled,
        },
      });
    }

    return transition;
  }

  async markMockFailed(
    paymentNo: string,
    reason: string,
    adminUserId: string | null,
  ) {
    this.assertMockPaymentEnabled();
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          paymentId: payments.id,
          paymentNo: payments.paymentNo,
          paymentStatus: payments.status,
          providerId: payments.providerId,
          providerCode: paymentProviders.code,
          orderId: orders.id,
          orderStatus: orders.status,
        })
        .from(payments)
        .innerJoin(
          paymentProviders,
          eq(paymentProviders.id, payments.providerId),
        )
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(eq(payments.paymentNo, paymentNo));
      if (!row) {
        throw new NotFoundException("Payment not found");
      }
      if (row.providerCode !== "mock") {
        throw new ConflictException("Only mock provider can use this endpoint");
      }

      const inserted = await tx
        .insert(paymentEvents)
        .values({
          paymentId: row.paymentId,
          providerId: row.providerId,
          eventType: "mock.payment.failed",
          providerEventId: `mock:fail:${paymentNo}`,
          rawPayloadJson: buildStoredEventPayload({
            paymentNo,
            event: "fail",
            reason,
          }),
          signatureValid: true,
          handledAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: paymentEvents.id });
      if (inserted.length === 0) {
        return {
          paymentNo: row.paymentNo,
          paymentId: row.paymentId,
          status: row.paymentStatus,
          orderId: row.orderId,
          alreadyHandled: true,
        };
      }

      await tx
        .update(payments)
        .set({ status: "failed", failedReason: reason, updatedAt: new Date() })
        .where(eq(payments.id, row.paymentId));

      if (row.orderStatus !== "canceled") {
        await tx
          .update(orders)
          .set({
            status: "canceled",
            canceledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(orders.id, row.orderId));
        await tx.insert(orderStatusEvents).values({
          orderId: row.orderId,
          fromStatus: row.orderStatus,
          toStatus: "canceled",
          reason: "payment_failed",
        });
      }

      await this.releaseActiveReservationsForOrder(tx, {
        orderId: row.orderId,
        reason: "payment_failed",
      });

      return {
        paymentNo: row.paymentNo,
        paymentId: row.paymentId,
        status: "failed",
        orderId: row.orderId,
        alreadyHandled: false,
      };
    });

    if (!result.alreadyHandled) {
      await this.auditService.record({
        adminUserId,
        action: "payments.mock.fail",
        resourceType: "payment",
        resourceId: result.paymentId,
        afterJson: {
          paymentNo: result.paymentNo,
          orderId: result.orderId,
          reason,
          alreadyHandled: result.alreadyHandled,
        },
      });
    }

    return result;
  }

  async expireOverduePayments(
    now = new Date(),
  ): Promise<{ processed: number }> {
    const overduePayments = await this.db
      .select({
        paymentId: payments.id,
        paymentNo: payments.paymentNo,
        providerId: payments.providerId,
        providerCode: paymentProviders.code,
        providerTradeNo: payments.providerTradeNo,
        orderId: orders.id,
        orderStatus: orders.status,
        machineId: orders.machineId,
        expiresAt: payments.expiresAt,
        providerConfigId: payments.paymentProviderConfigId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .leftJoin(
        paymentProviderConfigs,
        and(
          eq(paymentProviderConfigs.providerId, payments.providerId),
          eq(paymentProviderConfigs.machineId, orders.machineId),
        ),
      )
      .where(
        and(
          inArray(payments.status, ["created", "pending", "processing"]),
          sql`${payments.expiresAt} IS NOT NULL`,
          gt(payments.expiresAt, new Date(0)),
          sql`${payments.expiresAt} < ${now}`,
        ),
      );

    const results = await Promise.all(
      overduePayments.map(async (payment): Promise<boolean> => {
        // Query-before-close: if a real provider, try to query payment status first
        if (this.paymentProviderRegistry.has(payment.providerCode)) {
          try {
            const provider = this.paymentProviderRegistry.get(
              payment.providerCode,
            );
            const config = await this.paymentProviderConfigService
              .resolveForExistingPayment({
                providerCode: payment.providerCode,
                providerConfigId: payment.providerConfigId,
                machineId: payment.machineId,
              })
              .catch(() => ({
                providerCode: payment.providerCode,
                merchantNo: null,
                appId: null,
                publicConfigJson: {} as Record<string, unknown>,
                sensitiveConfigJson: {} as Record<string, unknown>,
              }));
            const queryResult = await provider.queryPayment({
              paymentNo: payment.paymentNo,
              providerTradeNo: payment.providerTradeNo,
              config,
            });

            if (queryResult.status === "succeeded") {
              const providerEventId = `expire_query:${payment.paymentNo}:succeeded:${now.getTime()}`;
              const applied = await this.applyPaymentStatusUpdate(
                payment.paymentId,
                payment.orderId,
                "succeeded",
                providerEventId,
                queryResult.providerTradeNo,
                queryResult.rawPayload,
                payment.providerId,
                queryResult.paidAt ?? now,
                null,
              );
              if (applied) {
                await this.vendingService
                  .createAndDispatchCommands(payment.orderId)
                  .catch((_err: unknown) => {
                    // ignore dispatch errors
                  });
              }
              return applied;
            }

            // If still pending/processing, check compensation window
            const compensationSeconds = readTimeoutCompensationSeconds(
              payment.publicConfigJson,
            );
            const compensationMs = compensationSeconds * 1000;
            const expiresAtMs = payment.expiresAt
              ? payment.expiresAt.getTime()
              : 0;
            if (now.getTime() < expiresAtMs + compensationMs) {
              // Within compensation window — skip closing for now
              return false;
            }

            // Past compensation window — cancel with provider
            if (
              queryResult.status === "pending" ||
              queryResult.status === "processing"
            ) {
              await provider.cancelPayment({
                paymentNo: payment.paymentNo,
                providerTradeNo: payment.providerTradeNo,
                config,
              });
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            const attemptNo = await this.nextPaymentReconciliationAttemptNo(
              payment.paymentId,
              "expire_compensation",
            );
            await this.db.insert(paymentReconciliationAttempts).values({
              paymentId: payment.paymentId,
              providerId: payment.providerId,
              trigger: "expire_compensation",
              attemptNo,
              status: "network_error",
              errorCode: "expire_compensation_failed",
              errorMessage: message.slice(0, 500),
              nextRetryAt: new Date(now.getTime() + reconcileBackoffMs(1)),
              startedAt: now,
              finishedAt: new Date(),
            });
            await this.db
              .insert(paymentEvents)
              .values({
                paymentId: payment.paymentId,
                providerId: payment.providerId,
                eventType: "payment.expire_compensation_failed",
                providerEventId: `expire_compensation_failed:${payment.paymentNo}:${now.getTime()}`,
                rawPayloadJson: buildStoredEventPayload({
                  paymentNo: payment.paymentNo,
                  providerCode: payment.providerCode,
                  message,
                }),
                signatureValid: true,
                handledAt: new Date(),
              })
              .onConflictDoNothing();
            return false;
          }
        }

        // Expire locally and release inventory
        return await this.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(paymentEvents)
            .values({
              paymentId: payment.paymentId,
              providerId: payment.providerId,
              eventType: "payment.expired",
              providerEventId: `expired:${payment.paymentNo}`,
              rawPayloadJson: buildStoredEventPayload({
                paymentNo: payment.paymentNo,
                event: "expired",
              }),
              signatureValid: true,
              handledAt: new Date(),
            })
            .onConflictDoNothing()
            .returning({ id: paymentEvents.id });
          if (inserted.length === 0) {
            return false;
          }

          await tx
            .update(payments)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(payments.id, payment.paymentId));

          if (payment.orderStatus !== "payment_expired") {
            await tx
              .update(orders)
              .set({ status: "payment_expired", updatedAt: new Date() })
              .where(eq(orders.id, payment.orderId));
            await tx.insert(orderStatusEvents).values({
              orderId: payment.orderId,
              fromStatus: payment.orderStatus,
              toStatus: "payment_expired",
              reason: "payment_expired",
            });
          }

          await this.releaseActiveReservationsForOrder(tx, {
            orderId: payment.orderId,
            reason: "payment_expired",
          });

          return true;
        });
      }),
    );

    return { processed: results.filter(Boolean).length };
  }

  async listProviders(query: PaymentProviderQuery) {
    const filters: SQL[] = [];
    if (query.code) filters.push(eq(paymentProviders.code, query.code));
    if (query.type) filters.push(eq(paymentProviders.type, query.type));
    if (query.status) filters.push(eq(paymentProviders.status, query.status));
    return await this.db
      .select()
      .from(paymentProviders)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(paymentProviders.code);
  }

  async updateProvider(id: string, input: UpdatePaymentProviderInput) {
    const [updated] = await this.db
      .update(paymentProviders)
      .set({
        name: input.name,
        status: input.status,
        capabilities: input.capabilities,
        updatedAt: new Date(),
      })
      .where(eq(paymentProviders.id, id))
      .returning();
    if (!updated) throw new NotFoundException("Payment provider not found");
    return updated;
  }

  async listProviderConfigs() {
    const rows = await this.db
      .select({
        id: paymentProviderConfigs.id,
        providerId: paymentProviderConfigs.providerId,
        providerCode: paymentProviders.code,
        providerName: paymentProviders.name,
        machineId: paymentProviderConfigs.machineId,
        merchantNo: paymentProviderConfigs.merchantNo,
        appId: paymentProviderConfigs.appId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
        status: paymentProviderConfigs.status,
        updatedByAdminUserId: paymentProviderConfigs.updatedByAdminUserId,
        createdAt: paymentProviderConfigs.createdAt,
        updatedAt: paymentProviderConfigs.updatedAt,
      })
      .from(paymentProviderConfigs)
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentProviderConfigs.providerId),
      )
      .orderBy(paymentProviders.code, paymentProviderConfigs.machineId);

    return rows.map((row) => {
      const encryptedJson = isEncryptedJson(row.configEncryptedJson)
        ? row.configEncryptedJson
        : null;
      const decryptedKeys = encryptedJson
        ? this.paymentConfigSecrets.decrypt(encryptedJson)
        : null;

      return {
        id: row.id,
        providerId: row.providerId,
        providerCode: row.providerCode,
        providerName: row.providerName,
        machineId: row.machineId,
        merchantNo: row.merchantNo,
        appId: row.appId,
        publicConfigJson: row.publicConfigJson,
        derivedNotifyUrl: this.config.buildPaymentNotifyUrl(row.providerCode),
        secretStatusJson: this.paymentConfigSecrets.summarize(
          decryptedKeys,
          row.updatedAt,
        ),
        status: row.status,
        updatedByAdminUserId: row.updatedByAdminUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async updateProviderConfig(
    id: string,
    adminUserId: string,
    input: UpdatePaymentProviderConfigInput,
  ) {
    const [existing] = await this.db
      .select({
        id: paymentProviderConfigs.id,
        providerId: paymentProviderConfigs.providerId,
        machineId: paymentProviderConfigs.machineId,
        merchantNo: paymentProviderConfigs.merchantNo,
        appId: paymentProviderConfigs.appId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
        status: paymentProviderConfigs.status,
      })
      .from(paymentProviderConfigs)
      .where(eq(paymentProviderConfigs.id, id))
      .limit(1);
    if (!existing)
      throw new NotFoundException("Payment provider config not found");

    const providerRow = await this.db
      .select({ code: paymentProviders.code })
      .from(paymentProviders)
      .where(eq(paymentProviders.id, existing.providerId))
      .limit(1);
    const providerCode = providerRow[0]?.code ?? "unknown";

    const nextStatus = input.status ?? existing.status;
    const nextPublicConfig = this.normalizeProviderPublicConfig(providerCode, {
      ...(existing.publicConfigJson as Record<string, unknown>),
      ...(input.publicConfigJson ?? {}),
    });

    const encryptedJson = isEncryptedJson(existing.configEncryptedJson)
      ? existing.configEncryptedJson
      : null;
    const existingSensitive = encryptedJson
      ? this.paymentConfigSecrets.decrypt(encryptedJson)
      : {};

    if (nextStatus === "enabled") {
      this.assertProviderConfigComplete({
        providerCode,
        status: nextStatus,
        merchantNo: input.merchantNo ?? existing.merchantNo,
        appId: input.appId ?? existing.appId,
        publicConfigJson: nextPublicConfig,
        sensitiveConfigJson: existingSensitive,
      });
    }

    const beforeAuditJson = this.sanitizeProviderConfigForAudit({
      providerCode,
      machineId: existing.machineId,
      merchantNo: existing.merchantNo,
      appId: existing.appId,
      publicConfigJson: existing.publicConfigJson as Record<string, unknown>,
      status: existing.status,
      sensitiveConfigJson: existingSensitive,
    });

    const [updated] = await this.db
      .update(paymentProviderConfigs)
      .set({
        merchantNo: input.merchantNo,
        appId: input.appId,
        publicConfigJson: nextPublicConfig,
        status: input.status,
        updatedByAdminUserId: adminUserId,
        updatedAt: new Date(),
      })
      .where(eq(paymentProviderConfigs.id, id))
      .returning();
    if (!updated)
      throw new NotFoundException("Payment provider config not found");

    const afterAuditJson = this.sanitizeProviderConfigForAudit({
      providerCode,
      machineId: existing.machineId,
      merchantNo: updated.merchantNo,
      appId: updated.appId,
      publicConfigJson: nextPublicConfig,
      status: updated.status,
      sensitiveConfigJson: existingSensitive,
    });

    await this.auditService.record({
      adminUserId,
      action: "payments.provider_config.update",
      resourceType: "payment_provider_config",
      resourceId: updated.id,
      beforeJson: beforeAuditJson,
      afterJson: afterAuditJson,
    });

    return updated;
  }

  private mergeSensitiveConfig(
    existing: Record<string, unknown>,
    patch: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!patch) return existing;
    const next = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    return next;
  }

  private assertProviderConfigComplete(input: {
    providerCode: string;
    status: string;
    merchantNo: string | null | undefined;
    appId: string | null | undefined;
    publicConfigJson: Record<string, unknown>;
    sensitiveConfigJson: Record<string, unknown>;
  }): void {
    if (input.status !== "enabled") return;

    const missing: string[] = [];
    const requireString = (source: Record<string, unknown>, key: string) => {
      if (typeof source[key] !== "string" || source[key].trim().length === 0) {
        missing.push(key);
      }
    };

    if (!input.merchantNo) missing.push("merchantNo");
    if (!input.appId) missing.push("appId");

    if (input.providerCode === "wechat_pay") {
      // merchantCertificateSerialNo or deprecated certificateSerialNo
      const hasMerchantSerial =
        (typeof input.publicConfigJson["merchantCertificateSerialNo"] ===
          "string" &&
          input.publicConfigJson["merchantCertificateSerialNo"].length > 0) ||
        (typeof input.publicConfigJson["certificateSerialNo"] === "string" &&
          input.publicConfigJson["certificateSerialNo"].length > 0);
      if (!hasMerchantSerial) missing.push("merchantCertificateSerialNo");
      requireString(input.publicConfigJson, "platformCertificateSerialNo");
      requireString(input.sensitiveConfigJson, "apiV3Key");
      requireString(input.sensitiveConfigJson, "privateKeyPem");
      // platformCertificatePem or platformPublicKeyPem must be present
      const hasPlatformKey =
        (typeof input.sensitiveConfigJson["platformCertificatePem"] ===
          "string" &&
          input.sensitiveConfigJson["platformCertificatePem"].length > 0) ||
        (typeof input.sensitiveConfigJson["platformPublicKeyPem"] ===
          "string" &&
          input.sensitiveConfigJson["platformPublicKeyPem"].length > 0);
      if (!hasPlatformKey)
        missing.push("platformCertificatePem or platformPublicKeyPem");
    } else if (input.providerCode === "alipay") {
      requireString(input.publicConfigJson, "gatewayUrl");
      requireString(input.publicConfigJson, "keyType");
      requireString(input.sensitiveConfigJson, "privateKeyPem");
      requireString(input.sensitiveConfigJson, "appCertPem");
      requireString(input.sensitiveConfigJson, "alipayPublicCertPem");
      requireString(input.sensitiveConfigJson, "alipayRootCertPem");
    }

    if (missing.length > 0) {
      throw new ConflictException(
        `Payment provider config is incomplete: ${missing.join(", ")}`,
      );
    }
  }

  private normalizeProviderPublicConfig(
    providerCode: string,
    publicConfigJson: Record<string, unknown>,
  ): Record<string, unknown> {
    if (providerCode === "wechat_pay") {
      return wechatPayPublicConfigSchema.parse(publicConfigJson);
    }
    if (providerCode === "alipay") {
      return alipayPublicConfigSchema.parse(publicConfigJson);
    }
    return publicConfigJson;
  }

  private sanitizeProviderConfigForAudit(input: {
    providerCode: string;
    machineId: string | null | undefined;
    merchantNo: string | null | undefined;
    appId: string | null | undefined;
    publicConfigJson: Record<string, unknown>;
    status: string;
    sensitiveConfigJson: Record<string, unknown>;
  }) {
    return {
      providerCode: input.providerCode,
      machineId: input.machineId,
      merchantNo: input.merchantNo,
      appId: input.appId,
      publicConfigJson: input.publicConfigJson,
      status: input.status,
      secretKeys: Object.keys(input.sensitiveConfigJson).sort(),
    };
  }

  async upsertProviderConfig(
    adminUserId: string,
    input: UpsertPaymentProviderConfigInput,
  ) {
    const [provider] = await this.db
      .select({ id: paymentProviders.id })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, input.providerCode))
      .limit(1);
    if (!provider)
      throw new NotFoundException(
        `Payment provider '${input.providerCode}' not found`,
      );

    const machineId = input.machineId ?? null;
    const existingRows = await this.db
      .select({
        id: paymentProviderConfigs.id,
        merchantNo: paymentProviderConfigs.merchantNo,
        appId: paymentProviderConfigs.appId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
        status: paymentProviderConfigs.status,
      })
      .from(paymentProviderConfigs)
      .where(
        and(
          eq(paymentProviderConfigs.providerId, provider.id),
          machineId === null
            ? sql`${paymentProviderConfigs.machineId} IS NULL`
            : eq(paymentProviderConfigs.machineId, machineId),
        ),
      )
      .limit(1);

    const existingRow = existingRows[0];

    const existingSensitive: Record<string, unknown> = existingRow
      ? isEncryptedJson(existingRow.configEncryptedJson)
        ? this.paymentConfigSecrets.decrypt(existingRow.configEncryptedJson)
        : {}
      : {};

    const mergedSensitive = this.mergeSensitiveConfig(
      existingSensitive,
      input.sensitiveConfigJson as Record<string, unknown> | undefined,
    );

    const nextStatus = input.status ?? existingRow?.status ?? "enabled";

    const basePublicConfig: Record<string, unknown> = {
      ...(existingRow?.publicConfigJson ?? {}),
      ...(input.publicConfigJson ?? {}),
    };
    const nextPublicConfig = (() => {
      try {
        return this.normalizeProviderPublicConfig(
          input.providerCode,
          basePublicConfig,
        );
      } catch {
        return basePublicConfig;
      }
    })();

    this.assertProviderConfigComplete({
      providerCode: input.providerCode,
      status: nextStatus,
      merchantNo: input.merchantNo ?? existingRow?.merchantNo,
      appId: input.appId ?? existingRow?.appId,
      publicConfigJson: nextPublicConfig,
      sensitiveConfigJson: mergedSensitive,
    });

    const newEncryptedJson = this.paymentConfigSecrets.encrypt(mergedSensitive);

    const beforeAuditJson = existingRow
      ? this.sanitizeProviderConfigForAudit({
          providerCode: input.providerCode,
          machineId,
          merchantNo: existingRow.merchantNo,
          appId: existingRow.appId,
          publicConfigJson: existingRow.publicConfigJson as Record<
            string,
            unknown
          >,
          status: existingRow.status,
          sensitiveConfigJson: existingSensitive,
        })
      : undefined;

    let saved: { id: string } & Record<string, unknown>;

    if (existingRow) {
      const [updated] = await this.db
        .update(paymentProviderConfigs)
        .set({
          merchantNo: input.merchantNo ?? existingRow.merchantNo,
          appId: input.appId ?? existingRow.appId,
          publicConfigJson: nextPublicConfig,
          configEncryptedJson: newEncryptedJson,
          status: nextStatus,
          updatedByAdminUserId: adminUserId,
          updatedAt: new Date(),
        })
        .where(eq(paymentProviderConfigs.id, existingRow.id))
        .returning();
      saved = updated as typeof saved;
    } else {
      const [inserted] = await this.db
        .insert(paymentProviderConfigs)
        .values({
          providerId: provider.id,
          machineId,
          merchantNo: input.merchantNo,
          appId: input.appId,
          publicConfigJson: nextPublicConfig,
          configEncryptedJson: newEncryptedJson,
          status: nextStatus,
          updatedByAdminUserId: adminUserId,
        })
        .returning();
      saved = inserted as typeof saved;
    }

    const afterAuditJson = this.sanitizeProviderConfigForAudit({
      providerCode: input.providerCode,
      machineId,
      merchantNo: input.merchantNo ?? existingRow?.merchantNo,
      appId: input.appId ?? existingRow?.appId,
      publicConfigJson: nextPublicConfig,
      status: nextStatus,
      sensitiveConfigJson: mergedSensitive,
    });

    await this.auditService.record({
      adminUserId,
      action: existingRow
        ? "payments.provider_config.update"
        : "payments.provider_config.create",
      resourceType: "payment_provider_config",
      resourceId: saved.id,
      beforeJson: beforeAuditJson,
      afterJson: afterAuditJson,
    });

    return saved;
  }

  async listProviderNotifyUrlChecks() {
    return await Promise.all(
      ["wechat_pay", "alipay"].map(async (providerCode) => {
        const staticCheck =
          this.config.getPaymentNotifyUrlStaticCheck(providerCode);
        const healthUrl = new URL(staticCheck.notifyUrl);
        healthUrl.pathname = "/api/health";
        healthUrl.search = "";
        const checkedAt = new Date().toISOString();
        try {
          const response = await fetch(healthUrl.toString(), {
            method: "GET",
            signal: AbortSignal.timeout(2_000),
          });
          return {
            ...staticCheck,
            reachable: response.ok,
            statusCode: response.status,
            errorCode: response.ok ? null : "health_check_failed",
            checkedAt,
          };
        } catch (error) {
          return {
            ...staticCheck,
            reachable: false,
            statusCode: null,
            errorCode:
              error instanceof Error && error.name === "TimeoutError"
                ? "timeout"
                : "network_error",
            checkedAt,
          };
        }
      }),
    );
  }

  async listPaymentEvents(query: PaymentEventQuery) {
    const filters: SQL[] = [];
    if (query.providerCode)
      filters.push(eq(paymentProviders.code, query.providerCode));
    if (query.paymentNo) filters.push(eq(payments.paymentNo, query.paymentNo));
    if (query.eventType)
      filters.push(eq(paymentEvents.eventType, query.eventType));
    if (query.signatureValid !== undefined)
      filters.push(eq(paymentEvents.signatureValid, query.signatureValid));
    if (query.createdFrom)
      filters.push(
        sql`${paymentEvents.createdAt} >= ${new Date(query.createdFrom)}`,
      );
    if (query.createdTo)
      filters.push(
        sql`${paymentEvents.createdAt} <= ${new Date(query.createdTo)}`,
      );
    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const items = await this.db
      .select({
        id: paymentEvents.id,
        paymentId: paymentEvents.paymentId,
        paymentNo: payments.paymentNo,
        providerId: paymentEvents.providerId,
        providerCode: paymentProviders.code,
        eventType: paymentEvents.eventType,
        providerEventId: paymentEvents.providerEventId,
        signatureValid: paymentEvents.signatureValid,
        handledAt: paymentEvents.handledAt,
        createdAt: paymentEvents.createdAt,
      })
      .from(paymentEvents)
      .innerJoin(payments, eq(payments.id, paymentEvents.paymentId))
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentEvents.providerId),
      )
      .where(whereClause)
      .orderBy(desc(paymentEvents.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(paymentEvents)
      .innerJoin(payments, eq(payments.id, paymentEvents.paymentId))
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentEvents.providerId),
      )
      .where(whereClause);
    return toPageResult(items, query, Number(totalRow.total));
  }

  async handleProviderWebhook(
    providerCode: string,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
    rawBodyText?: string,
    remoteIp: string | null = null,
    userAgent: string | null = null,
  ) {
    const computedRawBodyText =
      rawBodyText ?? (typeof body === "string" ? body : JSON.stringify(body));

    // Start attempt record before anything else
    const attemptId = await this.webhookAttemptRecorder.start({
      providerCode,
      headers,
      body,
      rawBodyText: computedRawBodyText,
      remoteIp,
      userAgent,
    });

    let provider;
    try {
      provider = this.paymentProviderRegistry.get(providerCode);
    } catch {
      await this.webhookAttemptRecorder.finish({
        attemptId,
        eventKind: "unknown",
        handled: false,
        failureReason: "provider_not_found",
      });
      throw new NotFoundException("Payment provider not found");
    }

    if (!provider.handleWebhook) {
      await this.webhookAttemptRecorder.finish({
        attemptId,
        eventKind: "unknown",
        handled: false,
        failureReason: "webhook_not_supported",
      });
      throw new NotFoundException("Payment webhook is not supported");
    }

    const candidateConfigs = await this.paymentProviderConfigService
      .listCandidateConfigsForProvider(providerCode)
      .catch(() => []);

    let webhook: Awaited<
      ReturnType<NonNullable<typeof provider.handleWebhook>>
    >;
    try {
      webhook = await provider.handleWebhook({
        headers,
        body,
        rawBodyText: computedRawBodyText,
        candidateConfigs,
      });
    } catch (err) {
      const isUnauthorized =
        err instanceof Error &&
        (err.constructor.name === "UnauthorizedException" ||
          err.message.toLowerCase().includes("signature") ||
          err.message.toLowerCase().includes("unauthorized"));
      await this.webhookAttemptRecorder.finish({
        attemptId,
        eventKind: "unknown",
        signatureValid: false,
        handled: false,
        failureReason: isUnauthorized ? "signature_invalid" : "invalid_body",
        errorCode: isUnauthorized ? "signature_invalid" : "provider_error",
      });
      throw err;
    }

    // eventKind from provider result
    const eventKind = webhook.eventKind ?? "payment";

    if (eventKind === "payment") {
      return this.handlePaymentWebhook(
        attemptId,
        providerCode,
        webhook as import("./payment-provider.interface").ProviderPaymentWebhookResult,
        candidateConfigs,
      );
    }

    if (eventKind === "refund") {
      return this.handleRefundWebhook(
        attemptId,
        providerCode,
        webhook as import("./payment-provider.interface").ProviderRefundWebhookResult,
      );
    }

    await this.webhookAttemptRecorder.finish({
      attemptId,
      eventKind: "unknown",
      handled: false,
      failureReason: "invalid_body",
    });
    return { handled: false, reason: "unknown_event_kind" };
  }

  private async handlePaymentWebhook(
    attemptId: string,
    providerCode: string,
    webhook: import("./payment-provider.interface").ProviderPaymentWebhookResult,
    candidateConfigs: PaymentProviderRuntimeConfig[],
  ) {
    const [payment] = webhook.paymentNo
      ? await this.db
          .select({
            id: payments.id,
            providerId: payments.providerId,
            status: payments.status,
            orderId: payments.orderId,
            orderNo: orders.orderNo,
            paymentNo: payments.paymentNo,
            amountCents: payments.amountCents,
            machineId: orders.machineId,
          })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .innerJoin(
            paymentProviders,
            eq(paymentProviders.id, payments.providerId),
          )
          .where(
            and(
              eq(payments.paymentNo, webhook.paymentNo),
              eq(paymentProviders.code, providerCode),
            ),
          )
          .limit(1)
      : [];
    if (!payment) {
      await this.webhookAttemptRecorder.finish({
        attemptId,
        eventKind: "payment",
        eventType: webhook.eventType,
        providerEventId: webhook.providerEventId,
        paymentNo: webhook.paymentNo,
        signatureValid: webhook.signatureValid,
        businessValid: false,
        handled: false,
        failureReason: "payment_not_found",
      });
      return { handled: false, reason: "payment_not_found" };
    }

    const businessValidation = this.validateProviderWebhookBusinessFields(
      providerCode,
      webhook.rawPayload,
      {
        paymentNo: payment.paymentNo,
        amountCents: payment.amountCents,
        machineId: payment.machineId,
      },
      candidateConfigs,
      webhook.normalizedPayload,
      webhook.matchedConfigId,
      webhook.paymentStatus,
    );

    const eventType = businessValidation.ok
      ? webhook.eventType
      : `${webhook.eventType}.business_invalid`;

    const inserted = await this.db
      .insert(paymentEvents)
      .values({
        paymentId: payment.id,
        providerId: payment.providerId,
        eventType,
        providerEventId: webhook.providerEventId,
        rawPayloadJson: buildStoredEventPayload(webhook.rawPayload),
        signatureValid: webhook.signatureValid,
        handledAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id });

    if (inserted.length === 0) {
      await this.webhookAttemptRecorder.finish({
        attemptId,
        providerId: payment.providerId,
        paymentId: payment.id,
        matchedConfigId: webhook.matchedConfigId,
        eventKind: "payment",
        eventType: webhook.eventType,
        providerEventId: webhook.providerEventId,
        paymentNo: payment.paymentNo,
        orderNo: payment.orderNo,
        signatureValid: webhook.signatureValid,
        businessValid: true,
        handled: true,
        duplicate: true,
        failureReason: "duplicate_event",
      });
      return { handled: true, duplicate: true };
    }

    if (!businessValidation.ok) {
      const reason = (businessValidation as { ok: false; reason: string })
        .reason;
      await this.webhookAttemptRecorder.finish({
        attemptId,
        providerId: payment.providerId,
        paymentId: payment.id,
        matchedConfigId: webhook.matchedConfigId,
        eventKind: "payment",
        eventType: webhook.eventType,
        providerEventId: webhook.providerEventId,
        paymentNo: payment.paymentNo,
        orderNo: payment.orderNo,
        signatureValid: webhook.signatureValid,
        businessValid: false,
        handled: false,
        failureReason: reason,
      });
      return { handled: false, reason };
    }

    if (webhook.paymentStatus === "succeeded") {
      const transition = await this.db.transaction(async (tx) => {
        const [r] = await tx
          .select({
            paymentId: payments.id,
            paymentStatus: payments.status,
            providerId: payments.providerId,
            orderId: orders.id,
            orderStatus: orders.status,
          })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(eq(payments.id, payment.id));
        if (!r) return null;

        const shouldDispatch = r.paymentStatus !== "succeeded";
        if (!shouldDispatch) {
          return { orderId: r.orderId, shouldDispatch: false };
        }

        await tx
          .update(payments)
          .set({
            status: "succeeded",
            paidAt: new Date(),
            failedReason: null,
            updatedAt: new Date(),
            ...(webhook.providerTradeNo
              ? { providerTradeNo: webhook.providerTradeNo }
              : {}),
          })
          .where(eq(payments.id, r.paymentId));

        if (r.orderStatus !== "paid" && r.orderStatus !== "dispensing") {
          await tx
            .update(orders)
            .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
            .where(eq(orders.id, r.orderId));
          await tx.insert(orderStatusEvents).values({
            orderId: r.orderId,
            fromStatus: r.orderStatus,
            toStatus: "paid",
            reason: "webhook_payment_succeeded",
          });
        }

        const reservations = await tx
          .select({
            inventoryId: inventoryReservations.inventoryId,
            quantity: inventoryReservations.quantity,
          })
          .from(inventoryReservations)
          .where(
            and(
              eq(inventoryReservations.orderId, r.orderId),
              eq(inventoryReservations.status, "active"),
            ),
          );

        await reservations.reduce<Promise<void>>(async (prev, reservation) => {
          await prev;
          await this.inventoryService.confirmReservation(tx, {
            orderId: r.orderId,
            inventoryId: reservation.inventoryId,
            quantity: reservation.quantity,
          });
        }, Promise.resolve());

        return { orderId: r.orderId, shouldDispatch: true };
      });

      if (transition?.shouldDispatch) {
        await this.vendingService.createAndDispatchCommands(transition.orderId);
      }
    }

    if (webhook.paymentStatus === "failed") {
      await this.db.transaction(async (tx) => {
        const [r] = await tx
          .select({
            paymentId: payments.id,
            paymentStatus: payments.status,
            orderId: orders.id,
            orderStatus: orders.status,
          })
          .from(payments)
          .innerJoin(orders, eq(orders.id, payments.orderId))
          .where(eq(payments.id, payment.id));
        if (!r) return;

        await tx
          .update(payments)
          .set({
            status: "failed",
            failedReason: "webhook_failed",
            updatedAt: new Date(),
          })
          .where(eq(payments.id, r.paymentId));

        if (r.orderStatus !== "canceled") {
          await tx
            .update(orders)
            .set({
              status: "canceled",
              canceledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(orders.id, r.orderId));
          await tx.insert(orderStatusEvents).values({
            orderId: r.orderId,
            fromStatus: r.orderStatus,
            toStatus: "canceled",
            reason: "webhook_payment_failed",
          });
        }

        await this.releaseActiveReservationsForOrder(tx, {
          orderId: r.orderId,
          reason: "payment_failed",
        });
      });
    }

    await this.webhookAttemptRecorder.finish({
      attemptId,
      providerId: payment.providerId,
      paymentId: payment.id,
      matchedConfigId: webhook.matchedConfigId,
      eventKind: "payment",
      eventType: webhook.eventType,
      providerEventId: webhook.providerEventId,
      paymentNo: payment.paymentNo,
      orderNo: payment.orderNo,
      signatureValid: webhook.signatureValid,
      businessValid: true,
      handled: true,
      duplicate: false,
    });

    return { handled: true, duplicate: false };
  }

  private async handleRefundWebhook(
    attemptId: string,
    providerCode: string,
    webhook: import("./payment-provider.interface").ProviderRefundWebhookResult,
  ) {
    const result = await this.refundsService.applyProviderRefundWebhook({
      providerCode,
      refundNo: webhook.refundNo,
      providerRefundNo: webhook.providerRefundNo,
      paymentNo: webhook.paymentNo,
      providerEventId: webhook.providerEventId,
      eventType: webhook.eventType,
      refundStatus:
        webhook.refundStatus === "processing" ||
        webhook.refundStatus === "succeeded" ||
        webhook.refundStatus === "failed" ||
        webhook.refundStatus === "canceled"
          ? webhook.refundStatus
          : null,
      rawPayload: webhook.rawPayload,
      signatureValid: webhook.signatureValid,
    });

    await this.webhookAttemptRecorder.finish({
      attemptId,
      eventKind: "refund",
      eventType: webhook.eventType,
      providerEventId: webhook.providerEventId,
      refundNo: webhook.refundNo,
      paymentNo: webhook.paymentNo,
      signatureValid: webhook.signatureValid,
      businessValid: result.handled,
      handled: result.handled,
      duplicate: result.duplicate ?? false,
      failureReason: result.reason,
      providerId: result.providerId,
      refundId: result.refundId,
      paymentId: result.paymentId,
      matchedConfigId: webhook.matchedConfigId,
    });

    return result;
  }

  private validateProviderWebhookBusinessFields(
    providerCode: string,
    rawPayload: Record<string, unknown>,
    payment: PaymentForWebhookValidation,
    candidateConfigs: PaymentProviderRuntimeConfig[],
    normalizedPayload?: Record<string, unknown> | null,
    matchedConfigId?: string | null,
    claimedStatus?: string | null,
  ): ProviderWebhookBusinessValidation {
    if (providerCode === "wechat_pay") {
      const n = normalizedPayload ?? {};

      const outTradeNo =
        typeof n["outTradeNo"] === "string" ? n["outTradeNo"] : null;
      const mchId = typeof n["mchId"] === "string" ? n["mchId"] : null;
      const appId = typeof n["appId"] === "string" ? n["appId"] : null;
      const amountTotal =
        typeof n["amountTotal"] === "number" ? n["amountTotal"] : null;
      const amountCurrency =
        typeof n["amountCurrency"] === "string" ? n["amountCurrency"] : null;
      const tradeState =
        typeof n["tradeState"] === "string" ? n["tradeState"] : null;

      if (outTradeNo && outTradeNo !== payment.paymentNo) {
        return { ok: false, reason: "wechat_out_trade_no_mismatch" };
      }
      if (amountTotal !== null && amountTotal !== payment.amountCents) {
        return { ok: false, reason: "wechat_amount_total_mismatch" };
      }
      if (amountCurrency && amountCurrency !== "CNY") {
        return { ok: false, reason: "wechat_currency_mismatch" };
      }

      const requireSucceeded = claimedStatus === "succeeded";
      if (requireSucceeded) {
        if (!outTradeNo)
          return { ok: false, reason: "wechat_out_trade_no_missing" };
        if (amountTotal === null)
          return { ok: false, reason: "wechat_amount_total_missing" };
        if (!amountCurrency)
          return { ok: false, reason: "wechat_currency_missing" };
        if (!mchId) return { ok: false, reason: "wechat_mchid_missing" };
        if (!appId) return { ok: false, reason: "wechat_appid_missing" };
        if (!tradeState)
          return { ok: false, reason: "wechat_trade_state_missing" };
      }

      // Find the matched config by id, or find by merchantNo
      const matchedConfig = matchedConfigId
        ? candidateConfigs.find((c) => c.id === matchedConfigId)
        : candidateConfigs.find((c) => !c.merchantNo || c.merchantNo === mchId);

      if (
        mchId &&
        matchedConfig?.merchantNo &&
        mchId !== matchedConfig.merchantNo
      ) {
        return { ok: false, reason: "wechat_mchid_mismatch" };
      }
      if (appId && matchedConfig?.appId && appId !== matchedConfig.appId) {
        return { ok: false, reason: "wechat_appid_mismatch" };
      }

      // If claimed payment status is succeeded but trade_state is not SUCCESS, reject
      if (
        claimedStatus === "succeeded" &&
        tradeState &&
        tradeState !== "SUCCESS"
      ) {
        return { ok: false, reason: "wechat_trade_state_not_success" };
      }
    } else if (providerCode === "alipay") {
      const appIdInPayload = rawString(rawPayload, "app_id");
      const sellerId = rawString(rawPayload, "seller_id");
      const outTradeNo = rawString(rawPayload, "out_trade_no");
      const totalAmount = rawString(rawPayload, "total_amount");
      const tradeStatus = rawString(rawPayload, "trade_status");

      if (outTradeNo && outTradeNo !== payment.paymentNo) {
        return { ok: false, reason: "alipay_out_trade_no_mismatch" };
      }
      if (
        totalAmount &&
        totalAmount !== alipayAmountFromCents(payment.amountCents)
      ) {
        return { ok: false, reason: "alipay_total_amount_mismatch" };
      }

      const requireSucceeded = claimedStatus === "succeeded";
      if (requireSucceeded) {
        if (!outTradeNo)
          return { ok: false, reason: "alipay_out_trade_no_missing" };
        if (!totalAmount)
          return { ok: false, reason: "alipay_total_amount_missing" };
        if (!appIdInPayload)
          return { ok: false, reason: "alipay_app_id_missing" };
        if (!sellerId) return { ok: false, reason: "alipay_seller_id_missing" };
        if (!tradeStatus)
          return { ok: false, reason: "alipay_trade_status_missing" };
        if (
          tradeStatus !== "TRADE_SUCCESS" &&
          tradeStatus !== "TRADE_FINISHED"
        ) {
          return { ok: false, reason: "alipay_trade_status_not_success" };
        }
      }

      const matchingConfig = candidateConfigs.find(
        (c) => !c.appId || c.appId === appIdInPayload,
      );
      if (appIdInPayload && !matchingConfig) {
        return { ok: false, reason: "alipay_app_id_mismatch" };
      }
      if (
        sellerId &&
        matchingConfig?.merchantNo &&
        sellerId !== matchingConfig.merchantNo
      ) {
        return { ok: false, reason: "alipay_seller_id_mismatch" };
      }
    }
    return { ok: true };
  }

  async reconcilePendingPayments(
    now = new Date(),
  ): Promise<{ reconciled: number }> {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const pendingPayments = await this.db
      .select({
        id: payments.id,
        paymentNo: payments.paymentNo,
        providerId: payments.providerId,
        providerCode: paymentProviders.code,
        providerTradeNo: payments.providerTradeNo,
        orderId: payments.orderId,
        machineId: orders.machineId,
        providerConfigId: payments.paymentProviderConfigId,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(
        and(
          inArray(payments.status, ["pending", "processing"]),
          sql`${payments.createdAt} >= ${cutoff}`,
          sql`${payments.expiresAt} IS NULL OR ${payments.expiresAt} > ${now}`,
          sql`not exists (
    select 1
    from payment_reconciliation_attempts pra
    where pra.payment_id = ${payments.id}
      and pra.trigger = 'scheduled'
      and pra.next_retry_at is not null
      and pra.next_retry_at > ${now}
  )`,
        ),
      )
      .limit(50);

    let reconciled = 0;
    await Promise.all(
      pendingPayments.map(async (payment) => {
        try {
          if (!this.paymentProviderRegistry.has(payment.providerCode)) return;

          // Count previous scheduled attempts for backoff
          const [countRow] = await this.db
            .select({ total: count() })
            .from(paymentReconciliationAttempts)
            .where(
              and(
                eq(paymentReconciliationAttempts.paymentId, payment.id),
                eq(paymentReconciliationAttempts.trigger, "scheduled"),
              ),
            );
          const attemptNo = Number(countRow.total) + 1;

          if (attemptNo > 8) {
            // Max attempts reached - record it but don't change payment state
            await this.db.insert(paymentReconciliationAttempts).values({
              paymentId: payment.id,
              providerId: payment.providerId,
              trigger: "scheduled",
              attemptNo,
              status: "max_attempts_exceeded",
              startedAt: now,
              finishedAt: now,
            });
            return;
          }

          const provider = this.paymentProviderRegistry.get(
            payment.providerCode,
          );
          const config = await this.paymentProviderConfigService
            .resolveForExistingPayment({
              providerCode: payment.providerCode,
              providerConfigId: payment.providerConfigId ?? null,
              machineId: payment.machineId,
            })
            .catch(() => ({
              id: "",
              providerCode: payment.providerCode,
              merchantNo: null,
              appId: null,
              publicConfigJson: {},
              sensitiveConfigJson: {},
            }));

          const startedAt = now;
          const [attempt] = await this.db
            .insert(paymentReconciliationAttempts)
            .values({
              paymentId: payment.id,
              providerId: payment.providerId,
              trigger: "scheduled",
              attemptNo,
              status: "pending",
              startedAt,
            })
            .returning({ id: paymentReconciliationAttempts.id });

          let result: Awaited<ReturnType<typeof provider.queryPayment>>;
          try {
            result = await provider.queryPayment({
              paymentNo: payment.paymentNo,
              providerTradeNo: payment.providerTradeNo,
              config,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const backoffMs = reconcileBackoffMs(attemptNo);
            const nextRetryAt = new Date(now.getTime() + backoffMs);
            await this.db
              .update(paymentReconciliationAttempts)
              .set({
                status: "network_error",
                errorCode: "query_failed",
                errorMessage: errMsg.slice(0, 500),
                nextRetryAt,
                finishedAt: new Date(),
              })
              .where(eq(paymentReconciliationAttempts.id, attempt.id));
            return;
          }

          const providerStatus = result.status;

          if (providerStatus === "pending" || providerStatus === "processing") {
            const backoffMs = reconcileBackoffMs(attemptNo);
            const nextRetryAt = new Date(now.getTime() + backoffMs);
            await this.db
              .update(paymentReconciliationAttempts)
              .set({
                status: providerStatus as "pending" | "processing",
                providerPaymentStatus: providerStatus,
                providerTradeNo: result.providerTradeNo ?? null,
                nextRetryAt,
                finishedAt: new Date(),
              })
              .where(eq(paymentReconciliationAttempts.id, attempt.id));
            return;
          }

          const providerEventId = `reconcile:${payment.paymentNo}:${providerStatus}:${now.getTime()}`;
          const finalStatus =
            providerStatus === "succeeded" || providerStatus === "failed"
              ? providerStatus
              : "failed";
          const applied = await this.applyPaymentStatusUpdate(
            payment.id,
            payment.orderId,
            finalStatus,
            providerEventId,
            result.providerTradeNo,
            result.rawPayload,
            payment.providerId,
            result.paidAt ?? now,
            result.failedReason ?? null,
          );

          await this.db
            .update(paymentReconciliationAttempts)
            .set({
              status: finalStatus,
              providerPaymentStatus: providerStatus,
              providerTradeNo: result.providerTradeNo ?? null,
              rawPayloadSha256: result.rawPayload
                ? sha256Hex(JSON.stringify(result.rawPayload))
                : null,
              finishedAt: new Date(),
            })
            .where(eq(paymentReconciliationAttempts.id, attempt.id));

          if (applied) {
            reconciled += 1;
            if (providerStatus === "succeeded") {
              await this.vendingService
                .createAndDispatchCommands(payment.orderId)
                .catch((_err: unknown) => {
                  // ignore dispatch errors during reconciliation
                });
            }
          }
        } catch (err) {
          this.logger.warn(
            `Reconciliation failed for payment ${payment.paymentNo}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
    return { reconciled };
  }

  private async nextPaymentReconciliationAttemptNo(
    paymentId: string,
    trigger: "scheduled" | "manual" | "expire_compensation",
  ): Promise<number> {
    const [countRow] = await this.db
      .select({ total: count() })
      .from(paymentReconciliationAttempts)
      .where(
        and(
          eq(paymentReconciliationAttempts.paymentId, paymentId),
          eq(paymentReconciliationAttempts.trigger, trigger),
        ),
      );
    return Number(countRow.total) + 1;
  }

  private async applyPaymentStatusUpdate(
    paymentId: string,
    orderId: string,
    newStatus: "succeeded" | "failed",
    providerEventId: string,
    providerTradeNo?: string | null,
    rawPayloadJson?: Record<string, unknown>,
    providerId?: string,
    occurredAt?: Date | null,
    failedReason?: string | null,
  ): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(eq(paymentEvents.providerEventId, providerEventId))
        .limit(1);
      if (existing) return false;

      const [r] = await tx
        .select({
          paymentId: payments.id,
          paymentStatus: payments.status,
          orderId: orders.id,
          orderStatus: orders.status,
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(eq(payments.id, paymentId));
      if (!r) return false;

      await tx
        .insert(paymentEvents)
        .values({
          paymentId,
          providerId:
            providerId ??
            (await this.db
              .select({ id: payments.providerId })
              .from(payments)
              .where(eq(payments.id, paymentId))
              .then(([p]) => p?.id ?? "")),
          eventType: `reconcile.payment.${newStatus}`,
          providerEventId,
          rawPayloadJson: buildStoredEventPayload(rawPayloadJson ?? {}),
          signatureValid: true,
          handledAt: new Date(),
        })
        .onConflictDoNothing();

      if (newStatus === "succeeded") {
        const handledAt = occurredAt ?? new Date();
        await tx
          .update(payments)
          .set({
            status: "succeeded",
            paidAt: handledAt,
            failedReason: null,
            ...(providerTradeNo ? { providerTradeNo } : {}),
            updatedAt: new Date(),
          })
          .where(eq(payments.id, paymentId));

        if (r.orderStatus === "pending_payment") {
          await tx
            .update(orders)
            .set({ status: "paid", paidAt: handledAt, updatedAt: new Date() })
            .where(eq(orders.id, orderId));
          await tx.insert(orderStatusEvents).values({
            orderId,
            fromStatus: r.orderStatus,
            toStatus: "paid",
            reason: "reconcile_succeeded",
          });
        }
      } else {
        await tx
          .update(payments)
          .set({
            status: "failed",
            failedReason: failedReason ?? "provider_reported_failed",
            updatedAt: new Date(),
          })
          .where(eq(payments.id, paymentId));

        if (r.orderStatus !== "canceled") {
          await tx
            .update(orders)
            .set({
              status: "canceled",
              canceledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(orders.id, orderId));
          await tx.insert(orderStatusEvents).values({
            orderId,
            fromStatus: r.orderStatus,
            toStatus: "canceled",
            reason: "reconcile_payment_failed",
          });
        }

        await this.releaseActiveReservationsForOrder(tx, {
          orderId,
          reason: "payment_failed",
        });
      }

      return true;
    });
  }

  async listWebhookAttempts(query: WebhookAttemptQuery) {
    const conditions: SQL[] = [];
    if (query.orderNo) {
      conditions.push(sql`${orders.orderNo} = ${query.orderNo}`);
    }
    if (query.paymentNo) {
      conditions.push(eq(paymentWebhookAttempts.paymentNo, query.paymentNo));
    }
    if (query.refundNo) {
      conditions.push(eq(paymentWebhookAttempts.refundNo, query.refundNo));
    }
    if (query.providerCode) {
      conditions.push(eq(paymentProviders.code, query.providerCode));
    }
    if (query.eventKind) {
      conditions.push(eq(paymentWebhookAttempts.eventKind, query.eventKind));
    }
    if (query.signatureValid !== undefined) {
      conditions.push(
        eq(paymentWebhookAttempts.signatureValid, query.signatureValid),
      );
    }
    if (query.businessValid !== undefined) {
      conditions.push(
        eq(paymentWebhookAttempts.businessValid, query.businessValid),
      );
    }
    if (query.createdFrom) {
      conditions.push(
        sql`${paymentWebhookAttempts.createdAt} >= ${new Date(query.createdFrom)}`,
      );
    }
    if (query.createdTo) {
      conditions.push(
        sql`${paymentWebhookAttempts.createdAt} <= ${new Date(query.createdTo)}`,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await this.db
      .select({
        id: paymentWebhookAttempts.id,
        providerCode: paymentProviders.code,
        eventKind: paymentWebhookAttempts.eventKind,
        eventType: paymentWebhookAttempts.eventType,
        paymentNo: paymentWebhookAttempts.paymentNo,
        refundNo: paymentWebhookAttempts.refundNo,
        orderNo: paymentWebhookAttempts.orderNo,
        signatureValid: paymentWebhookAttempts.signatureValid,
        businessValid: paymentWebhookAttempts.businessValid,
        handled: paymentWebhookAttempts.handled,
        duplicate: paymentWebhookAttempts.duplicate,
        failureReason: paymentWebhookAttempts.failureReason,
        remoteIp: paymentWebhookAttempts.remoteIp,
        httpStatus: paymentWebhookAttempts.httpStatus,
        createdAt: paymentWebhookAttempts.createdAt,
      })
      .from(paymentWebhookAttempts)
      .leftJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentWebhookAttempts.providerId),
      )
      .leftJoin(payments, eq(payments.id, paymentWebhookAttempts.paymentId))
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(whereClause)
      .orderBy(desc(paymentWebhookAttempts.createdAt))
      .limit(query.pageSize ?? 20)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(paymentWebhookAttempts)
      .leftJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentWebhookAttempts.providerId),
      )
      .leftJoin(payments, eq(payments.id, paymentWebhookAttempts.paymentId))
      .leftJoin(orders, eq(orders.id, payments.orderId))
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async listReconciliationAttempts(query: ReconciliationAttemptQuery) {
    const conditions: SQL[] = [];
    if (query.providerCode) {
      conditions.push(eq(paymentProviders.code, query.providerCode));
    }
    if (query.trigger) {
      conditions.push(
        eq(
          paymentReconciliationAttempts.trigger,
          query.trigger as "manual" | "scheduled" | "expire_compensation",
        ),
      );
    }
    if (query.status) {
      conditions.push(
        eq(
          paymentReconciliationAttempts.status,
          query.status as
            | "succeeded"
            | "failed"
            | "pending"
            | "processing"
            | "network_error"
            | "config_error"
            | "max_attempts_exceeded",
        ),
      );
    }
    if (query.createdFrom) {
      conditions.push(
        sql`${paymentReconciliationAttempts.createdAt} >= ${new Date(query.createdFrom)}`,
      );
    }
    if (query.createdTo) {
      conditions.push(
        sql`${paymentReconciliationAttempts.createdAt} <= ${new Date(query.createdTo)}`,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await this.db
      .select({
        id: paymentReconciliationAttempts.id,
        paymentId: paymentReconciliationAttempts.paymentId,
        paymentNo: payments.paymentNo,
        providerCode: paymentProviders.code,
        trigger: paymentReconciliationAttempts.trigger,
        attemptNo: paymentReconciliationAttempts.attemptNo,
        status: paymentReconciliationAttempts.status,
        providerPaymentStatus:
          paymentReconciliationAttempts.providerPaymentStatus,
        errorCode: paymentReconciliationAttempts.errorCode,
        errorMessage: paymentReconciliationAttempts.errorMessage,
        nextRetryAt: paymentReconciliationAttempts.nextRetryAt,
        startedAt: paymentReconciliationAttempts.startedAt,
        finishedAt: paymentReconciliationAttempts.finishedAt,
        createdAt: paymentReconciliationAttempts.createdAt,
      })
      .from(paymentReconciliationAttempts)
      .innerJoin(
        payments,
        eq(payments.id, paymentReconciliationAttempts.paymentId),
      )
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentReconciliationAttempts.providerId),
      )
      .where(whereClause)
      .orderBy(desc(paymentReconciliationAttempts.createdAt))
      .limit(query.pageSize ?? 20)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(paymentReconciliationAttempts)
      .innerJoin(
        payments,
        eq(payments.id, paymentReconciliationAttempts.paymentId),
      )
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentReconciliationAttempts.providerId),
      )
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async listRefunds(query: RefundListQuery) {
    const conditions: SQL[] = [];
    if (query.orderNo) {
      conditions.push(sql`${orders.orderNo} = ${query.orderNo}`);
    }
    if (query.paymentNo) {
      conditions.push(eq(payments.paymentNo, query.paymentNo));
    }
    if (query.refundNo) {
      conditions.push(eq(refunds.refundNo, query.refundNo));
    }
    if (query.providerCode) {
      conditions.push(eq(paymentProviders.code, query.providerCode));
    }
    if (query.status) {
      conditions.push(eq(refunds.status, query.status));
    }
    if (query.createdFrom) {
      conditions.push(
        sql`${refunds.createdAt} >= ${new Date(query.createdFrom)}`,
      );
    }
    if (query.createdTo) {
      conditions.push(
        sql`${refunds.createdAt} <= ${new Date(query.createdTo)}`,
      );
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const items = await this.db
      .select({
        id: refunds.id,
        refundNo: refunds.refundNo,
        paymentId: refunds.paymentId,
        paymentNo: payments.paymentNo,
        orderNo: orders.orderNo,
        providerCode: paymentProviders.code,
        status: refunds.status,
        amountCents: refunds.amountCents,
        reason: refunds.reason,
        providerRefundNo: refunds.providerRefundNo,
        refundedAt: refunds.refundedAt,
        createdAt: refunds.createdAt,
        updatedAt: refunds.updatedAt,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(whereClause)
      .orderBy(desc(refunds.createdAt))
      .limit(query.pageSize ?? 20)
      .offset(getOffset(query));

    const [totalRow] = await this.db
      .select({ total: count() })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(whereClause);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async manualReconcile(paymentId: string, adminUserId: string) {
    const [payment] = await this.db
      .select({
        id: payments.id,
        paymentNo: payments.paymentNo,
        status: payments.status,
        providerId: payments.providerId,
        providerCode: paymentProviders.code,
        providerTradeNo: payments.providerTradeNo,
        orderId: payments.orderId,
        machineId: orders.machineId,
        providerConfigId: payments.paymentProviderConfigId,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(eq(payments.id, paymentId))
      .limit(1);

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    if (payment.status !== "pending" && payment.status !== "processing") {
      return {
        status: payment.status,
        reconciled: false,
        reason: "already_terminal",
      };
    }

    const provider = this.paymentProviderRegistry.get(payment.providerCode);
    const config = await this.paymentProviderConfigService
      .resolveForExistingPayment({
        providerCode: payment.providerCode,
        providerConfigId: payment.providerConfigId ?? null,
        machineId: payment.machineId,
      })
      .catch(() => ({
        id: "",
        providerCode: payment.providerCode,
        merchantNo: null,
        appId: null,
        publicConfigJson: {},
        sensitiveConfigJson: {},
      }));

    // Count previous attempts
    const [countRow] = await this.db
      .select({ total: count() })
      .from(paymentReconciliationAttempts)
      .where(
        and(
          eq(paymentReconciliationAttempts.paymentId, payment.id),
          eq(paymentReconciliationAttempts.trigger, "manual"),
        ),
      );
    const attemptNo = Number(countRow.total) + 1;

    const startedAt = new Date();
    const [attempt] = await this.db
      .insert(paymentReconciliationAttempts)
      .values({
        paymentId: payment.id,
        providerId: payment.providerId,
        trigger: "manual",
        attemptNo,
        status: "pending",
        startedAt,
      })
      .returning({ id: paymentReconciliationAttempts.id });

    let result: Awaited<ReturnType<typeof provider.queryPayment>>;
    try {
      result = await provider.queryPayment({
        paymentNo: payment.paymentNo,
        providerTradeNo: payment.providerTradeNo,
        config,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.db
        .update(paymentReconciliationAttempts)
        .set({
          status: "network_error",
          errorCode: "query_failed",
          errorMessage: errMsg.slice(0, 500),
          finishedAt: new Date(),
        })
        .where(eq(paymentReconciliationAttempts.id, attempt.id));
      throw err;
    }

    const providerStatus = result.status;
    const isTerminal =
      providerStatus === "succeeded" || providerStatus === "failed";

    if (!isTerminal) {
      await this.db
        .update(paymentReconciliationAttempts)
        .set({
          status: providerStatus as "pending" | "processing",
          providerPaymentStatus: providerStatus,
          providerTradeNo: result.providerTradeNo ?? null,
          finishedAt: new Date(),
        })
        .where(eq(paymentReconciliationAttempts.id, attempt.id));
      return {
        status: payment.status,
        reconciled: false,
        reason: `provider_${providerStatus}`,
      };
    }

    const providerEventId = `manual_reconcile:${payment.paymentNo}:${providerStatus}:${Date.now()}`;
    const now = new Date();
    const applied = await this.applyPaymentStatusUpdate(
      payment.id,
      payment.orderId,
      providerStatus as "succeeded" | "failed",
      providerEventId,
      result.providerTradeNo,
      result.rawPayload,
      payment.providerId,
      result.paidAt ?? now,
      result.failedReason ?? null,
    );

    await this.db
      .update(paymentReconciliationAttempts)
      .set({
        status: providerStatus as "succeeded" | "failed",
        providerPaymentStatus: providerStatus,
        providerTradeNo: result.providerTradeNo ?? null,
        rawPayloadSha256: result.rawPayload
          ? sha256Hex(JSON.stringify(result.rawPayload))
          : null,
        finishedAt: new Date(),
      })
      .where(eq(paymentReconciliationAttempts.id, attempt.id));

    if (applied && providerStatus === "succeeded") {
      await this.vendingService
        .createAndDispatchCommands(payment.orderId)
        .catch(() => {});
    }

    await this.auditService.record({
      adminUserId: adminUserId,
      action: "payments.manual_reconcile",
      resourceType: "payment",
      resourceId: payment.id,
      afterJson: { paymentNo: payment.paymentNo, providerStatus, applied },
    });

    return { status: providerStatus, reconciled: applied };
  }
}
