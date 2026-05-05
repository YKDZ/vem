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
} from "@vem/shared";
import { z } from "zod";

import { getOffset, toPageResult } from "../common/pagination.util";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { InventoryService } from "../inventory/inventory.service";
import { VendingService } from "../vending/vending.service";
import { PaymentProviderRegistry } from "./payment-provider.registry";

type PaymentQuery = z.infer<typeof paymentQuerySchema> &
  z.infer<typeof pageQuerySchema>;
type PaymentProviderQuery = z.infer<typeof paymentProviderQuerySchema>;
type UpdatePaymentProviderInput = z.infer<typeof updatePaymentProviderSchema>;
type UpdatePaymentProviderConfigInput = z.infer<
  typeof updatePaymentProviderConfigSchema
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

  async markMockSucceeded(paymentNo: string) {
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
        status: "succeeded",
        orderId: row.orderId,
        alreadyHandled: false,
      };
    });

    if (!transition.alreadyHandled) {
      await this.vendingService.createAndDispatchCommands(transition.orderId);
    }

    return transition;
  }

  async markMockFailed(paymentNo: string, reason: string) {
    this.assertMockPaymentEnabled();
    return await this.db.transaction(async (tx) => {
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
        status: "failed",
        orderId: row.orderId,
        alreadyHandled: false,
      };
    });
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
    return await this.db.select().from(paymentProviderConfigs);
  }

  async updateProviderConfig(
    id: string,
    adminUserId: string,
    input: UpdatePaymentProviderConfigInput,
  ) {
    const [updated] = await this.db
      .update(paymentProviderConfigs)
      .set({
        merchantNo: input.merchantNo,
        appId: input.appId,
        publicConfigJson: input.publicConfigJson,
        status: input.status,
        updatedByAdminUserId: adminUserId,
        updatedAt: new Date(),
      })
      .where(eq(paymentProviderConfigs.id, id))
      .returning();
    if (!updated)
      throw new NotFoundException("Payment provider config not found");
    return updated;
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
  ) {
    const provider = this.paymentProviderRegistry.get(providerCode);
    if (!provider.handleWebhook) {
      throw new NotFoundException("Payment webhook is not supported");
    }
    const webhook = await provider.handleWebhook({ headers, body });

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
      const row = await this.db.transaction(async (tx) => {
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

        if (r.paymentStatus !== "succeeded") {
          await tx
            .update(payments)
            .set({
              status: "succeeded",
              paidAt: new Date(),
              failedReason: null,
              updatedAt: new Date(),
            })
            .where(eq(payments.id, r.paymentId));
        }

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

        return r;
      });

      if (row) {
        await this.vendingService.createAndDispatchCommands(row.orderId);
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
}
