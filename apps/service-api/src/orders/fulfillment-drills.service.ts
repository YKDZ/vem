import type {
  CreateProtectedFulfillmentDrillInput,
  ProtectedFulfillmentDrillRecoveryAction,
  ProtectedFulfillmentDrillScenario,
  OrderFulfillmentState,
  OrderStatus,
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
  machineSlots,
  orderRecoveryActions,
  orders,
  paymentProviders,
  payments,
  refunds,
  vendingCommands,
  type DrizzleClient,
} from "@vem/db";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-no.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

type FulfillmentDrillRecoveryActionName =
  ProtectedFulfillmentDrillRecoveryAction["action"];

export type FulfillmentDrillOrder = {
  orderId: string;
  orderNo: string;
  paymentId: string;
  paymentNo: string;
  commandId: string;
  commandNo: string;
  scenario: ProtectedFulfillmentDrillScenario;
  isDrill: boolean;
  isTest: boolean;
  status: string;
  paymentStatus: string;
  fulfillmentState: string;
  availableRecoveryActions: FulfillmentDrillRecoveryActionName[];
  audit?: {
    actorAdminUserId: string;
    reason: string;
    scenario: ProtectedFulfillmentDrillScenario;
    createdAt: string;
  };
  latestRecovery?: {
    action: string;
    actorAdminUserId: string;
    reason: string;
    createdAt: string;
    simulationOnly: true;
  };
};

export type FulfillmentDrillStore = {
  getOrder(orderId: string): Promise<FulfillmentDrillOrder | null>;
  createDrillOrder(input: {
    machineId: string;
    scenario: ProtectedFulfillmentDrillScenario;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<FulfillmentDrillOrder>;
  applyRecoveryAction(input: {
    order: FulfillmentDrillOrder;
    action: FulfillmentDrillRecoveryActionName;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<FulfillmentDrillOrder>;
};

const scenarioRecoveryActions: Record<
  ProtectedFulfillmentDrillScenario,
  FulfillmentDrillRecoveryActionName[]
> = {
  dispense_failed: ["confirm_not_dispensed", "request_refund"],
  unknown_dispense_result: ["confirm_dispensed", "confirm_not_dispensed"],
  pickup_timeout: ["confirm_dispensed", "confirm_not_dispensed"],
  maintenance_lock_required: ["confirm_not_dispensed"],
};

export function fulfillmentDrillRecoveryActionsForScenario(
  scenario: ProtectedFulfillmentDrillScenario,
): FulfillmentDrillRecoveryActionName[] {
  return scenarioRecoveryActions[scenario];
}

function isDrillProfile(value: unknown): value is {
  kind: "protected_fulfillment_drill";
  isDrill: true;
  isTest: true;
  scenario: ProtectedFulfillmentDrillScenario;
  audit: {
    actorAdminUserId: string;
    reason: string;
    scenario: ProtectedFulfillmentDrillScenario;
    createdAt: string;
  };
  latestRecovery?: FulfillmentDrillOrder["latestRecovery"];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "protected_fulfillment_drill" &&
    Reflect.get(value, "isDrill") === true &&
    Reflect.get(value, "isTest") === true
  );
}

function createDrillBusinessNo(prefix: "ORD" | "PAY" | "CMD" | "RFD"): string {
  return `DRILL-${createBusinessNo(prefix)}`;
}

function scenarioInitialState(scenario: ProtectedFulfillmentDrillScenario): {
  orderStatus: "dispense_failed" | "manual_handling";
  fulfillmentState: "dispense_failed" | "manual_handling";
  commandStatus: "failed" | "result_unknown";
  lastError: string;
} {
  if (scenario === "unknown_dispense_result") {
    return {
      orderStatus: "manual_handling",
      fulfillmentState: "manual_handling",
      commandStatus: "result_unknown",
      lastError: "protected_fulfillment_drill_unknown_dispense_result",
    };
  }
  if (scenario === "pickup_timeout") {
    return {
      orderStatus: "manual_handling",
      fulfillmentState: "manual_handling",
      commandStatus: "result_unknown",
      lastError: "protected_fulfillment_drill_pickup_timeout",
    };
  }
  if (scenario === "maintenance_lock_required") {
    return {
      orderStatus: "manual_handling",
      fulfillmentState: "dispense_failed",
      commandStatus: "failed",
      lastError: "protected_fulfillment_drill_maintenance_lock_required",
    };
  }
  return {
    orderStatus: "dispense_failed",
    fulfillmentState: "dispense_failed",
    commandStatus: "failed",
    lastError: "protected_fulfillment_drill_dispense_failed",
  };
}

function drillProfile(input: {
  scenario: ProtectedFulfillmentDrillScenario;
  actorAdminUserId: string;
  reason: string;
  createdAt: Date;
  latestRecovery?: FulfillmentDrillOrder["latestRecovery"];
}) {
  return {
    kind: "protected_fulfillment_drill",
    isDrill: true,
    isTest: true,
    scenario: input.scenario,
    simulationOnly: true,
    audit: {
      actorAdminUserId: input.actorAdminUserId,
      reason: input.reason,
      scenario: input.scenario,
      createdAt: input.createdAt.toISOString(),
    },
    latestRecovery: input.latestRecovery,
  };
}

function availableRecoveryActionsAfter(
  scenario: ProtectedFulfillmentDrillScenario,
  recoveryRows: Array<{ action: string; status: string }>,
): FulfillmentDrillRecoveryActionName[] {
  const completedActions = new Set(
    recoveryRows
      .filter((entry) => entry.status === "completed")
      .map((entry) => entry.action),
  );
  if (
    completedActions.has("confirm_dispensed") ||
    completedActions.has("request_refund") ||
    completedActions.has("compensation_dispense")
  ) {
    return [];
  }
  if (completedActions.has("confirm_not_dispensed")) {
    return ["request_refund", "compensation_dispense"];
  }
  return fulfillmentDrillRecoveryActionsForScenario(scenario);
}

@Injectable()
export class DrizzleFulfillmentDrillStore implements FulfillmentDrillStore {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async getOrder(orderId: string): Promise<FulfillmentDrillOrder | null> {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        fulfillmentState: orders.fulfillmentState,
        orderIsDrill: orders.isDrill,
        profileSnapshot: orders.profileSnapshot,
        paymentId: payments.id,
        paymentNo: payments.paymentNo,
        paymentStatus: payments.status,
        paymentIsDrill: payments.isDrill,
        commandId: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
      })
      .from(orders)
      .innerJoin(payments, eq(payments.id, orders.paymentId))
      .innerJoin(vendingCommands, eq(vendingCommands.orderId, orders.id))
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
        commandId: row.commandId,
        commandNo: row.commandNo,
        scenario: "dispense_failed",
        isDrill: false,
        isTest: false,
        status: row.status,
        paymentStatus: row.paymentStatus,
        fulfillmentState: row.fulfillmentState,
        availableRecoveryActions: [],
      };
    }

    const recoveryRows = await this.db
      .select({
        action: orderRecoveryActions.action,
        status: orderRecoveryActions.status,
      })
      .from(orderRecoveryActions)
      .where(eq(orderRecoveryActions.orderId, orderId));

    return {
      orderId: row.orderId,
      orderNo: row.orderNo,
      paymentId: row.paymentId,
      paymentNo: row.paymentNo,
      commandId: row.commandId,
      commandNo: row.commandNo,
      scenario: row.profileSnapshot.scenario,
      isDrill: true,
      isTest: true,
      status: row.status,
      paymentStatus: row.paymentStatus,
      fulfillmentState: row.fulfillmentState,
      availableRecoveryActions: availableRecoveryActionsAfter(
        row.profileSnapshot.scenario,
        recoveryRows,
      ),
      audit: row.profileSnapshot.audit,
      latestRecovery: row.profileSnapshot.latestRecovery,
    };
  }

  async createDrillOrder(input: {
    machineId: string;
    scenario: ProtectedFulfillmentDrillScenario;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<FulfillmentDrillOrder> {
    return await this.db.transaction(async (tx) => {
      const [machine] = await tx
        .select({ id: machines.id })
        .from(machines)
        .where(eq(machines.id, input.machineId))
        .limit(1);
      if (!machine) throw new NotFoundException("Machine not found");

      const [slot] = await tx
        .select({ id: machineSlots.id, slotCode: machineSlots.slotCode })
        .from(machineSlots)
        .where(eq(machineSlots.machineId, input.machineId))
        .limit(1);
      if (!slot) {
        throw new ConflictException("Machine slot is required for drill");
      }

      const [provider] = await tx
        .select({ id: paymentProviders.id })
        .from(paymentProviders)
        .where(eq(paymentProviders.code, "mock"))
        .limit(1);
      if (!provider) {
        throw new ConflictException("Mock payment provider not found");
      }

      const initial = scenarioInitialState(input.scenario);
      const profile = drillProfile(input);
      const [order] = await tx
        .insert(orders)
        .values({
          orderNo: createDrillBusinessNo("ORD"),
          machineId: input.machineId,
          status: initial.orderStatus,
          paymentState: "paid",
          fulfillmentState: initial.fulfillmentState,
          totalAmountCents: 0,
          currency: "CNY",
          isDrill: true,
          drillScenario: input.scenario,
          profileSnapshot: profile,
          createdFrom: "admin",
          paidAt: input.createdAt,
        })
        .returning({ id: orders.id, orderNo: orders.orderNo });
      const [payment] = await tx
        .insert(payments)
        .values({
          paymentNo: createDrillBusinessNo("PAY"),
          orderId: order.id,
          providerId: provider.id,
          providerConfigSnapshotJson: {
            kind: "protected_fulfillment_drill",
            isDrill: true,
            isTest: true,
            scenario: input.scenario,
          },
          method: "mock",
          status: "succeeded",
          amountCents: 0,
          isDrill: true,
          drillScenario: input.scenario,
          providerTradeNo: `DRILL-${order.orderNo}`,
          paidAt: input.createdAt,
        })
        .returning({ id: payments.id, paymentNo: payments.paymentNo });
      await tx
        .update(orders)
        .set({ paymentId: payment.id, updatedAt: input.createdAt })
        .where(eq(orders.id, order.id));

      const [command] = await tx
        .insert(vendingCommands)
        .values({
          commandNo: createDrillBusinessNo("CMD"),
          orderId: order.id,
          machineId: input.machineId,
          slotId: slot.id,
          commandKind: "dispatch",
          payloadJson: {
            kind: "protected_fulfillment_drill",
            isDrill: true,
            isTest: true,
            scenario: input.scenario,
            slotCode: slot.slotCode,
          },
          status: initial.commandStatus,
          lastError: initial.lastError,
          sentAt: input.createdAt,
          resultAt: input.createdAt,
        })
        .returning({
          id: vendingCommands.id,
          commandNo: vendingCommands.commandNo,
        });

      return {
        orderId: order.id,
        orderNo: order.orderNo,
        paymentId: payment.id,
        paymentNo: payment.paymentNo,
        commandId: command.id,
        commandNo: command.commandNo,
        scenario: input.scenario,
        isDrill: true,
        isTest: true,
        status: initial.orderStatus,
        paymentStatus: "succeeded",
        fulfillmentState: initial.fulfillmentState,
        availableRecoveryActions: fulfillmentDrillRecoveryActionsForScenario(
          input.scenario,
        ),
        audit: profile.audit,
      };
    });
  }

  async applyRecoveryAction(input: {
    order: FulfillmentDrillOrder;
    action: FulfillmentDrillRecoveryActionName;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<FulfillmentDrillOrder> {
    const latestRecovery = {
      action: input.action,
      actorAdminUserId: input.actorAdminUserId,
      reason: input.reason,
      createdAt: input.createdAt.toISOString(),
      simulationOnly: true as const,
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

      const next = this.nextStateForRecovery(input.order, input.action);
      await tx
        .insert(orderRecoveryActions)
        .values({
          orderId: input.order.orderId,
          commandId: input.order.commandId,
          action: input.action,
          status: "completed",
          note: input.reason,
          requestedByAdminUserId: input.actorAdminUserId,
          resultJson: {
            kind: "protected_fulfillment_drill",
            scenario: input.order.scenario,
            action: input.action,
            simulationOnly: true,
          },
        })
        .returning({ id: orderRecoveryActions.id });

      if (input.action === "request_refund") {
        await tx.insert(refunds).values({
          refundNo: createDrillBusinessNo("RFD"),
          paymentId: input.order.paymentId,
          orderId: input.order.orderId,
          amountCents: 0,
          status: "created",
          isDrill: true,
          drillScenario: input.order.scenario,
          reason: "protected_fulfillment_drill",
          requestedByAdminUserId: input.actorAdminUserId,
        });
      }

      await tx
        .update(orders)
        .set({
          status: next.status,
          fulfillmentState: next.fulfillmentState,
          paymentState:
            input.action === "request_refund" ? "refund_pending" : "paid",
          profileSnapshot: profile,
          dispensedAt:
            input.action === "confirm_dispensed" ? input.createdAt : null,
          updatedAt: input.createdAt,
        })
        .where(eq(orders.id, input.order.orderId));

      return {
        ...input.order,
        status: next.status,
        fulfillmentState: next.fulfillmentState,
        latestRecovery,
        availableRecoveryActions:
          input.action === "confirm_not_dispensed"
            ? ["request_refund", "compensation_dispense"]
            : [],
        audit: profile.audit,
        commandId: input.order.commandId,
        commandNo: input.order.commandNo,
      };
    });
  }

  private nextStateForRecovery(
    order: FulfillmentDrillOrder,
    action: FulfillmentDrillRecoveryActionName,
  ): { status: OrderStatus; fulfillmentState: OrderFulfillmentState } {
    if (action === "confirm_dispensed") {
      return { status: "fulfilled", fulfillmentState: "dispensed" };
    }
    if (action === "request_refund") {
      return { status: "refund_pending", fulfillmentState: "manual_handling" };
    }
    if (action === "compensation_dispense") {
      return { status: "manual_handling", fulfillmentState: "manual_handling" };
    }
    return {
      status: "manual_handling",
      fulfillmentState: "manual_handling",
    };
  }
}

@Injectable()
export class FulfillmentDrillsService {
  constructor(
    @Inject(DrizzleFulfillmentDrillStore)
    private readonly store: FulfillmentDrillStore,
    private readonly auditService: AuditService,
  ) {}

  async createDrill(
    adminUserId: string,
    input: CreateProtectedFulfillmentDrillInput,
    now = new Date(),
  ): Promise<FulfillmentDrillOrder> {
    const drill = await this.store.createDrillOrder({
      machineId: input.machineId,
      scenario: input.scenario,
      actorAdminUserId: adminUserId,
      reason: input.reason,
      createdAt: now,
    });
    await this.auditService.record({
      adminUserId,
      action: "orders.fulfillment_drill.create",
      resourceType: "order",
      resourceId: drill.orderId,
      beforeJson: {},
      afterJson: {
        isDrill: true,
        isTest: true,
        scenario: input.scenario,
        reason: input.reason,
        simulationOnly: true,
        paymentNo: drill.paymentNo,
        commandNo: drill.commandNo,
        createdAt: now.toISOString(),
      },
    });
    return drill;
  }

  async applyRecoveryAction(
    orderId: string,
    adminUserId: string,
    input: ProtectedFulfillmentDrillRecoveryAction,
    now = new Date(),
  ): Promise<FulfillmentDrillOrder> {
    const order = await this.store.getOrder(orderId);
    if (!order)
      throw new NotFoundException("Fulfillment drill order not found");
    if (!order.isDrill) {
      throw new ConflictException(
        "Fulfillment drill recovery cannot target real customer orders",
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
      action: `orders.fulfillment_drill.recovery.${input.action}`,
      resourceType: "order",
      resourceId: orderId,
      beforeJson: {
        isDrill: true,
        scenario: order.scenario,
        status: order.status,
        fulfillmentState: order.fulfillmentState,
        commandNo: order.commandNo,
      },
      afterJson: {
        isDrill: true,
        isTest: true,
        scenario: order.scenario,
        action: input.action,
        reason: input.reason,
        status: recovered.status,
        fulfillmentState: recovered.fulfillmentState,
        simulationOnly: true,
        recoveredAt: now.toISOString(),
      },
    });
    return recovered;
  }
}
