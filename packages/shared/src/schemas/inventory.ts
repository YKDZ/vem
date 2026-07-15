import { z } from "zod";

import { inventoryMovementReasonSchema } from "../enums/inventory";
import { machineSlotStatusSchema } from "../enums/machine";
import { createPageResultSchema, pageQuerySchema } from "./pagination";

const nullableUuidSchema = z.uuid().nullable();
const optionalIsoDateTimeSchema = z.iso.datetime().optional();

export const adminInventoryContractNoBodySchema = z.strictObject({});

export const inventoryQuerySchema = z.strictObject({
  machineId: z.uuid().optional(),
  slotId: z.uuid().optional(),
  variantId: z.uuid().optional(),
});

export const adminInventoryListQuerySchema = pageQuerySchema.extend(
  inventoryQuerySchema.shape,
);

export const adminInventoryMovementListQuerySchema = pageQuerySchema;

export const refillInventorySchema = z.strictObject({
  inventoryId: z.uuid(),
  quantity: z.int().positive(),
  note: z.string().max(500).optional(),
});

export const adjustInventorySchema = z.strictObject({
  inventoryId: z.uuid(),
  deltaQty: z.int(),
  note: z.string().max(500).optional(),
});

export const createInventorySchema = z
  .strictObject({
    machineId: z.uuid(),
    slotId: z.uuid(),
    variantId: z.uuid(),
    onHandQty: z.int().min(0),
    reservedQty: z.int().min(0).default(0),
    lowStockThreshold: z.int().min(0).default(1),
    note: z.string().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.reservedQty > val.onHandQty) {
      ctx.addIssue({
        code: "custom",
        path: ["reservedQty"],
        message: "reservedQty cannot exceed onHandQty",
      });
    }
  });

export const adminInventoryResponseSchema = z.strictObject({
  id: z.uuid(),
  machineId: z.uuid(),
  machineCode: z.string().min(1).max(64).optional(),
  slotId: z.uuid(),
  slotCode: z.string().min(1).max(32).optional(),
  variantId: z.uuid(),
  productId: z.uuid().optional(),
  sku: z.string().min(1).max(64).optional(),
  productName: z.string().min(1).max(128).optional(),
  onHandQty: z.int().min(0),
  reservedQty: z.int().min(0),
  availableQty: z.int().min(0).optional(),
  lowStockThreshold: z.int().min(0),
  createdAt: optionalIsoDateTimeSchema,
  updatedAt: optionalIsoDateTimeSchema,
});

export const adminInventoryMovementResponseSchema = z.strictObject({
  id: z.uuid(),
  inventoryId: z.uuid(),
  deltaQty: z.int(),
  reason: inventoryMovementReasonSchema,
  orderId: nullableUuidSchema,
  orderNo: z.string().min(1).nullable().optional(),
  operatorAdminUserId: nullableUuidSchema,
  note: z.string().max(500).nullable(),
  createdAt: z.iso.datetime(),
});

export const adminInventoryPageResponseSchema = createPageResultSchema(
  adminInventoryResponseSchema,
);

export const adminInventoryMovementPageResponseSchema = createPageResultSchema(
  adminInventoryMovementResponseSchema,
);

export const stockMaintenanceTaskModeSchema = z.enum([
  "initial_count",
  "recovery_count",
  "routine_refill",
]);

export const stockMaintenanceSlotSyncStatusSchema = z.enum([
  "not_submitted",
  "pending",
  "failed",
  "accepted",
  "rejected",
  "reconciliation",
]);

export const stockMaintenanceTaskSlotSchema = z.strictObject({
  slotCode: z.string().min(1).max(32),
  layerNo: z.int().positive(),
  cellNo: z.int().positive(),
  productName: z.string().min(1).max(128),
  sku: z.string().min(1).max(64),
  capacity: z.int().nonnegative(),
  currentQuantity: z.int().nonnegative(),
  submittedQuantity: z.int().nonnegative().nullable(),
  submittedAddition: z.int().positive().nullable(),
  previewQuantity: z.int().nonnegative().nullable(),
  syncStatus: stockMaintenanceSlotSyncStatusSchema,
  salesState: z.string().min(1),
  reconciliationReason: z.string().min(1).nullable(),
});

export const stockMaintenanceTaskSchema = z.strictObject({
  taskId: z.string().min(1).max(128),
  mode: stockMaintenanceTaskModeSchema,
  status: z.enum(["ready", "pending", "reconciliation", "complete"]),
  slots: z.array(stockMaintenanceTaskSlotSchema),
});

const stockMaintenanceBatchBaseSchema = z.strictObject({
  taskId: z.string().min(1).max(128),
});

export const stockMaintenanceBatchRequestSchema = z.discriminatedUnion("mode", [
  stockMaintenanceBatchBaseSchema.extend({
    mode: z.enum(["initial_count", "recovery_count"]),
    slots: z
      .array(
        z.strictObject({
          slotCode: z.string().min(1).max(32),
          quantity: z.int().nonnegative(),
        }),
      )
      .min(1),
  }),
  stockMaintenanceBatchBaseSchema.extend({
    mode: z.literal("routine_refill"),
    slots: z
      .array(
        z.strictObject({
          slotCode: z.string().min(1).max(32),
          addition: z.int().positive(),
        }),
      )
      .min(1),
  }),
]);

export const stockMaintenanceBatchResponseSchema = z.strictObject({
  task: stockMaintenanceTaskSchema,
  duplicate: z.boolean(),
});

export const stockReconciliationCaseTableSchema = z.enum([
  "machine_raw_stock_movements",
  "machine_raw_stock_movement_conflicts",
]);

export const stockReconciliationResolveActionSchema = z.enum([
  "accept_machine_stock",
  "reject_machine_stock",
  "manual_correct",
]);

export const adminStockReconciliationListQuerySchema = pageQuerySchema.extend({
  machineId: z.uuid().optional(),
});

const stockReconciliationResolutionNoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(500);

export const adminStockReconciliationResolveRequestSchema =
  z.discriminatedUnion("action", [
    z.strictObject({
      action: z.literal("accept_machine_stock"),
      note: stockReconciliationResolutionNoteSchema,
      clearBlocker: z.boolean().optional(),
    }),
    z.strictObject({
      action: z.literal("reject_machine_stock"),
      note: stockReconciliationResolutionNoteSchema,
      clearBlocker: z.boolean().optional(),
    }),
    z.strictObject({
      action: z.literal("manual_correct"),
      note: stockReconciliationResolutionNoteSchema,
      clearBlocker: z.boolean().optional(),
      correctedOnHandQty: z.int().nonnegative(),
    }),
  ]);

export const adminStockReconciliationSlotSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1).max(32).nullable(),
  status: machineSlotStatusSchema.nullable(),
  saleEligibility: z.strictObject({
    eligible: z.boolean(),
    slotSalesState: z.string().min(1),
    reason: z.string().min(1).nullable(),
  }),
});

export const adminStockReconciliationInventorySnapshotSchema = z.strictObject({
  id: z.uuid(),
  productName: z.string().min(1).nullable(),
  sku: z.string().min(1).nullable(),
  onHandQty: z.int().min(0),
  reservedQty: z.int().min(0),
  saleableQty: z.int().min(0),
});

export const adminStockReconciliationBlockerSchema = z.strictObject({
  state: z.string().min(1),
  reason: z.string().min(1).nullable(),
  linkedCaseId: z.uuid(),
  linkedOrderId: nullableUuidSchema,
  linkedOrderNo: z.string().min(1).nullable(),
  linkedCommandId: nullableUuidSchema,
  linkedCommandNo: z.string().min(1).nullable(),
});

export const adminStockReconciliationCaseSummaryResponseSchema = z.strictObject(
  {
    id: z.uuid(),
    caseTable: stockReconciliationCaseTableSchema,
    rawMovementId: nullableUuidSchema,
    machineId: z.uuid(),
    machineCode: z.string().min(1).max(64),
    movementId: z.string().min(1).max(128),
    movementType: z.string().min(1).max(64),
    quantity: z.int(),
    source: z.string().min(1).max(128),
    attributedTo: z.string().min(1).nullable(),
    occurredAt: z.iso.datetime(),
    receivedAt: z.iso.datetime(),
    reconciliationReason: z.string().min(1).nullable(),
    platformReviewStatus: z.string().min(1).nullable(),
    slot: adminStockReconciliationSlotSchema,
    inventory: adminStockReconciliationInventorySnapshotSchema.nullable(),
    blocker: adminStockReconciliationBlockerSchema.nullable(),
  },
);

export const adminStockReconciliationResolutionResponseSchema = z.strictObject({
  action: stockReconciliationResolveActionSchema,
  note: z.string().min(1).max(500),
  clearedBlocker: z.boolean(),
  inventoryMovement: z
    .strictObject({
      inventoryId: z.uuid(),
      deltaQty: z.int(),
      reason: inventoryMovementReasonSchema,
      note: z.string().max(500).nullable(),
    })
    .nullable(),
});

export const adminStockReconciliationCaseDetailResponseSchema =
  adminStockReconciliationCaseSummaryResponseSchema.extend({
    planogramVersion: z.string().min(1).max(128),
    evidence: z.strictObject({
      rawPayload: z.record(z.string(), z.unknown()),
      normalizedPayload: z.record(z.string(), z.unknown()),
      inventory: adminStockReconciliationInventorySnapshotSchema.nullable(),
      linkedOrder: z
        .strictObject({
          id: nullableUuidSchema,
          orderNo: z.string().min(1).nullable(),
        })
        .nullable(),
      linkedCommand: z
        .strictObject({
          id: nullableUuidSchema,
          commandNo: z.string().min(1).nullable(),
        })
        .nullable(),
    }),
    resolution: adminStockReconciliationResolutionResponseSchema.optional(),
  });

export const adminStockReconciliationCasePageResponseSchema =
  createPageResultSchema(adminStockReconciliationCaseSummaryResponseSchema);

export type AdminInventoryListQuery = z.infer<
  typeof adminInventoryListQuerySchema
>;
export type AdminInventoryMovementListQuery = z.infer<
  typeof adminInventoryMovementListQuerySchema
>;
export type AdminCreateInventoryRequest = z.infer<typeof createInventorySchema>;
export type AdminRefillInventoryRequest = z.infer<typeof refillInventorySchema>;
export type AdminAdjustInventoryRequest = z.infer<typeof adjustInventorySchema>;
export type AdminInventoryResponse = z.infer<
  typeof adminInventoryResponseSchema
>;
export type AdminInventoryMovementResponse = z.infer<
  typeof adminInventoryMovementResponseSchema
>;
export type AdminInventoryPageResponse = z.infer<
  typeof adminInventoryPageResponseSchema
>;
export type AdminInventoryMovementPageResponse = z.infer<
  typeof adminInventoryMovementPageResponseSchema
>;
export type AdminStockReconciliationListQuery = z.infer<
  typeof adminStockReconciliationListQuerySchema
>;
export type AdminStockReconciliationResolveRequest = z.infer<
  typeof adminStockReconciliationResolveRequestSchema
>;
export type AdminStockReconciliationCaseSummaryResponse = z.infer<
  typeof adminStockReconciliationCaseSummaryResponseSchema
>;
export type AdminStockReconciliationCaseDetailResponse = z.infer<
  typeof adminStockReconciliationCaseDetailResponseSchema
>;
export type AdminStockReconciliationCasePageResponse = z.infer<
  typeof adminStockReconciliationCasePageResponseSchema
>;
export type StockMaintenanceTask = z.infer<typeof stockMaintenanceTaskSchema>;
export type StockMaintenanceBatchRequest = z.infer<
  typeof stockMaintenanceBatchRequestSchema
>;
export type StockMaintenanceBatchResponse = z.infer<
  typeof stockMaintenanceBatchResponseSchema
>;
