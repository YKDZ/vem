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

export const machineEnvironmentHeartbeatPayloadSchema = z.object({
  temperatureCelsius: z.number().optional(),
  humidityRh: z.number().min(0).max(100).optional(),
  sampledAt: z.iso.datetime().optional(),
  sensorStatus: z.enum(["ok", "faulted", "unknown"]),
  airConditionerOn: z.boolean().optional(),
  targetTemperatureCelsius: z.number().nullable().optional(),
});

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
    environment: machineEnvironmentHeartbeatPayloadSchema.optional(),
  })
  .loose();

export const heartbeatPayloadSchema = z.object({
  machineCode: z.string().min(1).max(64),
  reportedAt: z.iso.datetime(),
  statusPayload: machineHeartbeatStatusPayloadSchema.default({}),
});

export const machineEnvironmentControlRequestSchema = z
  .object({
    airConditionerOn: z.boolean().optional(),
    targetTemperatureCelsius: z.number().min(18).max(30).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.airConditionerOn === undefined &&
      data.targetTemperatureCelsius === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "At least one of airConditionerOn or targetTemperatureCelsius is required",
      });
    }
  });

export type MachineHeartbeatStatusPayload = z.infer<
  typeof machineHeartbeatStatusPayloadSchema
>;
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
export type MachineEnvironmentControlRequest = z.infer<
  typeof machineEnvironmentControlRequestSchema
>;

export const machineAuthTokenRequestSchema = z.object({
  machineCode: z.string().min(1).max(64),
  machineSecret: z.string().min(32).max(256),
});

export const machineAuthTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresInSeconds: z.int().positive(),
  machine: z.object({
    id: z.uuid(),
    code: z.string().min(1).max(64),
    status: machineStatusSchema,
  }),
});

export type MachineAuthTokenRequest = z.infer<
  typeof machineAuthTokenRequestSchema
>;
export type MachineAuthTokenResponse = z.infer<
  typeof machineAuthTokenResponseSchema
>;

export const machineCatalogItemSchema = z.object({
  machineCode: z.string().min(1).max(64),
  slotId: z.uuid(),
  slotCode: z.string().min(1).max(32),
  layerNo: z.int().min(1),
  cellNo: z.int().min(1),
  inventoryId: z.uuid(),
  variantId: z.uuid(),
  productId: z.uuid(),
  productName: z.string().min(1).max(128),
  productDescription: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  categoryId: z.uuid().nullable(),
  categoryName: z.string().nullable(),
  sku: z.string().min(1).max(64),
  size: z.string().nullable(),
  color: z.string().nullable(),
  priceCents: z.int().nonnegative(),
  availableQty: z.int().nonnegative(),
  productSortOrder: z.int(),
  targetGender: z.enum(["male", "female"]).nullable().optional(),
});

export type MachineCatalogItem = z.infer<typeof machineCatalogItemSchema>;
