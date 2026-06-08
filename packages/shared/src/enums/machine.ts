import { z } from "zod";

export const machineStatusSchema = z.enum([
  "online",
  "offline",
  "maintenance",
  "disabled",
]);
export type MachineStatus = z.infer<typeof machineStatusSchema>;
export const machineStatuses = machineStatusSchema.options;

export const machineSlotStatusSchema = z.enum([
  "enabled",
  "disabled",
  "faulted",
]);
export type MachineSlotStatus = z.infer<typeof machineSlotStatusSchema>;
export const machineSlotStatuses = machineSlotStatusSchema.options;

export const machineCommandStatusSchema = z.enum([
  "pending",
  "sent",
  "acknowledged",
  "succeeded",
  "failed",
  "timeout",
]);
export type MachineCommandStatus = z.infer<typeof machineCommandStatusSchema>;
export const machineCommandStatuses = machineCommandStatusSchema.options;

export const machineClaimCodeStateSchema = z.enum([
  "pending",
  "consumed",
  "expired",
  "revoked",
  "locked",
]);
export type MachineClaimCodeState = z.infer<typeof machineClaimCodeStateSchema>;
export const machineClaimCodeStates = machineClaimCodeStateSchema.options;
