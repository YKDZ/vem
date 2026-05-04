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
