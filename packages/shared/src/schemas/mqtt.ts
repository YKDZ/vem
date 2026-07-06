import { z } from "zod";

import { hardwareErrorCodeSchema } from "../enums/hardware";
import {
  addMachineSlotCoordinateIssue,
  machineSlotCellNoSchema,
  machineSlotLayerNoSchema,
} from "./machine-slot-coordinate";

export const commandAckPayloadSchema = z
  .object({
    messageId: z.string().min(1).max(128).optional(),
  })
  .loose();

export const dispenseCommandPayloadSchema = z.object({
  commandNo: z.string().min(1).max(64),
  orderNo: z.string().min(1).max(64),
  slot: z
    .object({
      layerNo: machineSlotLayerNoSchema,
      cellNo: machineSlotCellNoSchema,
      slotCode: z.string().min(1).max(32),
    })
    .superRefine(addMachineSlotCoordinateIssue),
  quantity: z.int().positive(),
  timeoutSeconds: z.int().positive(),
});

export const environmentControlCommandPayloadSchema = z
  .object({
    commandNo: z.string().min(1).max(64),
    airConditionerOn: z.boolean().optional(),
    targetTemperatureCelsius: z.number().min(18).max(30).optional(),
    ventSpeed: z.number().int().min(0).max(4).optional(),
    timeoutSeconds: z.int().positive(),
  })
  .superRefine((data, ctx) => {
    if (
      data.airConditionerOn === undefined &&
      data.targetTemperatureCelsius === undefined &&
      data.ventSpeed === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "At least one of airConditionerOn, targetTemperatureCelsius or ventSpeed is required",
      });
    }
  });

export const dispenseResultPayloadSchema = z
  .object({
    commandNo: z.string().min(1).max(64),
    success: z.boolean(),
    errorCode: hardwareErrorCodeSchema.nullable(),
    message: z.string(),
    reportedAt: z.iso.datetime(),
  })
  .superRefine((data, ctx) => {
    if (data.success && data.errorCode !== null) {
      ctx.addIssue({
        code: "custom",
      });
    }
    if (!data.success && data.errorCode === null) {
      ctx.addIssue({
        code: "custom",
      });
    }
  });

export const environmentControlResultPayloadSchema = z
  .object({
    commandNo: z.string().min(1).max(64),
    success: z.boolean(),
    errorCode: z.string().min(1).max(64).nullable().optional(),
    message: z.string().max(500).optional(),
    airConditionerOn: z.boolean().nullable().optional(),
    targetTemperatureCelsius: z.number().min(18).max(30).nullable().optional(),
    ventSpeed: z.number().int().min(0).max(4).nullable().optional(),
    reportedAt: z.iso.datetime(),
  })
  .loose();

export const mqttSignedEnvelopeSchema = z.object({
  messageId: z.string().min(1).max(128),
  machineCode: z.string().min(1).max(64),
  issuedAt: z.iso.datetime(),
  nonce: z.string().min(16).max(128),
  payload: z.unknown(),
  signature: z.string().min(32).max(256),
});

export type CommandAckPayload = z.infer<typeof commandAckPayloadSchema>;
export type DispenseCommandPayload = z.infer<
  typeof dispenseCommandPayloadSchema
>;
export type DispenseResultPayload = z.infer<typeof dispenseResultPayloadSchema>;

export const manualDispenseResolutionSchema = z.object({
  result: z.enum(["dispensed", "not_dispensed"]),
  note: z.string().trim().min(1).max(500),
});

export type ManualDispenseResolution = z.infer<
  typeof manualDispenseResolutionSchema
>;
export type EnvironmentControlCommandPayload = z.infer<
  typeof environmentControlCommandPayloadSchema
>;
export type EnvironmentControlResultPayload = z.infer<
  typeof environmentControlResultPayloadSchema
>;
export type MqttSignedEnvelope = z.infer<typeof mqttSignedEnvelopeSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    // value is non-null, non-array object (null and Array are handled above)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  return "null";
}

export function mqttSigningInput(
  envelope: Omit<MqttSignedEnvelope, "signature">,
): string {
  return canonicalJson({
    issuedAt: envelope.issuedAt,
    machineCode: envelope.machineCode,
    messageId: envelope.messageId,
    nonce: envelope.nonce,
    payload: envelope.payload,
  });
}
