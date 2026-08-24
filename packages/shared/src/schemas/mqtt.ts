import { z } from "zod";

import { hardwareErrorCodeSchema } from "../enums/hardware";
import {
  environmentControlActionSchema,
  environmentControlConvergenceSchema,
} from "./environment-control";
import {
  addMachineSlotCoordinateIssue,
  machineSlotCellNoSchema,
  machineSlotRowNoSchema,
} from "./machine-slot-coordinate";

export const commandAckPayloadSchema = z
  .object({
    messageId: z.string().min(1).max(128).optional(),
  })
  .loose();

export const dispenseCommandPayloadSchema = z
  .object({
    commandNo: z.string().min(1).max(64),
    orderNo: z.string().min(1).max(64),
    slot: z
      .object({
        rowNo: machineSlotRowNoSchema,
        cellNo: machineSlotCellNoSchema,
      })
      .strict()
      .superRefine(addMachineSlotCoordinateIssue),
    quantity: z.int().positive(),
    timeoutSeconds: z.int().positive(),
    recovery: z
      .object({
        action: z.literal("compensation_dispense"),
        originalCommandNo: z.string().min(1).max(64),
        note: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();

export const environmentControlCommandPayloadSchema = z
  .strictObject({
    commandNo: z.string().min(1).max(64),
    action: environmentControlActionSchema,
    timeoutSeconds: z.int().positive(),
  })
  .refine((data) => data.action.source === "remote_operator", {
    path: ["action", "source"],
    message: "Remote environment actions must use remote_operator",
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
  .strictObject({
    commandNo: z.string().min(1).max(64),
    outcome: z.enum([
      "accepted",
      "deduplicated",
      "rejected",
      "acceptance_unknown",
    ]),
    acceptedRevision: z.number().int().nonnegative().nullable(),
    convergence: environmentControlConvergenceSchema.nullable(),
    reasonCode: z.string().min(1).max(128),
    message: z.string().max(500).nullable(),
    reportedAt: z.iso.datetime(),
  })
  .superRefine((data, ctx) => {
    const accepted =
      data.outcome === "accepted" || data.outcome === "deduplicated";
    if (accepted && data.acceptedRevision === null) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptedRevision"],
        message: "Accepted actions require a revision",
      });
    }
    if (accepted && data.convergence === null) {
      ctx.addIssue({
        code: "custom",
        path: ["convergence"],
        message: "Accepted actions require an initial convergence state",
      });
    }
    if (
      !accepted &&
      (data.acceptedRevision !== null || data.convergence !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unaccepted actions cannot report revision convergence",
      });
    }
  });

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
