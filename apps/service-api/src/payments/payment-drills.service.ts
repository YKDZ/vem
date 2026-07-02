import type {
  CreateProtectedPaymentDrillInput,
  ProtectedPaymentDrillRecoveryAction,
  ProtectedPaymentDrillScenario,
} from "@vem/shared";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  eq,
  machines,
  orders,
  paymentCodeAttempts,
  paymentProviders,
  paymentReconciliationAttempts,
  payments,
  refunds,
  type DrizzleClient,
} from "@vem/db";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-no.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { buildStoredEventPayload } from "./payment-redaction.util";

type PaymentDrillRecoveryActionName =
  ProtectedPaymentDrillRecoveryAction["action"];

export type PaymentDrillOrder = {
  orderId: string;
  orderNo: string;
  paymentId: string;
  paymentNo: string;
  scenario: ProtectedPaymentDrillScenario;
  isDrill: boolean;
  isTest: boolean;
  status: string;
  paymentStatus: string;
  availableRecoveryActions: PaymentDrillRecoveryActionName[];
  audit?: {
    actorAdminUserId: string;
    reason: string;
    scenario: ProtectedPaymentDrillScenario;
    createdAt: string;
  };
  latestRecovery?: {
    action: string;
    actorAdminUserId: string;
    reason: string;
    createdAt: string;
  };
};

export type PaymentDrillStore = {
  getOrder(orderId: string): Promise<PaymentDrillOrder | null>;
  createDrillOrder(input: {
    machineId: string;
    scenario: ProtectedPaymentDrillScenario;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<PaymentDrillOrder>;
  applyRecoveryAction(input: {
    order: PaymentDrillOrder;
    action: PaymentDrillRecoveryActionName;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<PaymentDrillOrder>;
};

const scenarioRecoveryActions: Record<
  ProtectedPaymentDrillScenario,
  PaymentDrillRecoveryActionName[]
> = {
  payment_code_unknown: [
    "query_payment_code",
    "reverse_payment_code",
    "mark_manual_handling",
  ],
  user_confirming_timeout: [
    "query_payment_code",
    "reverse_payment_code",
    "mark_manual_handling",
  ],
  query_failed_then_reversed: ["reverse_payment_code", "mark_manual_handling"],
  qr_reconcile_failed: ["reconcile_qr", "mark_manual_handling"],
  refund_required: ["request_refund", "mark_manual_handling"],
  manual_handling: ["mark_manual_handling"],
};

export function paymentDrillRecoveryActionsForScenario(
  scenario: ProtectedPaymentDrillScenario,
): PaymentDrillRecoveryActionName[] {
  return scenarioRecoveryActions[scenario];
}

const paymentCodeScenarios = new Set<ProtectedPaymentDrillScenario>([
  "payment_code_unknown",
  "user_confirming_timeout",
  "query_failed_then_reversed",
]);

function isDrillProfile(value: unknown): value is {
  kind: "protected_payment_drill";
  isDrill: true;
  isTest: true;
  scenario: ProtectedPaymentDrillScenario;
  audit: {
    actorAdminUserId: string;
    reason: string;
    scenario: ProtectedPaymentDrillScenario;
    createdAt: string;
  };
  latestRecovery?: {
    action: string;
    actorAdminUserId: string;
    reason: string;
    createdAt: string;
  };
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "protected_payment_drill" &&
    Reflect.get(value, "isDrill") === true &&
    Reflect.get(value, "isTest") === true
  );
}

function scenarioInitialState(scenario: ProtectedPaymentDrillScenario): {
  orderStatus:
    | "pending_payment"
    | "paid"
    | "dispense_failed"
    | "manual_handling";
  paymentState: "awaiting_payment" | "paid" | "manual_handling";
  fulfillmentState:
    | "awaiting_fulfillment"
    | "dispense_failed"
    | "manual_handling";
  paymentStatus: "pending" | "processing" | "succeeded" | "manual_handling";
  method: "mock" | "qr_code" | "payment_code";
} {
  if (scenario === "refund_required") {
    return {
      orderStatus: "dispense_failed",
      paymentState: "paid",
      fulfillmentState: "dispense_failed",
      paymentStatus: "succeeded",
      method: "mock",
    };
  }
  if (scenario === "manual_handling") {
    return {
      orderStatus: "manual_handling",
      paymentState: "manual_handling",
      fulfillmentState: "manual_handling",
      paymentStatus: "manual_handling",
      method: "mock",
    };
  }
  if (scenario === "qr_reconcile_failed") {
    return {
      orderStatus: "pending_payment",
      paymentState: "awaiting_payment",
      fulfillmentState: "awaiting_fulfillment",
      paymentStatus: "processing",
      method: "qr_code",
    };
  }
  return {
    orderStatus: "pending_payment",
    paymentState: "awaiting_payment",
    fulfillmentState: "awaiting_fulfillment",
    paymentStatus: "processing",
    method: "payment_code",
  };
}

function paymentCodeAttemptStatus(scenario: ProtectedPaymentDrillScenario) {
  if (scenario === "user_confirming_timeout") return "user_confirming";
  if (scenario === "query_failed_then_reversed") return "querying";
  return "unknown";
}

function createDrillBusinessNo(prefix: "ORD" | "PAY" | "PCA" | "RFD"): string {
  return `DRILL-${createBusinessNo(prefix)}`;
}

function drillProfile(input: {
  scenario: ProtectedPaymentDrillScenario;
  actorAdminUserId: string;
  reason: string;
  createdAt: Date;
  latestRecovery?: PaymentDrillOrder["latestRecovery"];
}) {
  return {
    kind: "protected_payment_drill",
    isDrill: true,
    isTest: true,
    scenario: input.scenario,
    audit: {
      actorAdminUserId: input.actorAdminUserId,
      reason: input.reason,
      scenario: input.scenario,
      createdAt: input.createdAt.toISOString(),
    },
    latestRecovery: input.latestRecovery,
  };
}

@Injectable()
export class DrizzlePaymentDrillStore implements PaymentDrillStore {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async getOrder(orderId: string): Promise<PaymentDrillOrder | null> {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        orderIsDrill: orders.isDrill,
        profileSnapshot: orders.profileSnapshot,
        paymentId: payments.id,
        paymentNo: payments.paymentNo,
        paymentStatus: payments.status,
        paymentIsDrill: payments.isDrill,
      })
      .from(orders)
      .innerJoin(payments, eq(payments.id, orders.paymentId))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row) return null;
    if (
      !row.orderIsDrill ||
      !row.paymentIsDrill ||
      !isDrillProfile(row.profileSnapshot)
    ) {
      return {
        orderId: row.orderId,
        orderNo: row.orderNo,
        paymentId: row.paymentId,
        paymentNo: row.paymentNo,
        scenario: "manual_handling",
        isDrill: false,
        isTest: false,
        status: row.status,
        paymentStatus: row.paymentStatus,
        availableRecoveryActions: [],
      };
    }
    return {
      orderId: row.orderId,
      orderNo: row.orderNo,
      paymentId: row.paymentId,
      paymentNo: row.paymentNo,
      scenario: row.profileSnapshot.scenario,
      isDrill: true,
      isTest: true,
      status: row.status,
      paymentStatus: row.paymentStatus,
      availableRecoveryActions: paymentDrillRecoveryActionsForScenario(
        row.profileSnapshot.scenario,
      ),
      audit: row.profileSnapshot.audit,
      latestRecovery: row.profileSnapshot.latestRecovery,
    };
  }

  async createDrillOrder(input: {
    machineId: string;
    scenario: ProtectedPaymentDrillScenario;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<PaymentDrillOrder> {
    return await this.db.transaction(async (tx) => {
      const [machine] = await tx
        .select({ id: machines.id })
        .from(machines)
        .where(eq(machines.id, input.machineId))
        .limit(1);
      if (!machine) throw new NotFoundException("Machine not found");

      const [provider] = await tx
        .select({ id: paymentProviders.id })
        .from(paymentProviders)
        .where(eq(paymentProviders.code, "mock"))
        .limit(1);
      if (!provider)
        throw new ConflictException("Mock payment provider not found");

      const initial = scenarioInitialState(input.scenario);
      const profile = drillProfile(input);
      const [order] = await tx
        .insert(orders)
        .values({
          orderNo: createDrillBusinessNo("ORD"),
          machineId: input.machineId,
          status: initial.orderStatus,
          paymentState: initial.paymentState,
          fulfillmentState: initial.fulfillmentState,
          totalAmountCents: 0,
          currency: "CNY",
          isDrill: true,
          drillScenario: input.scenario,
          profileSnapshot: profile,
          createdFrom: "admin",
          paidAt: initial.paymentState === "paid" ? input.createdAt : null,
        })
        .returning({ id: orders.id, orderNo: orders.orderNo });
      const [payment] = await tx
        .insert(payments)
        .values({
          paymentNo: createDrillBusinessNo("PAY"),
          orderId: order.id,
          providerId: provider.id,
          providerConfigSnapshotJson: {
            kind: "protected_payment_drill",
            isDrill: true,
            isTest: true,
            scenario: input.scenario,
          },
          method: initial.method,
          status: initial.paymentStatus,
          amountCents: 0,
          isDrill: true,
          drillScenario: input.scenario,
          providerTradeNo: `DRILL-${order.orderNo}`,
          paidAt:
            initial.paymentStatus === "succeeded" ? input.createdAt : null,
          failedReason:
            input.scenario === "manual_handling"
              ? "protected_payment_drill_manual_handling"
              : null,
        })
        .returning({ id: payments.id, paymentNo: payments.paymentNo });
      await tx
        .update(orders)
        .set({ paymentId: payment.id, updatedAt: input.createdAt })
        .where(eq(orders.id, order.id));

      if (paymentCodeScenarios.has(input.scenario)) {
        await tx.insert(paymentCodeAttempts).values({
          paymentId: payment.id,
          orderId: order.id,
          providerId: provider.id,
          attemptNo: 1,
          providerPaymentNo: createDrillBusinessNo("PCA"),
          idempotencyKey: `drill:${order.id}`,
          status: paymentCodeAttemptStatus(input.scenario),
          isActive: true,
          amountCents: 1,
          currency: "CNY",
          authCodeHash: "protected-payment-drill",
          authCodeMasked: "DRILL****0000",
          source: "manual_dev",
          providerStatus: "DRILL_SIMULATED",
          failureCode:
            input.scenario === "user_confirming_timeout"
              ? "PAYMENT_CODE_USER_CONFIRMING_TIMEOUT"
              : "PAYMENT_CODE_UNKNOWN",
          failureMessage: "Protected payment drill simulation",
          rawPayloadJson: buildStoredEventPayload({
            kind: "protected_payment_drill",
            scenario: input.scenario,
          }),
          submittedAt: input.createdAt,
          lastCheckedAt: input.createdAt,
          manualReason: input.reason,
        });
      }

      if (input.scenario === "qr_reconcile_failed") {
        await tx.insert(paymentReconciliationAttempts).values({
          paymentId: payment.id,
          providerId: provider.id,
          trigger: "manual",
          attemptNo: 1,
          status: "failed",
          errorCode: "QR_RECONCILE_FAILED_DRILL",
          errorMessage: "Protected QR reconciliation drill failure",
          startedAt: input.createdAt,
          finishedAt: input.createdAt,
        });
      }

      return {
        orderId: order.id,
        orderNo: order.orderNo,
        paymentId: payment.id,
        paymentNo: payment.paymentNo,
        scenario: input.scenario,
        isDrill: true,
        isTest: true,
        status: initial.orderStatus,
        paymentStatus: initial.paymentStatus,
        availableRecoveryActions: paymentDrillRecoveryActionsForScenario(
          input.scenario,
        ),
        audit: profile.audit,
      };
    });
  }

  async applyRecoveryAction(input: {
    order: PaymentDrillOrder;
    action: PaymentDrillRecoveryActionName;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<PaymentDrillOrder> {
    const latestRecovery = {
      action: input.action,
      actorAdminUserId: input.actorAdminUserId,
      reason: input.reason,
      createdAt: input.createdAt.toISOString(),
    };

    return await this.db.transaction(async (tx) => {
      const profile = drillProfile({
        scenario: input.order.scenario,
        actorAdminUserId:
          input.order.audit?.actorAdminUserId ?? input.actorAdminUserId,
        reason: input.order.audit?.reason ?? input.reason,
        createdAt: input.order.audit?.createdAt
          ? new Date(input.order.audit.createdAt)
          : input.createdAt,
        latestRecovery,
      });

      let status = input.order.status;
      let paymentStatus = input.order.paymentStatus;
      if (input.action === "reverse_payment_code") {
        status = "canceled";
        paymentStatus = "canceled";
        await tx
          .update(paymentCodeAttempts)
          .set({
            status: "reversed",
            isActive: false,
            providerStatus: "DRILL_REVERSED",
            reversedAt: input.createdAt,
            finishedAt: input.createdAt,
            manualReason: input.reason,
            updatedAt: input.createdAt,
          })
          .where(eq(paymentCodeAttempts.orderId, input.order.orderId));
        await tx
          .update(payments)
          .set({ status: "canceled", updatedAt: input.createdAt })
          .where(eq(payments.id, input.order.paymentId));
        await tx
          .update(orders)
          .set({
            status: "canceled",
            paymentState: "canceled",
            fulfillmentState: "canceled",
            canceledAt: input.createdAt,
            profileSnapshot: profile,
            updatedAt: input.createdAt,
          })
          .where(eq(orders.id, input.order.orderId));
      } else if (input.action === "query_payment_code") {
        status = "pending_payment";
        paymentStatus = "processing";
        await tx
          .update(paymentCodeAttempts)
          .set({
            status: "unknown",
            providerStatus: "DRILL_QUERY_UNKNOWN",
            failureCode: "PAYMENT_CODE_QUERY_UNKNOWN",
            failureMessage: "Protected drill query remained uncertain",
            lastCheckedAt: input.createdAt,
            manualReason: input.reason,
            updatedAt: input.createdAt,
          })
          .where(eq(paymentCodeAttempts.orderId, input.order.orderId));
        await tx
          .update(orders)
          .set({ profileSnapshot: profile, updatedAt: input.createdAt })
          .where(eq(orders.id, input.order.orderId));
      } else if (input.action === "reconcile_qr") {
        status = "paid";
        paymentStatus = "succeeded";
        await tx.insert(paymentReconciliationAttempts).values({
          paymentId: input.order.paymentId,
          providerId: await this.findMockProviderId(tx),
          trigger: "manual",
          attemptNo: 2,
          status: "succeeded",
          providerPaymentStatus: "succeeded",
          providerTradeNo: `DRILL-${input.order.paymentNo}`,
          startedAt: input.createdAt,
          finishedAt: input.createdAt,
        });
        await tx
          .update(payments)
          .set({
            status: "succeeded",
            paidAt: input.createdAt,
            updatedAt: input.createdAt,
          })
          .where(eq(payments.id, input.order.paymentId));
        await tx
          .update(orders)
          .set({
            status: "paid",
            paymentState: "paid",
            paidAt: input.createdAt,
            profileSnapshot: profile,
            updatedAt: input.createdAt,
          })
          .where(eq(orders.id, input.order.orderId));
      } else if (input.action === "request_refund") {
        status = "refund_pending";
        paymentStatus = "refund_pending";
        await tx.insert(refunds).values({
          refundNo: createDrillBusinessNo("RFD"),
          paymentId: input.order.paymentId,
          orderId: input.order.orderId,
          amountCents: 0,
          status: "created",
          isDrill: true,
          drillScenario: input.order.scenario,
          reason: "protected_payment_drill",
          requestedByAdminUserId: input.actorAdminUserId,
        });
        await tx
          .update(payments)
          .set({ status: "refund_pending", updatedAt: input.createdAt })
          .where(eq(payments.id, input.order.paymentId));
        await tx
          .update(orders)
          .set({
            status: "refund_pending",
            paymentState: "refund_pending",
            profileSnapshot: profile,
            updatedAt: input.createdAt,
          })
          .where(eq(orders.id, input.order.orderId));
      } else {
        status = "manual_handling";
        paymentStatus = "manual_handling";
        await tx
          .update(payments)
          .set({
            status: "manual_handling",
            failedReason: "protected_payment_drill_manual_handling",
            updatedAt: input.createdAt,
          })
          .where(eq(payments.id, input.order.paymentId));
        await tx
          .update(orders)
          .set({
            status: "manual_handling",
            paymentState: "manual_handling",
            fulfillmentState: "manual_handling",
            profileSnapshot: profile,
            updatedAt: input.createdAt,
          })
          .where(eq(orders.id, input.order.orderId));
      }

      return {
        ...input.order,
        status,
        paymentStatus,
        latestRecovery,
        availableRecoveryActions: [],
      };
    });
  }

  private async findMockProviderId(tx: DrizzleClient): Promise<string> {
    const [provider] = await tx
      .select({ id: paymentProviders.id })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, "mock"))
      .limit(1);
    if (!provider)
      throw new ConflictException("Mock payment provider not found");
    return provider.id;
  }
}

@Injectable()
export class PaymentDrillsService {
  constructor(
    @Inject(DrizzlePaymentDrillStore)
    private readonly store: PaymentDrillStore,
    private readonly auditService: AuditService,
  ) {}

  async createDrill(
    adminUserId: string,
    input: CreateProtectedPaymentDrillInput,
    now = new Date(),
  ): Promise<PaymentDrillOrder> {
    const drill = await this.store.createDrillOrder({
      machineId: input.machineId,
      scenario: input.scenario,
      actorAdminUserId: adminUserId,
      reason: input.reason,
      createdAt: now,
    });
    await this.auditService.record({
      adminUserId,
      action: "payments.drill.create",
      resourceType: "order",
      resourceId: drill.orderId,
      beforeJson: {},
      afterJson: {
        isDrill: true,
        isTest: true,
        scenario: input.scenario,
        reason: input.reason,
        createdAt: now.toISOString(),
        paymentNo: drill.paymentNo,
      },
    });
    return drill;
  }

  async applyRecoveryAction(
    orderId: string,
    adminUserId: string,
    input: ProtectedPaymentDrillRecoveryAction,
    now = new Date(),
  ): Promise<PaymentDrillOrder> {
    const order = await this.store.getOrder(orderId);
    if (!order) throw new NotFoundException("Payment drill order not found");
    if (!order.isDrill) {
      throw new ConflictException(
        "Payment drill recovery cannot target real customer orders",
      );
    }
    if (!order.availableRecoveryActions.includes(input.action)) {
      throw new ConflictException(
        `Recovery action ${input.action} is not available for ${order.scenario}`,
      );
    }

    const recovered = await this.store.applyRecoveryAction({
      order,
      action: input.action,
      actorAdminUserId: adminUserId,
      reason: input.reason,
      createdAt: now,
    });
    await this.auditService.record({
      adminUserId,
      action: `payments.drill.recovery.${input.action}`,
      resourceType: "order",
      resourceId: orderId,
      beforeJson: {
        isDrill: true,
        scenario: order.scenario,
        status: order.status,
        paymentStatus: order.paymentStatus,
      },
      afterJson: {
        isDrill: true,
        scenario: order.scenario,
        action: input.action,
        reason: input.reason,
        status: recovered.status,
        paymentStatus: recovered.paymentStatus,
        recoveredAt: now.toISOString(),
      },
    });
    return recovered;
  }
}
