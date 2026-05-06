import { z } from "zod";

export const hardwareErrorCodeSchema = z.enum([
  "NO_DROP",
  "JAMMED",
  "DOOR_OPEN",
  "MOTOR_TIMEOUT",
  "UNKNOWN",
]);
export type HardwareErrorCode = z.infer<typeof hardwareErrorCodeSchema>;
export const hardwareErrorCodes = hardwareErrorCodeSchema.options;

export const hardwareErrorHandlingRuleSchema = z.object({
  errorCode: hardwareErrorCodeSchema.nullable(),
  restoreInventory: z.boolean(),
  faultSlot: z.boolean(),
  requestRefund: z.boolean(),
  createWorkOrder: z.boolean(),
  severity: z.enum(["info", "warning", "critical"]),
});

export type HardwareErrorHandlingRule = z.infer<
  typeof hardwareErrorHandlingRuleSchema
>;

export const HARDWARE_ERROR_HANDLING: Record<
  string,
  HardwareErrorHandlingRule
> = {
  NO_DROP: {
    errorCode: "NO_DROP",
    restoreInventory: true,
    faultSlot: false,
    requestRefund: true,
    createWorkOrder: false,
    severity: "warning",
  },
  JAMMED: {
    errorCode: "JAMMED",
    restoreInventory: false,
    faultSlot: true,
    requestRefund: true,
    createWorkOrder: true,
    severity: "critical",
  },
  DOOR_OPEN: {
    errorCode: "DOOR_OPEN",
    restoreInventory: false,
    faultSlot: true,
    requestRefund: true,
    createWorkOrder: true,
    severity: "critical",
  },
  MOTOR_TIMEOUT: {
    errorCode: "MOTOR_TIMEOUT",
    restoreInventory: false,
    faultSlot: true,
    requestRefund: true,
    createWorkOrder: true,
    severity: "critical",
  },
  UNKNOWN: {
    errorCode: "UNKNOWN",
    restoreInventory: false,
    faultSlot: true,
    requestRefund: true,
    createWorkOrder: true,
    severity: "critical",
  },
  NULL_ERROR: {
    errorCode: null,
    restoreInventory: false,
    faultSlot: true,
    requestRefund: true,
    createWorkOrder: true,
    severity: "critical",
  },
};
