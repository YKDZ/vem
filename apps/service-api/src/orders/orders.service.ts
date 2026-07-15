import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  and,
  auditLogs,
  count,
  desc,
  eq,
  gt,
  inArray,
  inventories,
  inventoryMovements,
  inventoryReservations,
  isNull,
  lt,
  machineRawStockMovementConflicts,
  machineRawStockMovements,
  machinePlanogramSlots,
  machinePlanogramVersions,
  machineSlots,
  machines,
  maintenanceWorkOrders,
  orderItems,
  orderRecoveryActions,
  orders,
  orderStatusEvents,
  paymentCodeAttempts,
  paymentEvents,
  paymentProviders,
  paymentReconciliationAttempts,
  paymentWebhookAttempts,
  payments,
  productVariants,
  products,
  or,
  refundReconciliationAttempts,
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
  type OrderFulfillmentState,
  type OrderPaymentState,
  type OrderStatus,
  type PermissionCode,
  type PaymentCodeSource,
  type PaymentStatus,
  type OrderRecoveryAction,
  type VendingCommandStatus,
} from "@vem/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { PaymentReconciliationState } from "../payments/payment-provider.interface";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-no.util";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { InventoryService } from "../inventory/inventory.service";
import { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import { PaymentProviderRegistry } from "../payments/payment-provider.registry";
import { buildStoredEventPayload } from "../payments/payment-redaction.util";
import { PaymentsService } from "../payments/payments.service";
import { RefundsService } from "../refunds/refunds.service";
import { VendingService } from "../vending/vending.service";
import { projectOrderStatus } from "./order-state-projection";
import {
  mapOrderRecoveryActionDtoToInsert,
  toOrderInvestigationResponse,
  toOrderRecoveryActionResponse,
  toOrderRefundRequestResponse,
} from "./orders.contract-mappers";

type CreateMachineOrderInput = z.infer<typeof createMachineOrderSchema>;
type MachineOrderStatusQuery = z.infer<typeof machineOrderStatusQuerySchema>;
type OrderQuery = z.infer<typeof orderQuerySchema> &
  z.infer<typeof pageQuerySchema>;

const DEFAULT_UNCONFIRMED_QR_DISPLAY_DELAY_MS = 30_000;
// Provider calls are bounded by their configured client timeouts. Keep a
// generous lease and renew it while a call is still in progress so a healthy
// owner cannot be taken over mid-call.
const PAYMENT_INTENT_CREATION_LEASE_MS = 90_000;
const PAYMENT_INTENT_CREATION_LEASE_HEARTBEAT_MS = 30_000;
const PAYMENT_INTENT_PROVIDER_DEADLINE_MS = 20_000;
const RECOVERY_ACTIONS = [
  "confirm_dispensed",
  "confirm_not_dispensed",
  "request_refund",
  "compensation_dispense",
] as const;
const ACTIVE_REFUND_STATUSES = ["created", "processing", "succeeded"] as const;

type RecoveryActionName = (typeof RECOVERY_ACTIONS)[number];
type RecoveryActionRow = {
  id: string;
  commandId: string;
  action: string;
  status: string;
};
type MachinePaymentSelection =
  | { providerCode: "mock"; method: "mock" | "payment_code" }
  | {
      providerCode: "wechat_pay" | "alipay";
      method: "qr_code" | "payment_code";
    };

function isUniqueViolation(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    isUniqueViolation(Reflect.get(error, "cause"))
  ) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "23505"
  );
}

function normalizeRecoveryAction(
  input: OrderRecoveryAction,
): RecoveryActionName {
  const action = input.action;
  if (RECOVERY_ACTIONS.some((candidate) => candidate === action)) {
    return action;
  }
  throw new ConflictException(`Unsupported recovery action ${action}`);
}

function isCompletedAction(
  row: RecoveryActionRow,
  action: RecoveryActionName,
): boolean {
  return row.action === action && row.status === "completed";
}

function hasPermission(
  permissions: ReadonlySet<PermissionCode>,
  permission: PermissionCode,
): boolean {
  return permissions.has(permission);
}

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

function isTradeNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ACQ\.TRADE_NOT_EXIST|trade not exist|交易不存在/i.test(message);
}

function isIndeterminateProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("status: 5") ||
    lower.includes("status: 504") ||
    lower.includes("gateway timeout") ||
    lower.includes("gateway time-out") ||
    lower.includes("econn") ||
    lower.includes("socket") ||
    lower.includes("payment provider unavailable") ||
    message.includes("支付通道暂不可用") ||
    message.includes("HTTP 请求错误") ||
    message.includes("请求超时") ||
    message.includes("网络超时")
  );
}

function shouldExposePaymentUrl(row: MachineOrderStatusRow, now = new Date()) {
  if (row.paymentMethod !== "qr_code") return true;
  if (row.paymentStatus === "pending" || row.paymentStatus === "succeeded") {
    return true;
  }
  if (row.paymentStatus !== "processing" || !row.paymentUrl) return false;
  return (
    now.getTime() - row.paymentCreatedAt.getTime() >=
    DEFAULT_UNCONFIRMED_QR_DISPLAY_DELAY_MS
  );
}

function assertMachineOrderLineContextMatchesInventory(
  item: CreateMachineOrderInput["items"][number],
  row: { slotId: string; slotCode: string },
): void {
  if (!item.planogramVersion || !item.slotId || !item.slotCode) {
    throw new ConflictException("Machine order line context is required");
  }
  if (item.slotId !== row.slotId || item.slotCode !== row.slotCode) {
    throw new ConflictException(
      "Machine order line does not match active slot inventory mapping",
    );
  }
}

function resolvePaymentSelection(
  input: CreateMachineOrderInput,
): MachinePaymentSelection {
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
    (input.paymentProviderCode === "mock" ||
      input.paymentProviderCode === "wechat_pay" ||
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

type ExistingPaymentCreation = LocalPaymentDraft & {
  paymentStatus: PaymentStatus;
  paymentUrl: string | null;
  providerTradeNo: string | null;
  providerConfigId: string | null;
  providerConfigSnapshotJson: unknown;
  intentCreationLeaseExpiresAt: Date | null;
  intentCreationLeaseOwnerToken: string | null;
  intentCreationLeaseFence: number;
  failedReason: string | null;
};

const RECONCILIATION_RETRY_CLAIMED = "provider_trade_retry_claimed";

/**
 * Convert only the provider's durable TRADE_NOT_EXIST fact back into an
 * intent-creation state. The update itself is the cross-process ownership
 * claim; WAIT_BUYER_PAY and generic pending states cannot pass this CAS.
 */
export async function claimReconciledPaymentForIntentCreation(
  db: DrizzleClient,
  paymentId: string,
): Promise<boolean> {
  const reconciliationState: PaymentReconciliationState =
    "provider_trade_not_exist";
  const claimed = await db
    .update(payments)
    .set({
      status: "processing",
      failedReason: RECONCILIATION_RETRY_CLAIMED,
      intentCreationLeaseExpiresAt: null,
      intentCreationLeaseOwnerToken: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payments.id, paymentId),
        eq(payments.status, "pending"),
        isNull(payments.paymentUrl),
        eq(payments.failedReason, reconciliationState),
        or(
          isNull(payments.intentCreationLeaseExpiresAt),
          lt(payments.intentCreationLeaseExpiresAt, new Date()),
        ),
      ),
    )
    .returning({ id: payments.id });
  return claimed.length === 1;
}

type PaymentIntentLease = {
  ownerToken: string;
  fence: number;
  expiresAt: Date;
};

type MachineOrderStatusRow = {
  orderId: string;
  orderNo: string;
  machineCode: string;
  orderStatus: OrderStatus;
  paymentState: OrderPaymentState;
  fulfillmentState: OrderFulfillmentState;
  totalAmountCents: number;
  paymentId: string;
  paymentNo: string;
  paymentMethod: "mock" | "qr_code" | "payment_code" | "face_pay";
  paymentStatus: PaymentStatus;
  paymentUrl: string | null;
  paymentCreatedAt: Date;
  paymentExpiresAt: Date | null;
  paidAt: Date | null;
  failedReason: string | null;
  paymentProviderCode: string;
  isDrill: boolean;
  isTest: boolean;
  scenario: string | null;
};

type CancelableMachineOrderRow = {
  orderId: string;
  orderNo: string;
  machineId: string;
  orderStatus: OrderStatus;
  paymentState: OrderPaymentState;
  fulfillmentState: OrderFulfillmentState;
  paymentId: string;
  paymentNo: string;
  paymentMethod: "mock" | "qr_code" | "payment_code" | "face_pay";
  paymentStatus: PaymentStatus;
  providerId: string;
  providerCode: string;
  providerTradeNo: string | null;
  providerConfigId: string | null;
  providerConfigSnapshotJson: unknown;
};

type CancelableMachineOrderCurrentRow = Pick<
  CancelableMachineOrderRow,
  "orderStatus" | "paymentState" | "fulfillmentState" | "paymentStatus"
>;

@Injectable()
export class OrdersService {
  private readonly paymentIntentCreationInFlight = new Map<
    string,
    Promise<{
      providerTradeNo: string | null;
      paymentUrl: string;
      initialStatus?: PaymentStatus;
    }>
  >();

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly inventoryService: InventoryService,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly paymentProviderConfigService: PaymentProviderConfigService,
    private readonly refundsService: RefundsService,
    private readonly auditService: AuditService,
    private readonly vendingService: VendingService,
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
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
        totalAmountCents: orders.totalAmountCents,
        paymentId: payments.id,
        paymentNo: payments.paymentNo,
        paymentMethod: payments.method,
        paymentStatus: payments.status,
        paymentUrl: payments.paymentUrl,
        paymentCreatedAt: payments.createdAt,
        paymentExpiresAt: payments.expiresAt,
        paidAt: payments.paidAt,
        failedReason: payments.failedReason,
        paymentProviderCode: paymentProviders.code,
        isDrill: orders.isDrill,
        isTest: orders.isDrill,
        scenario: orders.drillScenario,
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

    const idempotencyKey =
      input.idempotencyKey ?? `legacy-checkout:${createBusinessNo("ORD")}`;
    const idempotentInput = { ...input, idempotencyKey };
    const existing = input.idempotencyKey
      ? await this.findPaymentCreationByIdempotencyKey(
          machine.id,
          idempotencyKey,
        )
      : null;
    if (existing) {
      return await this.restorePaymentCreation(existing);
    }

    const paymentSelection = resolvePaymentSelection(idempotentInput);

    // Resolve provider config before entering the transaction
    let resolvedProviderConfig:
      | import("../payments/payment-provider-config.service").RuntimePaymentProviderConfig
      | null = null;
    if (
      paymentSelection.providerCode !== "mock" ||
      paymentSelection.method === "payment_code"
    ) {
      await this.paymentProviderConfigService.assertMachinePaymentChannelAvailable(
        {
          providerCode: paymentSelection.providerCode,
          method: paymentSelection.method,
          machineId: machine.id,
        },
      );
      if (paymentSelection.providerCode !== "mock") {
        resolvedProviderConfig =
          await this.paymentProviderConfigService.resolveForPayment({
            providerCode: paymentSelection.providerCode,
            machineId: machine.id,
          });
      }
    }

    const qrExpiresMinutes = resolvedProviderConfig
      ? readQrExpiresMinutes(resolvedProviderConfig.publicConfigJson)
      : 15;
    const paymentExpiresAt = new Date(
      Date.now() + qrExpiresMinutes * 60 * 1000,
    );

    if (paymentSelection.method === "payment_code") {
      let draft: LocalPaymentDraft;
      try {
        draft = await this.createLocalMachineOrderDraft(
          idempotentInput,
          machine.id,
          paymentExpiresAt,
          paymentSelection,
          resolvedProviderConfig,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          const replay = await this.findPaymentCreationByIdempotencyKey(
            machine.id,
            idempotencyKey,
          );
          if (replay) return await this.restorePaymentCreation(replay);
        }
        throw error;
      }
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
        paymentId: draft.paymentId,
        paymentNo: draft.paymentNo,
        paymentUrl: null,
        expiresAt: draft.expiresAt,
        totalAmountCents: draft.totalAmountCents,
        paymentProviderCode: draft.providerCode,
      };
    }

    let draft: LocalPaymentDraft;
    try {
      draft = await this.createLocalMachineOrderDraft(
        idempotentInput,
        machine.id,
        paymentExpiresAt,
        paymentSelection,
        resolvedProviderConfig,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.findPaymentCreationByIdempotencyKey(
          machine.id,
          idempotencyKey,
        );
        if (replay) return await this.restorePaymentCreation(replay);
      }
      throw error;
    }

    try {
      const intent = await this.createAndPersistPaymentIntent(
        draft,
        resolvedProviderConfig,
      );
      return this.toPaymentCreationResponse(draft, intent);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.findPaymentCreationByIdempotencyKey(
          machine.id,
          idempotencyKey,
        );
        if (replay) return await this.restorePaymentCreation(replay);
      }
      throw error;
    }
  }

  private async assertMachineOrderLinePlanogramContext(
    tx: DrizzleTransaction,
    machineId: string,
    item: CreateMachineOrderInput["items"][number],
  ): Promise<void> {
    if (!item.planogramVersion || !item.slotId || !item.slotCode) {
      throw new ConflictException("Machine order line context is required");
    }

    const [row] = await tx
      .select({ id: machinePlanogramSlots.id })
      .from(machinePlanogramVersions)
      .innerJoin(
        machinePlanogramSlots,
        eq(
          machinePlanogramSlots.machinePlanogramVersionId,
          machinePlanogramVersions.id,
        ),
      )
      .where(
        and(
          eq(machinePlanogramVersions.machineId, machineId),
          eq(machinePlanogramVersions.planogramVersion, item.planogramVersion),
          eq(machinePlanogramVersions.status, "active"),
          sql`${machinePlanogramVersions.acknowledgedAt} IS NOT NULL`,
          eq(machinePlanogramSlots.slotId, item.slotId),
          eq(machinePlanogramSlots.slotCode, item.slotCode),
          eq(machinePlanogramSlots.inventoryId, item.inventoryId),
        ),
      );

    if (!row) {
      throw new ConflictException(
        "Machine order line planogram context is not active and acknowledged",
      );
    }
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
          productId: products.id,
          productName: products.name,
          sku: productVariants.sku,
          size: productVariants.size,
          color: productVariants.color,
          unitPriceCents: productVariants.priceCents,
          slotId: machineSlots.id,
          slotCode: machineSlots.slotCode,
          slotStatus: machineSlots.status,
          layerNo: machineSlots.layerNo,
          cellNo: machineSlots.cellNo,
          variantStatus: productVariants.status,
          productStatus: products.status,
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
        if (row.slotStatus !== "enabled") {
          throw new ConflictException(`Slot ${row.slotCode} is not available`);
        }
        if (row.variantStatus !== "active" || row.productStatus !== "active") {
          throw new ConflictException("Product is not available");
        }
        assertMachineOrderLineContextMatchesInventory(item, row);
        return {
          ...row,
          quantity: item.quantity,
          planogramVersion: item.planogramVersion,
        };
      });
      await Promise.all(
        input.items.map(async (item) =>
          this.assertMachineOrderLinePlanogramContext(tx, machineId, item),
        ),
      );

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
          paymentState: "awaiting_payment",
          fulfillmentState: "awaiting_fulfillment",
          totalAmountCents,
          currency: "CNY",
          paymentCreationIdempotencyKey: input.idempotencyKey ?? null,
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
        const [orderItem] = await tx
          .insert(orderItems)
          .values({
            orderId: createdOrder.id,
            variantId: item.variantId,
            inventoryId: item.inventoryId,
            slotId: item.slotId,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents,
            planogramVersion: item.planogramVersion,
            productSnapshot: {
              productName: item.productName,
              productId: item.productId,
              variantId: item.variantId,
              inventoryId: item.inventoryId,
              planogramVersion: item.planogramVersion,
              slotId: item.slotId,
              slotCode: item.slotCode,
              layerNo: item.layerNo,
              cellNo: item.cellNo,
              vendingCommandQuantity: item.quantity,
              sku: item.sku,
              size: item.size,
              color: item.color,
            },
          })
          .returning({ id: orderItems.id });
        await this.inventoryService.reserveForOrder(tx, {
          orderId: createdOrder.id,
          orderItemId: orderItem.id,
          inventoryId: item.inventoryId,
          quantity: item.quantity,
          expiresAt: paymentExpiresAt,
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
            ? this.paymentProviderConfigService.createBindingSnapshot(
                resolvedProviderConfig,
              )
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
    lease?: PaymentIntentLease,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [failedPayment] = await tx
        .update(payments)
        .set({
          status: "failed",
          failedReason: reason,
          intentCreationLeaseExpiresAt: null,
          intentCreationLeaseOwnerToken: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(payments.id, draft.paymentId),
            inArray(payments.status, ["created", "processing"]),
            lease
              ? eq(payments.intentCreationLeaseOwnerToken, lease.ownerToken)
              : undefined,
            lease
              ? eq(payments.intentCreationLeaseFence, lease.fence)
              : undefined,
            lease
              ? gt(payments.intentCreationLeaseExpiresAt, new Date())
              : undefined,
          ),
        )
        .returning({ id: payments.id });
      if (!failedPayment) return;

      await tx
        .update(orders)
        .set({
          status: "canceled",
          paymentState: "payment_failed",
          fulfillmentState: "canceled",
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
    resolvedConfig:
      | import("../payments/payment-provider-config.service").RuntimePaymentProviderConfig
      | null,
    providerTradeNo: string | null,
  ): Promise<void> {
    try {
      const provider = this.paymentProviderRegistry.get(draft.providerCode);
      const config = resolvedConfig ?? {
        id: "",
        providerCode: draft.providerCode,
        providerId: "",
        machineId: null,
        merchantNo: null,
        appId: null,
        publicConfigJson: {} as Record<string, unknown>,
        sensitiveConfigJson: {} as Record<string, unknown>,
      };
      await provider.cancelPayment({
        paymentNo: draft.paymentNo,
        providerTradeNo,
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

  private async releaseActiveReservationsForOrder(
    tx: DrizzleTransaction,
    input: { orderId: string; reason: "canceled" },
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

  private async findCancelableMachineOrderRow(
    orderNo: string,
    machineCode: string,
  ): Promise<CancelableMachineOrderRow | null> {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNo: orders.orderNo,
        machineId: orders.machineId,
        orderStatus: orders.status,
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
        paymentId: payments.id,
        paymentNo: payments.paymentNo,
        paymentMethod: payments.method,
        paymentStatus: payments.status,
        providerId: paymentProviders.id,
        providerCode: paymentProviders.code,
        providerTradeNo: payments.providerTradeNo,
        providerConfigId: payments.paymentProviderConfigId,
        providerConfigSnapshotJson: payments.providerConfigSnapshotJson,
      })
      .from(orders)
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .innerJoin(payments, eq(payments.id, orders.paymentId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(and(eq(orders.orderNo, orderNo), eq(machines.code, machineCode)));

    return row ?? null;
  }

  private async assertNoActivePaymentCodeAttempt(
    orderId: string,
  ): Promise<void> {
    const [activeAttempt] = await this.db
      .select({
        id: paymentCodeAttempts.id,
        status: paymentCodeAttempts.status,
      })
      .from(paymentCodeAttempts)
      .where(
        and(
          eq(paymentCodeAttempts.orderId, orderId),
          eq(paymentCodeAttempts.isActive, true),
          inArray(paymentCodeAttempts.status, [
            "created",
            "submitting",
            "user_confirming",
            "querying",
            "unknown",
            "manual_handling",
          ]),
        ),
      )
      .limit(1);

    if (activeAttempt) {
      throw new ConflictException("Payment code confirmation is in progress");
    }
  }

  private assertMachineOrderCanStillBeCanceled(
    row: CancelableMachineOrderCurrentRow,
  ): "already_closed" | "cancelable" {
    if (
      row.orderStatus === "canceled" ||
      row.orderStatus === "payment_expired" ||
      row.paymentStatus === "canceled" ||
      row.paymentStatus === "expired"
    ) {
      return "already_closed";
    }

    if (
      row.paymentState === "paid" ||
      row.paymentStatus === "succeeded" ||
      row.fulfillmentState !== "awaiting_fulfillment"
    ) {
      throw new ConflictException(
        "Paid or dispensing orders cannot be canceled",
      );
    }

    return "cancelable";
  }

  private async cancelProviderPaymentIfNeeded(
    row: CancelableMachineOrderRow,
  ): Promise<Record<string, unknown>> {
    if (row.paymentMethod === "payment_code") {
      await this.assertNoActivePaymentCodeAttempt(row.orderId);
      return { skipped: true, reason: "payment_code_not_submitted" };
    }

    if (row.providerCode === "mock") {
      return { skipped: true, reason: "mock_provider" };
    }

    if (!["created", "pending", "processing"].includes(row.paymentStatus)) {
      return { skipped: true, reason: `payment_status_${row.paymentStatus}` };
    }

    const provider = this.paymentProviderRegistry.get(row.providerCode);
    const config = await this.paymentProviderConfigService
      .resolveForExistingPayment({
        providerCode: row.providerCode,
        providerConfigId: row.providerConfigId,
        machineId: row.machineId,
        providerConfigSnapshotJson: row.providerConfigSnapshotJson,
      })
      .catch(() => ({
        id: "",
        providerCode: row.providerCode,
        providerId: row.providerId,
        machineId: null,
        merchantNo: null,
        appId: null,
        publicConfigJson: {} as Record<string, unknown>,
        sensitiveConfigJson: {} as Record<string, unknown>,
      }));

    try {
      const result = await provider.cancelPayment({
        paymentNo: row.paymentNo,
        providerTradeNo: row.providerTradeNo,
        config,
      });
      return result.rawPayload ?? { status: result.status };
    } catch (error) {
      if (isTradeNotFoundError(error)) {
        return {
          treatedAsCanceled: true,
          reason: "provider_trade_not_found",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (isIndeterminateProviderError(error)) {
        return {
          providerCancelUnknown: true,
          reason: "provider_cancel_indeterminate",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
  }

  async cancelMachineOrder(orderNo: string, query: MachineOrderStatusQuery) {
    const row = await this.findCancelableMachineOrderRow(
      orderNo,
      query.machineCode,
    );

    if (!row) {
      throw new NotFoundException("Machine order not found");
    }

    if (this.assertMachineOrderCanStillBeCanceled(row) === "already_closed") {
      return await this.getMachineOrderStatus(orderNo, query);
    }

    const providerPayload = await this.cancelProviderPaymentIfNeeded(row);

    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          orderStatus: orders.status,
          paymentState: orders.paymentState,
          fulfillmentState: orders.fulfillmentState,
          paymentStatus: payments.status,
        })
        .from(orders)
        .innerJoin(payments, eq(payments.id, orders.paymentId))
        .where(eq(orders.id, row.orderId));

      if (!current) {
        throw new ConflictException("Machine order changed before cancel");
      }
      if (
        this.assertMachineOrderCanStillBeCanceled(current) === "already_closed"
      ) {
        return;
      }

      await tx
        .insert(paymentEvents)
        .values({
          paymentId: row.paymentId,
          providerId: row.providerId,
          eventType: "payment.machine_canceled",
          providerEventId: `machine_cancel:${row.paymentNo}`,
          rawPayloadJson: buildStoredEventPayload({
            paymentNo: row.paymentNo,
            orderNo: row.orderNo,
            providerCode: row.providerCode,
            ...providerPayload,
          }),
          signatureValid: true,
          handledAt: new Date(),
        })
        .onConflictDoNothing();

      const [paymentUpdate] = await tx
        .update(payments)
        .set({
          status: "canceled",
          failedReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(payments.id, row.paymentId),
            inArray(payments.status, ["created", "pending", "processing"]),
          ),
        )
        .returning({ id: payments.id });
      if (!paymentUpdate) {
        throw new ConflictException(
          "Machine order payment changed before cancel",
        );
      }

      const [orderUpdate] = await tx
        .update(orders)
        .set({
          status: "canceled",
          paymentState: "canceled",
          fulfillmentState: "canceled",
          canceledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(orders.id, row.orderId),
            eq(orders.fulfillmentState, "awaiting_fulfillment"),
            inArray(orders.paymentState, [
              "awaiting_payment",
              "payment_failed",
            ]),
          ),
        )
        .returning({ id: orders.id });
      if (!orderUpdate) {
        throw new ConflictException("Machine order changed before cancel");
      }

      if (row.orderStatus !== "canceled") {
        await tx.insert(orderStatusEvents).values({
          orderId: row.orderId,
          fromStatus: row.orderStatus,
          toStatus: "canceled",
          reason: "machine_user_canceled",
        });
      }

      await this.releaseActiveReservationsForOrder(tx, {
        orderId: row.orderId,
        reason: "canceled",
      });
    });

    return await this.getMachineOrderStatus(orderNo, query);
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
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
        totalAmountCents: orders.totalAmountCents,
        isDrill: orders.isDrill,
        isTest: orders.isDrill,
        scenario: orders.drillScenario,
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
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
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
      .select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
        productSnapshot: orderItems.productSnapshot,
      })
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
      .select({
        id: orderStatusEvents.id,
        fromStatus: orderStatusEvents.fromStatus,
        toStatus: orderStatusEvents.toStatus,
        reason: orderStatusEvents.reason,
        metadata: orderStatusEvents.metadata,
        createdAt: orderStatusEvents.createdAt,
      })
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

  async getOrderInvestigation(id: string, permissions: PermissionCode[]) {
    const permissionSet = new Set(permissions);
    const canReadPayments = hasPermission(permissionSet, "payments.read");
    const canReadInventory = hasPermission(permissionSet, "inventory.read");
    const canReadMaintenance = hasPermission(
      permissionSet,
      "maintenanceWorkOrders.read",
    );
    const canReadAudit = hasPermission(permissionSet, "audit.read");
    const canReadPaymentDiagnostics =
      canReadAudit || hasPermission(permissionSet, "payments.configure");

    const [order] = await this.db
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        machineId: orders.machineId,
        machineCode: machines.code,
        status: orders.status,
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
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
      .select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
        productSnapshot: orderItems.productSnapshot,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, id))
      .orderBy(orderItems.createdAt);

    const paymentRows = canReadPayments
      ? await this.db
          .select({
            id: payments.id,
            paymentNo: payments.paymentNo,
            orderId: payments.orderId,
            method: payments.method,
            status: payments.status,
            amountCents: payments.amountCents,
            ...(canReadPaymentDiagnostics
              ? { providerTradeNo: payments.providerTradeNo }
              : {}),
            expiresAt: payments.expiresAt,
            paidAt: payments.paidAt,
            failedReason: payments.failedReason,
            createdAt: payments.createdAt,
            updatedAt: payments.updatedAt,
          })
          .from(payments)
          .where(eq(payments.orderId, id))
          .orderBy(desc(payments.createdAt))
      : [];

    const paymentIds = paymentRows.map((payment) => payment.id);
    const paymentEventRows =
      !canReadPayments || paymentIds.length === 0
        ? []
        : await this.db
            .select({
              id: paymentEvents.id,
              paymentId: paymentEvents.paymentId,
              eventType: paymentEvents.eventType,
              ...(canReadPaymentDiagnostics
                ? { providerEventId: paymentEvents.providerEventId }
                : {}),
              signatureValid: paymentEvents.signatureValid,
              handledAt: paymentEvents.handledAt,
              createdAt: paymentEvents.createdAt,
            })
            .from(paymentEvents)
            .where(inArray(paymentEvents.paymentId, paymentIds))
            .orderBy(desc(paymentEvents.createdAt));

    const paymentWebhookAttemptRows = canReadPayments
      ? await this.db
          .select({
            id: paymentWebhookAttempts.id,
            ...(canReadPaymentDiagnostics
              ? { providerCode: paymentWebhookAttempts.providerCode }
              : {}),
            paymentId: paymentWebhookAttempts.paymentId,
            refundId: paymentWebhookAttempts.refundId,
            eventKind: paymentWebhookAttempts.eventKind,
            eventType: paymentWebhookAttempts.eventType,
            ...(canReadPaymentDiagnostics
              ? { providerEventId: paymentWebhookAttempts.providerEventId }
              : {}),
            paymentNo: paymentWebhookAttempts.paymentNo,
            refundNo: paymentWebhookAttempts.refundNo,
            orderNo: paymentWebhookAttempts.orderNo,
            signatureValid: paymentWebhookAttempts.signatureValid,
            businessValid: paymentWebhookAttempts.businessValid,
            handled: paymentWebhookAttempts.handled,
            duplicate: paymentWebhookAttempts.duplicate,
            failureReason: paymentWebhookAttempts.failureReason,
            ...(canReadPaymentDiagnostics
              ? { errorCode: paymentWebhookAttempts.errorCode }
              : {}),
            httpStatus: paymentWebhookAttempts.httpStatus,
            createdAt: paymentWebhookAttempts.createdAt,
            updatedAt: paymentWebhookAttempts.updatedAt,
          })
          .from(paymentWebhookAttempts)
          .where(
            paymentIds.length === 0
              ? eq(paymentWebhookAttempts.orderNo, order.orderNo)
              : or(
                  eq(paymentWebhookAttempts.orderNo, order.orderNo),
                  inArray(paymentWebhookAttempts.paymentId, paymentIds),
                ),
          )
          .orderBy(desc(paymentWebhookAttempts.createdAt))
      : [];

    const paymentReconciliationAttemptRows =
      !canReadPayments || paymentIds.length === 0
        ? []
        : await this.db
            .select({
              id: paymentReconciliationAttempts.id,
              paymentId: paymentReconciliationAttempts.paymentId,
              trigger: paymentReconciliationAttempts.trigger,
              attemptNo: paymentReconciliationAttempts.attemptNo,
              status: paymentReconciliationAttempts.status,
              ...(canReadPaymentDiagnostics
                ? {
                    providerPaymentStatus:
                      paymentReconciliationAttempts.providerPaymentStatus,
                    providerTradeNo:
                      paymentReconciliationAttempts.providerTradeNo,
                    errorCode: paymentReconciliationAttempts.errorCode,
                    errorMessage: paymentReconciliationAttempts.errorMessage,
                  }
                : {}),
              nextRetryAt: paymentReconciliationAttempts.nextRetryAt,
              startedAt: paymentReconciliationAttempts.startedAt,
              finishedAt: paymentReconciliationAttempts.finishedAt,
              createdAt: paymentReconciliationAttempts.createdAt,
            })
            .from(paymentReconciliationAttempts)
            .where(inArray(paymentReconciliationAttempts.paymentId, paymentIds))
            .orderBy(desc(paymentReconciliationAttempts.createdAt));

    const paymentCodeAttemptRows = canReadPayments
      ? await this.db
          .select({
            id: paymentCodeAttempts.id,
            paymentId: paymentCodeAttempts.paymentId,
            orderId: paymentCodeAttempts.orderId,
            attemptNo: paymentCodeAttempts.attemptNo,
            ...(canReadPaymentDiagnostics
              ? { providerPaymentNo: paymentCodeAttempts.providerPaymentNo }
              : {}),
            idempotencyKey: paymentCodeAttempts.idempotencyKey,
            status: paymentCodeAttempts.status,
            isActive: paymentCodeAttempts.isActive,
            amountCents: paymentCodeAttempts.amountCents,
            currency: paymentCodeAttempts.currency,
            authCodeMasked: paymentCodeAttempts.authCodeMasked,
            source: paymentCodeAttempts.source,
            ...(canReadPaymentDiagnostics
              ? {
                  providerTradeNo: paymentCodeAttempts.providerTradeNo,
                  providerStatus: paymentCodeAttempts.providerStatus,
                  failureCode: paymentCodeAttempts.failureCode,
                  failureMessage: paymentCodeAttempts.failureMessage,
                }
              : {}),
            submittedAt: paymentCodeAttempts.submittedAt,
            lastCheckedAt: paymentCodeAttempts.lastCheckedAt,
            reversedAt: paymentCodeAttempts.reversedAt,
            finishedAt: paymentCodeAttempts.finishedAt,
            manualReason: paymentCodeAttempts.manualReason,
            createdAt: paymentCodeAttempts.createdAt,
            updatedAt: paymentCodeAttempts.updatedAt,
          })
          .from(paymentCodeAttempts)
          .where(eq(paymentCodeAttempts.orderId, id))
          .orderBy(desc(paymentCodeAttempts.createdAt))
      : [];

    const vendingCommandRows = await this.db
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
        orderId: vendingCommands.orderId,
        machineId: vendingCommands.machineId,
        machineCode: machines.code,
        slotId: vendingCommands.slotId,
        slotCode: machineSlots.slotCode,
        orderItemId: vendingCommands.orderItemId,
        commandKind: vendingCommands.commandKind,
        recoveryActionId: vendingCommands.recoveryActionId,
        status: vendingCommands.status,
        sentAt: vendingCommands.sentAt,
        ackAt: vendingCommands.ackAt,
        resultAt: vendingCommands.resultAt,
        retryCount: vendingCommands.retryCount,
        lastError: vendingCommands.lastError,
        createdAt: vendingCommands.createdAt,
        updatedAt: vendingCommands.updatedAt,
      })
      .from(vendingCommands)
      .innerJoin(machines, eq(machines.id, vendingCommands.machineId))
      .innerJoin(machineSlots, eq(machineSlots.id, vendingCommands.slotId))
      .where(eq(vendingCommands.orderId, id))
      .orderBy(desc(vendingCommands.createdAt));
    const vendingCommandIds = vendingCommandRows.map((command) => command.id);

    const inventoryMovementRows = canReadInventory
      ? await this.db
          .select({
            id: inventoryMovements.id,
            inventoryId: inventoryMovements.inventoryId,
            deltaQty: inventoryMovements.deltaQty,
            reason: inventoryMovements.reason,
            orderId: inventoryMovements.orderId,
            operatorAdminUserId: inventoryMovements.operatorAdminUserId,
            note: inventoryMovements.note,
            createdAt: inventoryMovements.createdAt,
          })
          .from(inventoryMovements)
          .where(eq(inventoryMovements.orderId, id))
          .orderBy(desc(inventoryMovements.createdAt))
      : [];

    const stockReconciliationRows = canReadInventory
      ? await this.db
          .select({
            id: machineRawStockMovements.id,
            caseTable: sql<"machine_raw_stock_movements">`'machine_raw_stock_movements'`,
            rawMovementId: sql<string | null>`null`,
            machineId: machineRawStockMovements.machineId,
            movementId: machineRawStockMovements.movementId,
            status: machineRawStockMovements.status,
            reconciliationReason: machineRawStockMovements.reconciliationReason,
            platformReviewStatus: machineRawStockMovements.platformReviewStatus,
            saleSafetyBlockerState:
              machineRawStockMovements.saleSafetyBlockerState,
            saleSafetyBlockerSlotId:
              machineRawStockMovements.saleSafetyBlockerSlotId,
            receivedAt: machineRawStockMovements.receivedAt,
          })
          .from(machineRawStockMovements)
          .where(
            and(
              eq(machineRawStockMovements.machineId, order.machineId),
              or(
                sql`${machineRawStockMovements.normalizedJson}->>'orderId' = ${id}`,
                sql`${machineRawStockMovements.normalizedJson}->>'orderNo' = ${order.orderNo}`,
              ),
            ),
          )
          .orderBy(desc(machineRawStockMovements.receivedAt))
      : [];
    const stockReconciliationConflictRows = canReadInventory
      ? await this.db
          .select({
            id: machineRawStockMovementConflicts.id,
            caseTable: sql<"machine_raw_stock_movement_conflicts">`'machine_raw_stock_movement_conflicts'`,
            rawMovementId: machineRawStockMovementConflicts.rawMovementId,
            machineId: machineRawStockMovementConflicts.machineId,
            movementId: machineRawStockMovementConflicts.movementId,
            status: machineRawStockMovementConflicts.status,
            reconciliationReason:
              machineRawStockMovementConflicts.reconciliationReason,
            platformReviewStatus:
              machineRawStockMovementConflicts.platformReviewStatus,
            saleSafetyBlockerState:
              machineRawStockMovementConflicts.saleSafetyBlockerState,
            saleSafetyBlockerSlotId:
              machineRawStockMovementConflicts.saleSafetyBlockerSlotId,
            receivedAt: machineRawStockMovementConflicts.receivedAt,
          })
          .from(machineRawStockMovementConflicts)
          .where(
            and(
              eq(machineRawStockMovementConflicts.machineId, order.machineId),
              or(
                sql`${machineRawStockMovementConflicts.normalizedJson}->>'orderId' = ${id}`,
                sql`${machineRawStockMovementConflicts.normalizedJson}->>'orderNo' = ${order.orderNo}`,
                sql`${machineRawStockMovementConflicts.payloadJson}->'orderContext'->>'orderNo' = ${order.orderNo}`,
              ),
            ),
          )
          .orderBy(desc(machineRawStockMovementConflicts.receivedAt))
      : [];
    const stockReconciliationLinks = [
      ...stockReconciliationRows,
      ...stockReconciliationConflictRows,
    ].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

    const refundRows = canReadPayments
      ? await this.db
          .select({
            id: refunds.id,
            refundNo: refunds.refundNo,
            paymentId: refunds.paymentId,
            orderId: refunds.orderId,
            amountCents: refunds.amountCents,
            status: refunds.status,
            ...(canReadPaymentDiagnostics
              ? { providerRefundNo: refunds.providerRefundNo }
              : {}),
            reason: refunds.reason,
            requestedByAdminUserId: refunds.requestedByAdminUserId,
            refundedAt: refunds.refundedAt,
            createdAt: refunds.createdAt,
            updatedAt: refunds.updatedAt,
          })
          .from(refunds)
          .where(eq(refunds.orderId, id))
          .orderBy(desc(refunds.createdAt))
      : [];
    const refundIds = refundRows.map((refund) => refund.id);
    const refundReconciliationAttemptRows =
      canReadPayments && refundIds.length > 0
        ? await this.db
            .select({
              refundId: refundReconciliationAttempts.refundId,
              trigger: refundReconciliationAttempts.trigger,
              attemptNo: refundReconciliationAttempts.attemptNo,
              status: refundReconciliationAttempts.status,
              ...(canReadPaymentDiagnostics
                ? {
                    providerRefundStatus:
                      refundReconciliationAttempts.providerRefundStatus,
                    providerRefundNo:
                      refundReconciliationAttempts.providerRefundNo,
                    errorCode: refundReconciliationAttempts.errorCode,
                    errorMessage: refundReconciliationAttempts.errorMessage,
                  }
                : {}),
              nextRetryAt: refundReconciliationAttempts.nextRetryAt,
              startedAt: refundReconciliationAttempts.startedAt,
              finishedAt: refundReconciliationAttempts.finishedAt,
              createdAt: refundReconciliationAttempts.createdAt,
            })
            .from(refundReconciliationAttempts)
            .where(inArray(refundReconciliationAttempts.refundId, refundIds))
            .orderBy(desc(refundReconciliationAttempts.createdAt))
        : [];
    const refundRowsWithAttempts = refundRows.map((refund) => ({
      ...refund,
      reconciliationAttempts: refundReconciliationAttemptRows
        .filter((attempt) => attempt.refundId === refund.id)
        .slice(0, 5),
    }));
    const [activeRefundCount] = await this.db
      .select({ total: count() })
      .from(refunds)
      .where(
        and(
          eq(refunds.orderId, id),
          inArray(refunds.status, ACTIVE_REFUND_STATUSES),
        ),
      );
    const activeRefundExists = Number(activeRefundCount.total) > 0;

    const recoveryActionRows = await this.db
      .select({
        id: orderRecoveryActions.id,
        commandId: orderRecoveryActions.commandId,
        action: orderRecoveryActions.action,
        status: orderRecoveryActions.status,
      })
      .from(orderRecoveryActions)
      .where(eq(orderRecoveryActions.orderId, id))
      .orderBy(desc(orderRecoveryActions.createdAt));

    const maintenanceWorkOrderRows = canReadMaintenance
      ? await this.db
          .select({
            id: maintenanceWorkOrders.id,
            workOrderNo: maintenanceWorkOrders.workOrderNo,
            machineId: maintenanceWorkOrders.machineId,
            slotId: maintenanceWorkOrders.slotId,
            orderId: maintenanceWorkOrders.orderId,
            commandId: maintenanceWorkOrders.commandId,
            title: maintenanceWorkOrders.title,
            priority: maintenanceWorkOrders.priority,
            status: maintenanceWorkOrders.status,
            assigneeAdminUserId: maintenanceWorkOrders.assigneeAdminUserId,
            createdAt: maintenanceWorkOrders.createdAt,
            updatedAt: maintenanceWorkOrders.updatedAt,
            resolvedAt: maintenanceWorkOrders.resolvedAt,
          })
          .from(maintenanceWorkOrders)
          .where(
            vendingCommandIds.length === 0
              ? eq(maintenanceWorkOrders.orderId, id)
              : or(
                  eq(maintenanceWorkOrders.orderId, id),
                  inArray(maintenanceWorkOrders.commandId, vendingCommandIds),
                ),
          )
          .orderBy(desc(maintenanceWorkOrders.createdAt))
      : [];
    const maintenanceWorkOrderIds = maintenanceWorkOrderRows.map(
      (workOrder) => workOrder.id,
    );

    const auditResourcePairs: Array<{
      resourceType: string;
      resourceId: string;
    }> = [
      { resourceType: "order", resourceId: id },
      ...vendingCommandIds.flatMap((resourceId) => [
        { resourceType: "vending_command", resourceId },
        { resourceType: "vending_commands", resourceId },
      ]),
      ...(canReadPayments
        ? [
            ...paymentIds.map((resourceId) => ({
              resourceType: "payment",
              resourceId,
            })),
            ...refundIds.map((resourceId) => ({
              resourceType: "refund",
              resourceId,
            })),
          ]
        : []),
      ...(canReadInventory
        ? [
            ...inventoryMovementRows.flatMap((movement) => [
              { resourceType: "inventory_movement", resourceId: movement.id },
              { resourceType: "inventory_movements", resourceId: movement.id },
            ]),
            ...stockReconciliationLinks.flatMap((movement) => [
              {
                resourceType:
                  movement.caseTable === "machine_raw_stock_movement_conflicts"
                    ? "machine_raw_stock_movement_conflict"
                    : "machine_raw_stock_movement",
                resourceId: movement.id,
              },
              {
                resourceType:
                  movement.caseTable === "machine_raw_stock_movement_conflicts"
                    ? "machine_raw_stock_movement_conflicts"
                    : "machine_raw_stock_movements",
                resourceId: movement.id,
              },
            ]),
          ]
        : []),
      ...(canReadMaintenance
        ? maintenanceWorkOrderIds.flatMap((resourceId) => [
            { resourceType: "maintenance_work_order", resourceId },
            { resourceType: "maintenance_work_orders", resourceId },
          ])
        : []),
    ];

    const adminAuditRows = canReadAudit
      ? await this.db
          .select({
            id: auditLogs.id,
            adminUserId: auditLogs.adminUserId,
            action: auditLogs.action,
            resourceType: auditLogs.resourceType,
            resourceId: auditLogs.resourceId,
            ipAddress: auditLogs.ipAddress,
            userAgent: auditLogs.userAgent,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(
            or(
              ...auditResourcePairs.map((pair) =>
                and(
                  eq(auditLogs.resourceType, pair.resourceType),
                  eq(auditLogs.resourceId, pair.resourceId),
                ),
              ),
            ),
          )
          .orderBy(desc(auditLogs.createdAt))
      : [];

    const orderStatusEventRows = await this.db
      .select({
        id: orderStatusEvents.id,
        fromStatus: orderStatusEvents.fromStatus,
        toStatus: orderStatusEvents.toStatus,
        reason: orderStatusEvents.reason,
        metadata: orderStatusEvents.metadata,
        createdAt: orderStatusEvents.createdAt,
      })
      .from(orderStatusEvents)
      .where(eq(orderStatusEvents.orderId, id))
      .orderBy(desc(orderStatusEvents.createdAt));
    const recoveryProjection = this.buildRecoveryProjection({
      order,
      vendingCommandRows,
      orderStatusEventRows,
      recoveryActionRows,
      activeRefundExists,
    });

    return toOrderInvestigationResponse({
      order,
      items,
      payments: paymentRows,
      paymentEvents: paymentEventRows,
      paymentWebhookAttempts: paymentWebhookAttemptRows,
      paymentReconciliationAttempts: paymentReconciliationAttemptRows,
      paymentCodeAttempts: paymentCodeAttemptRows,
      vendingCommands: vendingCommandRows,
      fulfillmentProjection: {
        state: order.fulfillmentState,
        latestCommand: vendingCommandRows[0] ?? null,
        ...recoveryProjection,
      },
      inventoryMovements: inventoryMovementRows,
      stockReconciliationLinks,
      refunds: refundRowsWithAttempts,
      maintenanceWorkOrders: maintenanceWorkOrderRows,
      adminAuditEntries: adminAuditRows,
      orderStatusEvents: orderStatusEventRows,
    });
  }

  async requestMockRefund(orderId: string, adminUserId: string) {
    const refund = await this.refundsService.requestFullRefund({
      orderId,
      reason: "admin_refund",
      requestedByAdminUserId: adminUserId,
    });
    return toOrderRefundRequestResponse(refund);
  }

  private buildRecoveryProjection(input: {
    order: { fulfillmentState: OrderFulfillmentState };
    vendingCommandRows: Array<{ id: string; status: VendingCommandStatus }>;
    orderStatusEventRows: Array<{ metadata: unknown }>;
    recoveryActionRows: RecoveryActionRow[];
    activeRefundExists: boolean;
  }): {
    requiresPhysicalOutcomeConfirmation: boolean;
    availableRecoveryActions: RecoveryActionName[];
  } {
    const terminalRecoveryExists =
      input.activeRefundExists ||
      input.recoveryActionRows.some(
        (row) =>
          row.action === "confirm_dispensed" ||
          row.action === "request_refund" ||
          row.action === "compensation_dispense",
      );
    if (terminalRecoveryExists) {
      return {
        requiresPhysicalOutcomeConfirmation: false,
        availableRecoveryActions: [],
      };
    }

    const confirmedNotDispensed = input.recoveryActionRows.some((row) =>
      isCompletedAction(row, "confirm_not_dispensed"),
    );
    if (confirmedNotDispensed) {
      return {
        requiresPhysicalOutcomeConfirmation: false,
        availableRecoveryActions: ["request_refund", "compensation_dispense"],
      };
    }
    const physicalOutcomeActionExists = input.recoveryActionRows.some(
      (row) =>
        row.action === "confirm_dispensed" ||
        row.action === "confirm_not_dispensed",
    );
    if (physicalOutcomeActionExists) {
      return {
        requiresPhysicalOutcomeConfirmation: false,
        availableRecoveryActions: [],
      };
    }

    const hasPhysicalOutcomeBlocker =
      input.order.fulfillmentState === "manual_handling" &&
      (input.vendingCommandRows.some(
        (command) => command.status === "result_unknown",
      ) ||
        input.orderStatusEventRows.some((event) => {
          const metadata = event.metadata;
          return (
            typeof metadata === "object" &&
            metadata !== null &&
            Reflect.get(metadata, "requiresPhysicalOutcomeConfirmation") ===
              true
          );
        }));

    return {
      requiresPhysicalOutcomeConfirmation: hasPhysicalOutcomeBlocker,
      availableRecoveryActions: hasPhysicalOutcomeBlocker
        ? ["confirm_dispensed", "confirm_not_dispensed"]
        : [],
    };
  }

  private async startRecoveryAction(
    orderId: string,
    adminUserId: string,
    action: RecoveryActionName,
    note: string,
  ): Promise<{
    actionId: string;
    command: {
      id: string;
      commandNo: string;
      status: VendingCommandStatus;
    };
  }> {
    try {
      return await this.db.transaction(async (tx) => {
        const commandRows = await tx
          .select({
            id: vendingCommands.id,
            commandNo: vendingCommands.commandNo,
            status: vendingCommands.status,
            orderStatus: orders.status,
            fulfillmentState: orders.fulfillmentState,
            isDrill: orders.isDrill,
          })
          .from(vendingCommands)
          .innerJoin(orders, eq(orders.id, vendingCommands.orderId))
          .where(eq(vendingCommands.orderId, orderId))
          .orderBy(desc(vendingCommands.createdAt));
        if (commandRows.length === 0) {
          throw new NotFoundException("Vending command not found for order");
        }
        if (commandRows.some((row) => row.isDrill)) {
          throw new ConflictException(
            "Protected drill recovery uses drill simulation endpoints",
          );
        }

        const recoveryActionRows = await tx
          .select({
            id: orderRecoveryActions.id,
            commandId: orderRecoveryActions.commandId,
            action: orderRecoveryActions.action,
            status: orderRecoveryActions.status,
          })
          .from(orderRecoveryActions)
          .where(eq(orderRecoveryActions.orderId, orderId));

        const activeRefundRows = await tx
          .select({ id: refunds.id })
          .from(refunds)
          .where(
            and(
              eq(refunds.orderId, orderId),
              inArray(refunds.status, ACTIVE_REFUND_STATUSES),
            ),
          )
          .limit(1);

        const command =
          action === "request_refund" || action === "compensation_dispense"
            ? this.findConfirmedNotDispensedCommand(
                commandRows,
                recoveryActionRows,
              )
            : commandRows.find((row) => row.status === "result_unknown");
        if (!command) {
          const latest = commandRows[0];
          throw new ConflictException(
            `Order recovery is not available for command status ${latest.status}`,
          );
        }

        if (
          (action === "confirm_dispensed" ||
            action === "confirm_not_dispensed") &&
          (command.status !== "result_unknown" ||
            command.fulfillmentState !== "manual_handling")
        ) {
          throw new ConflictException(
            `Order recovery is not available for command status ${command.status}`,
          );
        }

        if (
          (action === "request_refund" || action === "compensation_dispense") &&
          !recoveryActionRows.some((row) =>
            isCompletedAction(row, "confirm_not_dispensed"),
          )
        ) {
          throw new ConflictException(
            "Refund or compensation recovery requires confirmed not-dispensed recovery first",
          );
        }

        if (
          (action === "request_refund" || action === "compensation_dispense") &&
          activeRefundRows.length > 0
        ) {
          throw new ConflictException(
            "Refund and compensation recovery actions are mutually exclusive",
          );
        }

        const [created] = await tx
          .insert(orderRecoveryActions)
          .values(
            mapOrderRecoveryActionDtoToInsert({
              orderId,
              commandId: command.id,
              adminUserId,
              body: { action, note },
            }),
          )
          .returning({ id: orderRecoveryActions.id });

        return {
          actionId: created.id,
          command: {
            id: command.id,
            commandNo: command.commandNo,
            status: command.status,
          },
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("Recovery action already recorded");
      }
      throw error;
    }
  }

  private findConfirmedNotDispensedCommand(
    commandRows: Array<{
      id: string;
      commandNo: string;
      status: VendingCommandStatus;
      orderStatus: OrderStatus;
      fulfillmentState: OrderFulfillmentState;
    }>,
    recoveryActionRows: RecoveryActionRow[],
  ) {
    const confirmation = recoveryActionRows.find((row) =>
      isCompletedAction(row, "confirm_not_dispensed"),
    );
    if (!confirmation) return null;
    return (
      commandRows.find((command) => command.id === confirmation.commandId) ??
      null
    );
  }

  private async completeRecoveryAction(
    actionId: string,
    resultJson: Record<string, unknown>,
  ): Promise<void> {
    await this.db
      .update(orderRecoveryActions)
      .set({
        status: "completed",
        resultJson,
        updatedAt: new Date(),
      })
      .where(eq(orderRecoveryActions.id, actionId));
  }

  private async failRecoveryAction(
    actionId: string,
    error: unknown,
  ): Promise<void> {
    await this.db
      .update(orderRecoveryActions)
      .set({
        status: "failed",
        resultJson: {
          error: error instanceof Error ? error.message : String(error),
        },
        updatedAt: new Date(),
      })
      .where(eq(orderRecoveryActions.id, actionId));
  }

  async createRecoveryAction(
    orderId: string,
    adminUserId: string,
    input: OrderRecoveryAction,
  ) {
    const action = normalizeRecoveryAction(input);
    const recovery = await this.startRecoveryAction(
      orderId,
      adminUserId,
      action,
      input.note,
    );
    const auditAction = `orders.recovery.${action}`;

    try {
      if (action === "request_refund") {
        const refund = await this.requestMockRefund(orderId, adminUserId);
        await this.completeRecoveryAction(recovery.actionId, { refund });
        await this.auditService.record({
          adminUserId,
          action: auditAction,
          resourceType: "order",
          resourceId: orderId,
          beforeJson: {
            recoveryActionId: recovery.actionId,
            commandId: recovery.command.id,
            commandNo: recovery.command.commandNo,
            commandStatus: recovery.command.status,
          },
          afterJson: {
            note: input.note,
            recoveryActionId: recovery.actionId,
            commandId: recovery.command.id,
            commandNo: recovery.command.commandNo,
            refund,
          },
        });
        return toOrderRecoveryActionResponse({
          action,
          recoveryActionId: recovery.actionId,
          commandId: recovery.command.id,
          status: "refund_requested" as const,
        });
      }

      if (action === "compensation_dispense") {
        const compensation =
          await this.vendingService.createCompensationDispenseCommand({
            orderId,
            recoveryActionId: recovery.actionId,
            originalCommandNo: recovery.command.commandNo,
            note: input.note,
          });
        await this.completeRecoveryAction(recovery.actionId, {
          compensationCommandId: compensation.id,
          compensationCommandNo: compensation.commandNo,
          compensationStatus: compensation.status,
        });
        await this.auditService.record({
          adminUserId,
          action: auditAction,
          resourceType: "order",
          resourceId: orderId,
          beforeJson: {
            recoveryActionId: recovery.actionId,
            commandId: recovery.command.id,
            commandNo: recovery.command.commandNo,
            commandStatus: recovery.command.status,
          },
          afterJson: {
            note: input.note,
            recoveryActionId: recovery.actionId,
            originalCommandNo: recovery.command.commandNo,
            compensationCommandId: compensation.id,
            compensationCommandNo: compensation.commandNo,
            compensationStatus: compensation.status,
          },
        });
        return toOrderRecoveryActionResponse({
          action,
          recoveryActionId: recovery.actionId,
          commandId: compensation.id,
          commandNo: compensation.commandNo,
          status: compensation.status,
        });
      }

      const result = await this.vendingService.resolveCommand(
        recovery.command.id,
        {
          result:
            action === "confirm_dispensed" ? "dispensed" : "not_dispensed",
          note: input.note,
          requestRefund: false,
        },
      );
      await this.completeRecoveryAction(recovery.actionId, { result });
      await this.auditService.record({
        adminUserId,
        action: auditAction,
        resourceType: "order",
        resourceId: orderId,
        beforeJson: {
          recoveryActionId: recovery.actionId,
          commandId: recovery.command.id,
          commandNo: recovery.command.commandNo,
          commandStatus: recovery.command.status,
        },
        afterJson: {
          note: input.note,
          recoveryActionId: recovery.actionId,
          commandId: recovery.command.id,
          commandNo: recovery.command.commandNo,
          result,
        },
      });

      return toOrderRecoveryActionResponse({
        action,
        recoveryActionId: recovery.actionId,
        commandId: recovery.command.id,
        status: result.status,
      });
    } catch (error) {
      await this.failRecoveryAction(recovery.actionId, error);
      throw error;
    }
  }

  async getMachineOrderStatus(orderNo: string, query: MachineOrderStatusQuery) {
    let row = await this.findMachineOrderStatusRow(orderNo, query.machineCode);

    if (!row) {
      throw new NotFoundException("Machine order not found");
    }

    if (
      row.paymentMethod === "qr_code" &&
      !row.isDrill &&
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
        commandId: vendingCommands.id,
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

    const [paymentReconciliationAttempt] = await this.db
      .select({
        trigger: paymentReconciliationAttempts.trigger,
        attemptNo: paymentReconciliationAttempts.attemptNo,
        status: paymentReconciliationAttempts.status,
        providerPaymentStatus:
          paymentReconciliationAttempts.providerPaymentStatus,
        errorCode: paymentReconciliationAttempts.errorCode,
        nextRetryAt: paymentReconciliationAttempts.nextRetryAt,
        startedAt: paymentReconciliationAttempts.startedAt,
        finishedAt: paymentReconciliationAttempts.finishedAt,
      })
      .from(paymentReconciliationAttempts)
      .where(eq(paymentReconciliationAttempts.paymentId, row.paymentId))
      .orderBy(desc(paymentReconciliationAttempts.createdAt))
      .limit(1);

    const nextAction = resolveMachineOrderNextAction(
      row.paymentState,
      row.fulfillmentState,
      row.paymentStatus,
      command?.status ?? null,
      paymentCodeAttempt?.status ?? null,
    );

    return {
      orderId: row.orderId,
      orderNo: row.orderNo,
      machineCode: row.machineCode,
      orderStatus: row.orderStatus,
      paymentState: row.paymentState,
      fulfillmentState: row.fulfillmentState,
      totalAmountCents: row.totalAmountCents,
      payment: {
        paymentId: row.paymentId,
        paymentNo: row.paymentNo,
        method: row.paymentMethod,
        status: row.paymentStatus,
        paymentUrl: shouldExposePaymentUrl(row) ? row.paymentUrl : null,
        expiresAt: toIsoStringOrNull(row.paymentExpiresAt),
        paidAt: toIsoStringOrNull(row.paidAt),
        failedReason: row.failedReason,
        providerCode: row.paymentProviderCode,
        reconciliation: paymentReconciliationAttempt
          ? {
              trigger: paymentReconciliationAttempt.trigger,
              attemptNo: paymentReconciliationAttempt.attemptNo,
              status: paymentReconciliationAttempt.status,
              providerPaymentStatus:
                paymentReconciliationAttempt.providerPaymentStatus,
              errorCode: paymentReconciliationAttempt.errorCode,
              nextRetryAt: toIsoStringOrNull(
                paymentReconciliationAttempt.nextRetryAt,
              ),
              startedAt: toIsoStringOrNull(
                paymentReconciliationAttempt.startedAt,
              ),
              finishedAt: toIsoStringOrNull(
                paymentReconciliationAttempt.finishedAt,
              ),
            }
          : null,
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
            message: describePaymentCodeAttempt(
              paymentCodeAttempt.status,
              paymentCodeAttempt.failureMessage,
            ),
          }
        : null,
      vending: command
        ? {
            commandId: command.commandId,
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
    input: {
      paymentNo: string;
      orderNo: string;
      amountCents: number;
      expiresAt: Date;
    },
    resolvedConfig:
      | import("../payments/payment-provider-config.service").RuntimePaymentProviderConfig
      | null,
  ) {
    const provider = this.paymentProviderRegistry.get(method);
    const config = resolvedConfig ?? {
      providerCode: method,
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    };
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("payment provider request timeout"));
      }, PAYMENT_INTENT_PROVIDER_DEADLINE_MS);
    });
    try {
      return await Promise.race([
        provider.createPaymentIntent({ ...input, config }),
        timeout,
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async findPaymentCreationByIdempotencyKey(
    machineId: string,
    idempotencyKey: string,
  ): Promise<ExistingPaymentCreation | null> {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNo: orders.orderNo,
        paymentId: payments.id,
        paymentNo: payments.paymentNo,
        providerCode: paymentProviders.code,
        paymentMethod: payments.method,
        machineId: orders.machineId,
        totalAmountCents: payments.amountCents,
        expiresAt: payments.expiresAt,
        paymentStatus: payments.status,
        paymentUrl: payments.paymentUrl,
        providerTradeNo: payments.providerTradeNo,
        providerConfigId: payments.paymentProviderConfigId,
        providerConfigSnapshotJson: payments.providerConfigSnapshotJson,
        intentCreationLeaseExpiresAt: payments.intentCreationLeaseExpiresAt,
        intentCreationLeaseOwnerToken: payments.intentCreationLeaseOwnerToken,
        intentCreationLeaseFence: payments.intentCreationLeaseFence,
        failedReason: payments.failedReason,
      })
      .from(orders)
      .innerJoin(payments, eq(payments.id, orders.paymentId))
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(
        and(
          eq(orders.machineId, machineId),
          eq(orders.paymentCreationIdempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (!row) return null;

    const reservations = await this.loadActiveReservationsForOrder(row.orderId);
    return {
      ...row,
      expiresAt: row.expiresAt ?? new Date(),
      paymentMethod: row.paymentMethod,
      reservations,
    };
  }

  private async loadActiveReservationsForOrder(
    orderId: string,
  ): Promise<Array<{ inventoryId: string; quantity: number }>> {
    return await this.db
      .select({
        inventoryId: inventoryReservations.inventoryId,
        quantity: inventoryReservations.quantity,
      })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.orderId, orderId),
          eq(inventoryReservations.status, "active"),
        ),
      );
  }

  private toPaymentCreationResponse(
    draft: Pick<
      LocalPaymentDraft,
      | "orderId"
      | "orderNo"
      | "paymentId"
      | "paymentNo"
      | "expiresAt"
      | "totalAmountCents"
      | "providerCode"
    >,
    intent: { paymentUrl: string; initialStatus?: PaymentStatus },
  ) {
    const status = intent.initialStatus ?? "pending";
    return {
      orderId: draft.orderId,
      orderNo: draft.orderNo,
      paymentId: draft.paymentId,
      paymentNo: draft.paymentNo,
      paymentUrl: status === "pending" ? intent.paymentUrl : null,
      expiresAt: draft.expiresAt,
      totalAmountCents: draft.totalAmountCents,
      paymentProviderCode: draft.providerCode,
    };
  }

  private async restorePaymentCreation(existing: ExistingPaymentCreation) {
    if (existing.paymentMethod === "payment_code") {
      return this.toPaymentCreationResponse(existing, {
        paymentUrl: "",
        initialStatus: "processing",
      });
    }
    if (
      existing.paymentUrl ||
      !["created", "pending", "processing"].includes(existing.paymentStatus)
    ) {
      return this.toPaymentCreationResponse(existing, {
        paymentUrl: existing.paymentUrl ?? "",
        initialStatus: existing.paymentStatus,
      });
    }

    let mustClaimReconciledRetry =
      existing.paymentStatus === "pending" &&
      existing.failedReason === "provider_trade_not_exist";
    if (existing.paymentStatus === "processing") {
      const reconciliation =
        (await this.paymentsService?.reconcilePendingPaymentOnRead(
          existing.paymentId,
        )) ?? { status: "processing" as const, reconciled: false };
      if (reconciliation.status !== "pending") {
        return this.toPaymentCreationResponse(existing, {
          paymentUrl: "",
          initialStatus:
            reconciliation.status === "not_found"
              ? existing.paymentStatus
              : reconciliation.status,
        });
      }
      // An acknowledged waiting trade is a presentation/polling state, not a
      // permission to recreate the provider trade. Only Alipay's explicit,
      // signed TRADE_NOT_EXIST reconciliation result permits the same payment
      // number to be precreated again.
      if (reconciliation.reason !== "provider_trade_not_exist") {
        return this.toPaymentCreationResponse(existing, {
          paymentUrl: "",
          initialStatus: "processing",
        });
      }
      mustClaimReconciledRetry = true;
    }

    if (
      mustClaimReconciledRetry &&
      !(await claimReconciledPaymentForIntentCreation(
        this.db,
        existing.paymentId,
      ))
    ) {
      return this.toPaymentCreationResponse(existing, {
        paymentUrl: "",
        initialStatus: "processing",
      });
    }

    const config = await this.resolveExistingPaymentConfig(existing);
    const intent = await this.createAndPersistPaymentIntent(existing, config);
    return this.toPaymentCreationResponse(existing, intent);
  }

  private async resolveExistingPaymentConfig(payment: ExistingPaymentCreation) {
    if (payment.providerCode === "mock") {
      return null;
    }
    return await this.paymentProviderConfigService.resolveForExistingPayment({
      providerCode: payment.providerCode,
      providerConfigId: payment.providerConfigId,
      machineId: payment.machineId,
      providerConfigSnapshotJson: payment.providerConfigSnapshotJson,
    });
  }

  private async createAndPersistPaymentIntent(
    draft: LocalPaymentDraft,
    resolvedConfig:
      | import("../payments/payment-provider-config.service").RuntimePaymentProviderConfig
      | null,
  ) {
    const existing = this.paymentIntentCreationInFlight.get(draft.paymentId);
    if (existing) return await existing;

    const task = this.claimAndPersistPaymentIntent(draft, resolvedConfig);
    this.paymentIntentCreationInFlight.set(draft.paymentId, task);
    try {
      return await task;
    } finally {
      this.paymentIntentCreationInFlight.delete(draft.paymentId);
    }
  }

  private async claimAndPersistPaymentIntent(
    draft: LocalPaymentDraft,
    resolvedConfig:
      | import("../payments/payment-provider-config.service").RuntimePaymentProviderConfig
      | null,
  ) {
    const now = new Date();
    const lease: Omit<PaymentIntentLease, "fence"> = {
      ownerToken: randomUUID(),
      expiresAt: new Date(now.getTime() + PAYMENT_INTENT_CREATION_LEASE_MS),
    };
    const [claimed] = await this.db
      .update(payments)
      .set({
        intentCreationLeaseExpiresAt: lease.expiresAt,
        intentCreationLeaseOwnerToken: lease.ownerToken,
        intentCreationLeaseFence: sql`${payments.intentCreationLeaseFence} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(payments.id, draft.paymentId),
          isNull(payments.paymentUrl),
          inArray(payments.status, ["created", "processing"]),
          or(
            isNull(payments.intentCreationLeaseExpiresAt),
            lt(payments.intentCreationLeaseExpiresAt, now),
          ),
        ),
      )
      .returning({
        id: payments.id,
        fence: payments.intentCreationLeaseFence,
      });

    if (!claimed) {
      return {
        providerTradeNo: null,
        paymentUrl: "",
        initialStatus: "processing" as const,
      };
    }

    const claimedLease: PaymentIntentLease = {
      ...lease,
      fence: claimed.fence,
    };

    let intent: Awaited<ReturnType<typeof this.createPaymentIntent>>;
    const heartbeat = setInterval(() => {
      void this.renewPaymentIntentLease(draft.paymentId, claimedLease);
    }, PAYMENT_INTENT_CREATION_LEASE_HEARTBEAT_MS);
    try {
      intent = await this.createPaymentIntent(
        draft.providerCode,
        {
          paymentNo: draft.paymentNo,
          orderNo: draft.orderNo,
          amountCents: draft.totalAmountCents,
          expiresAt: draft.expiresAt,
        },
        resolvedConfig,
      );
    } catch (error) {
      if (isIndeterminateProviderError(error)) {
        await this.markPaymentCreationUncertain(draft, error, claimedLease);
      } else {
        await this.cancelLocalCreatedPayment(
          draft,
          "provider_create_failed",
          error,
          claimedLease,
        );
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
    const initialStatus = intent.initialStatus ?? "pending";
    try {
      const [persisted] = await this.db
        .update(payments)
        .set({
          status: initialStatus,
          failedReason: null,
          providerTradeNo: intent.providerTradeNo,
          paymentUrl: intent.paymentUrl,
          expiresAt: draft.expiresAt,
          intentCreationLeaseExpiresAt: null,
          intentCreationLeaseOwnerToken: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(payments.id, draft.paymentId),
            inArray(payments.status, ["created", "processing"]),
            eq(payments.intentCreationLeaseOwnerToken, claimedLease.ownerToken),
            eq(payments.intentCreationLeaseFence, claimedLease.fence),
            gt(payments.intentCreationLeaseExpiresAt, new Date()),
          ),
        )
        .returning({ id: payments.id });
      if (!persisted) {
        return await this.readPaymentIntentAfterLostLease(draft.paymentId);
      }
    } catch (error) {
      // A database write error leaves the provider outcome uncertain. Cancel
      // only after a fresh, fenced ownership check; an expired or superseded
      // worker must never cancel a successor's provider trade or release its
      // inventory reservation.
      if (
        await this.hasCurrentPaymentIntentLease(draft.paymentId, claimedLease)
      ) {
        await this.cancelProviderIntentAfterDbFailure(
          draft,
          resolvedConfig,
          intent.providerTradeNo,
        );
        await this.cancelLocalCreatedPayment(
          draft,
          "provider_created_db_update_failed",
          error,
          claimedLease,
        );
      }
      throw error;
    }
    return intent;
  }

  /**
   * A stale lease owner may have received a valid provider QR but it is never
   * allowed to present that QR unless its fenced persistence succeeded. Read
   * the successor's durable state instead; callers can retry/join when no QR
   * has been committed yet.
   */
  private async readPaymentIntentAfterLostLease(paymentId: string) {
    const [successor] = await this.db
      .select({
        paymentUrl: payments.paymentUrl,
        status: payments.status,
        providerTradeNo: payments.providerTradeNo,
      })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    if (successor?.status === "pending" && successor.paymentUrl) {
      return {
        providerTradeNo: successor.providerTradeNo,
        paymentUrl: successor.paymentUrl,
        initialStatus: "pending" as const,
      };
    }
    return {
      providerTradeNo: successor?.providerTradeNo ?? null,
      paymentUrl: "",
      initialStatus: "processing" as const,
    };
  }

  private async markPaymentCreationUncertain(
    draft: Pick<LocalPaymentDraft, "paymentId">,
    error: unknown,
    lease: PaymentIntentLease,
  ): Promise<void> {
    const updated = await this.db
      .update(payments)
      .set({
        status: "processing",
        failedReason:
          `provider_create_uncertain:${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            500,
          ),
        intentCreationLeaseExpiresAt: null,
        intentCreationLeaseOwnerToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(payments.id, draft.paymentId),
          inArray(payments.status, ["created", "processing"]),
          eq(payments.intentCreationLeaseOwnerToken, lease.ownerToken),
          eq(payments.intentCreationLeaseFence, lease.fence),
          gt(payments.intentCreationLeaseExpiresAt, new Date()),
        ),
      )
      .returning({ id: payments.id });
    // A successor owns the recovery if the fence no longer matches. Do not
    // overwrite its reason or clear its lease from this stale worker.
    if (updated.length === 0) return;
  }

  private async hasCurrentPaymentIntentLease(
    paymentId: string,
    lease: PaymentIntentLease,
  ): Promise<boolean> {
    const [current] = await this.db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.id, paymentId),
          eq(payments.intentCreationLeaseOwnerToken, lease.ownerToken),
          eq(payments.intentCreationLeaseFence, lease.fence),
          gt(payments.intentCreationLeaseExpiresAt, new Date()),
        ),
      )
      .limit(1);
    return Boolean(current);
  }

  private async renewPaymentIntentLease(
    paymentId: string,
    lease: PaymentIntentLease,
  ): Promise<boolean> {
    const renewed = await this.db
      .update(payments)
      .set({
        intentCreationLeaseExpiresAt: new Date(
          Date.now() + PAYMENT_INTENT_CREATION_LEASE_MS,
        ),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(payments.id, paymentId),
          inArray(payments.status, ["created", "processing"]),
          eq(payments.intentCreationLeaseOwnerToken, lease.ownerToken),
          eq(payments.intentCreationLeaseFence, lease.fence),
          // A worker cannot revive an already-expired lease in the narrow
          // window before a successor claims it.
          gt(payments.intentCreationLeaseExpiresAt, new Date()),
        ),
      )
      .returning({ id: payments.id });
    return renewed.length > 0;
  }
}

function toIsoStringOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function describePaymentCodeAttempt(
  status: string,
  failureMessage: string | null,
): string | null {
  const safeFailureMessage = isTechnicalPaymentCodeMessage(failureMessage)
    ? null
    : failureMessage;
  if (status === "user_confirming") {
    return "请在手机上确认支付";
  }
  if (status === "querying" || status === "unknown") {
    return "正在确认支付结果，请勿重复出示付款码";
  }
  if (status === "reversing") {
    return "支付结果未确认，正在撤销本次付款码交易";
  }
  if (status === "manual_handling") {
    return "支付结果待人工处理，请联系工作人员";
  }
  if (status === "failed") {
    return safeFailureMessage ?? "付款码无效或支付失败，请刷新付款码后重试";
  }
  if (status === "reversed" || status === "canceled") {
    return safeFailureMessage ?? "本次付款码交易已撤销，请刷新付款码后重试";
  }
  return safeFailureMessage;
}

function isTechnicalPaymentCodeMessage(message: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("httpclient") ||
    lower.includes("request timeout") ||
    lower.includes("timeout for") ||
    lower.includes("status: 5") ||
    lower.includes("status: 504") ||
    lower.includes("gateway timeout") ||
    lower.includes("gateway time-out") ||
    lower.includes("econn") ||
    lower.includes("socket") ||
    message.includes("HTTP 请求错误") ||
    message.includes("请求超时") ||
    message.includes("网络超时")
  );
}

function resolveMachineOrderNextAction(
  paymentState: OrderPaymentState,
  fulfillmentState: OrderFulfillmentState,
  paymentStatus: PaymentStatus,
  commandStatus: VendingCommandStatus | null,
  paymentCodeAttemptStatus: string | null = null,
): MachineOrderStatusNextAction {
  const orderStatus = projectOrderStatus({ paymentState, fulfillmentState });
  if (orderStatus === "fulfilled") return "success";
  if (
    paymentState === "payment_unknown" ||
    paymentStatus === "unknown" ||
    paymentCodeAttemptStatus === "manual_handling" ||
    paymentCodeAttemptStatus === "reversal_unknown"
  ) {
    return "manual_handling";
  }
  if (
    fulfillmentState === "dispense_failed" ||
    fulfillmentState === "partial_dispensed"
  ) {
    return "dispense_failed";
  }
  if (fulfillmentState === "manual_handling") return "manual_handling";
  if (
    paymentState === "refund_pending" ||
    paymentState === "partial_refund_pending"
  ) {
    return "refund_pending";
  }
  if (paymentState === "refunded" || paymentState === "partial_refunded") {
    return "refunded";
  }
  if (paymentState === "payment_expired" || paymentStatus === "expired") {
    return "payment_expired";
  }
  if (paymentState === "canceled" || paymentStatus === "canceled") {
    return "closed";
  }
  if (paymentState === "payment_failed" || paymentStatus === "failed") {
    return "payment_failed";
  }

  if (
    paymentState === "paid" &&
    (commandStatus === "failed" ||
      commandStatus === "timeout" ||
      commandStatus === "result_unknown")
  ) {
    return "manual_handling";
  }
  if (paymentState === "paid") {
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
