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
  payments,
  sql,
  type DrizzleClient,
  type SQL,
} from "@vem/db";
import {
  pageQuerySchema,
  paymentEventQuerySchema,
  paymentProviderQuerySchema,
  paymentQuerySchema,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
  upsertPaymentProviderConfigSchema,
  alipayPublicConfigSchema,
  wechatPayPublicConfigSchema,
} from "@vem/shared";
import { z } from "zod";

import { AuditService } from "../audit/audit.service";
import { getOffset, toPageResult } from "../common/pagination.util";
import { AppConfigService } from "../config/app-config.service";
import { isEncryptedJson } from "../crypto/encrypted-json.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { InventoryService } from "../inventory/inventory.service";
import { VendingService } from "../vending/vending.service";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import { PaymentProviderConfigService } from "./payment-provider-config.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";

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
          rawPayloadJson: { paymentNo, event: "succeed" },
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
          rawPayloadJson: { paymentNo, event: "fail", reason },
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
          await this.inventoryService.releaseReservation(tx, {
            orderId: row.orderId,
            inventoryId: reservation.inventoryId,
            quantity: reservation.quantity,
            reason: "payment_failed",
          });
        },
        Promise.resolve(),
      );

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
        orderId: orders.id,
        orderStatus: orders.status,
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .where(
        and(
          inArray(payments.status, ["created", "pending", "processing"]),
          sql`${payments.expiresAt} IS NOT NULL`,
          gt(payments.expiresAt, new Date(0)),
          sql`${payments.expiresAt} < ${now}`,
        ),
      );

    const results = await Promise.all(
      overduePayments.map(async (payment) => {
        return await this.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(paymentEvents)
            .values({
              paymentId: payment.paymentId,
              providerId: payment.providerId,
              eventType: "mock.payment.expired",
              providerEventId: `mock:expired:${payment.paymentNo}`,
              rawPayloadJson: {
                paymentNo: payment.paymentNo,
                event: "expired",
              },
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

          const reservations = await tx
            .select({
              inventoryId: inventoryReservations.inventoryId,
              quantity: inventoryReservations.quantity,
            })
            .from(inventoryReservations)
            .where(
              and(
                eq(inventoryReservations.orderId, payment.orderId),
                eq(inventoryReservations.status, "active"),
              ),
            );

          await reservations.reduce<Promise<void>>(
            async (previous, reservation) => {
              await previous;
              await this.inventoryService.releaseReservation(tx, {
                orderId: payment.orderId,
                inventoryId: reservation.inventoryId,
                quantity: reservation.quantity,
                reason: "payment_expired",
              });
            },
            Promise.resolve(),
          );

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
    if (!existing) throw new NotFoundException("Payment provider config not found");

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
      if (typeof source[key] !== "string" || (source[key] as string).trim().length === 0) {
        missing.push(key);
      }
    };

    if (!input.merchantNo) missing.push("merchantNo");
    if (!input.appId) missing.push("appId");

    if (input.providerCode === "wechat_pay") {
      requireString(input.publicConfigJson, "certificateSerialNo");
      requireString(input.sensitiveConfigJson, "apiV3Key");
      requireString(input.sensitiveConfigJson, "privateKeyPem");
      requireString(input.sensitiveConfigJson, "platformPublicKeyPem");
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
        return this.normalizeProviderPublicConfig(input.providerCode, basePublicConfig);
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
          publicConfigJson: existingRow.publicConfigJson as Record<string, unknown>,
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
        const staticCheck = this.config.getPaymentNotifyUrlStaticCheck(providerCode);
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
  ) {
    const provider = this.paymentProviderRegistry.get(providerCode);
    if (!provider.handleWebhook) {
      throw new NotFoundException("Payment webhook is not supported");
    }
    const candidateConfigs = await this.paymentProviderConfigService
      .listCandidateConfigsForProvider(providerCode)
      .catch(() => []);
    const computedRawBodyText =
      rawBodyText ?? (typeof body === "string" ? body : JSON.stringify(body));
    const webhook = await provider.handleWebhook({
      headers,
      body,
      rawBodyText: computedRawBodyText,
      candidateConfigs,
    });

    const [payment] = webhook.paymentNo
      ? await this.db
          .select({
            id: payments.id,
            providerId: payments.providerId,
            status: payments.status,
            orderId: payments.orderId,
          })
          .from(payments)
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
      return { handled: false, reason: "payment_not_found" };
    }

    const inserted = await this.db
      .insert(paymentEvents)
      .values({
        paymentId: payment.id,
        providerId: payment.providerId,
        eventType: webhook.eventType,
        providerEventId: webhook.providerEventId,
        rawPayloadJson: webhook.rawPayload,
        signatureValid: webhook.signatureValid,
        handledAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id });
    if (inserted.length === 0) {
      return { handled: true, duplicate: true };
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
          await this.inventoryService.releaseReservation(tx, {
            orderId: r.orderId,
            inventoryId: reservation.inventoryId,
            quantity: reservation.quantity,
            reason: "payment_failed",
          });
        }, Promise.resolve());
      });
    }

    return { handled: true, duplicate: false };
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
      })
      .from(payments)
      .innerJoin(orders, eq(orders.id, payments.orderId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(
        and(
          inArray(payments.status, ["pending", "processing"]),
          sql`${payments.createdAt} >= ${cutoff}`,
          sql`${payments.expiresAt} IS NULL OR ${payments.expiresAt} > ${now}`,
        ),
      )
      .limit(50);

    let reconciled = 0;
    await Promise.all(
      pendingPayments.map(async (payment) => {
        try {
          if (!this.paymentProviderRegistry.has(payment.providerCode)) return;
          const provider = this.paymentProviderRegistry.get(
            payment.providerCode,
          );
          const config = await this.paymentProviderConfigService
            .resolveForPayment({
              providerCode: payment.providerCode,
              machineId: payment.machineId,
            })
            .catch(() => ({
              providerCode: payment.providerCode,
              merchantNo: null,
              appId: null,
              publicConfigJson: {},
              sensitiveConfigJson: {},
            }));
          const result = await provider.queryPayment({
            paymentNo: payment.paymentNo,
            providerTradeNo: payment.providerTradeNo,
            config,
          });
          if (result.status === "pending" || result.status === "processing") {
            return;
          }
          const providerEventId = `reconcile:${payment.paymentNo}:${result.status}:${now.getTime()}`;
          const finalStatus =
            result.status === "succeeded" || result.status === "failed"
              ? result.status
              : "failed";
          const applied = await this.applyPaymentStatusUpdate(
            payment.id,
            payment.orderId,
            finalStatus,
            providerEventId,
            result.providerTradeNo,
            result.rawPayload,
            payment.providerId,
          );
          if (applied) {
            reconciled += 1;
            if (result.status === "succeeded") {
              await this.vendingService
                .createAndDispatchCommands(payment.orderId)
                .catch((_err: unknown) => {
                  // ignore dispatch errors during reconciliation
                });
            }
          }
        } catch {
          // Skip failed reconciliation for individual payments
        }
      }),
    );
    return { reconciled };
  }

  private async applyPaymentStatusUpdate(
    paymentId: string,
    orderId: string,
    newStatus: "succeeded" | "failed",
    providerEventId: string,
    providerTradeNo?: string | null,
    rawPayloadJson?: Record<string, unknown>,
    providerId?: string,
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
          rawPayloadJson: rawPayloadJson ?? {},
          signatureValid: true,
          handledAt: new Date(),
        })
        .onConflictDoNothing();

      if (newStatus === "succeeded") {
        await tx
          .update(payments)
          .set({
            status: "succeeded",
            providerTradeNo: providerTradeNo ?? null,
            updatedAt: new Date(),
          })
          .where(eq(payments.id, paymentId));

        if (r.orderStatus === "pending_payment") {
          await tx
            .update(orders)
            .set({ status: "paid", updatedAt: new Date() })
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
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(payments.id, paymentId));
      }

      return true;
    });
  }
}
