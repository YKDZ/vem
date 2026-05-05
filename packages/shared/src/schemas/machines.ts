import { z } from "zod";

import { machineSlotStatusSchema, machineStatusSchema } from "../enums/machine";

export const createMachineSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  locationText: z.string().max(500).nullable().optional(),
  status: machineStatusSchema.default("offline"),
  mqttClientId: z.string().max(128).nullable().optional(),
});

export const createMachineSlotSchema = z.object({
  layerNo: z.int().min(1),
  cellNo: z.int().min(1),
  slotCode: z.string().min(1).max(32),
  capacity: z.int().min(0),
  status: machineSlotStatusSchema.default("enabled"),
});

export const updateMachineSchema = createMachineSchema.partial();
export const updateMachineSlotSchema = createMachineSlotSchema.partial();

export const machineHeartbeatStatusPayloadSchema = z
  .object({
    appVersion: z.string().optional(),
    os: z.string().optional(),
    network: z.enum(["online", "degraded", "offline"]).optional(),
    mqttConnected: z.boolean().optional(),
    hardwareAdapter: z.string().optional(),
    hardwareStatus: z.enum(["ok", "degraded", "faulted"]).optional(),
    doorOpen: z.boolean().optional(),
    localQueueSize: z.int().nonnegative().optional(),
    lastCommandNo: z.string().max(64).nullable().optional(),
  })
  .loose();

export const heartbeatPayloadSchema = z.object({
  machineCode: z.string().min(1).max(64),
  reportedAt: z.iso.datetime(),
  statusPayload: machineHeartbeatStatusPayloadSchema.default({}),
});

export type MachineHeartbeatStatusPayload = z.infer<
  typeof machineHeartbeatStatusPayloadSchema
>;
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
