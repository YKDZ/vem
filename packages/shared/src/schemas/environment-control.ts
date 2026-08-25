import { z } from "zod";

export const environmentControlSourceSchema = z.enum([
  "local_operator",
  "remote_operator",
  "stable_presence",
  "automatic_policy",
  "system_lifecycle",
]);

export const environmentControlActionKindSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("set_air_conditioner"),
    enabled: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("set_target_temperature"),
    temperatureCelsius: z.number().int().min(18).max(30),
  }),
  z.strictObject({
    type: z.literal("set_base_vent_speed"),
    ventSpeed: z.number().int().min(0).max(4),
  }),
  z.strictObject({ type: z.literal("temporarily_stop_vent") }),
  z.strictObject({ type: z.literal("restore_base_vent_speed") }),
  z.strictObject({ type: z.literal("retry_current_desired") }),
]);

export const environmentControlActionSchema = z.strictObject({
  actionId: z.string().trim().min(1).max(128),
  source: environmentControlSourceSchema,
  action: environmentControlActionKindSchema,
});

export const environmentControlConvergenceSchema = z.enum([
  "pending",
  "applied",
  "offline",
  "failed",
]);

const environmentControlSettingsSchema = z.strictObject({
  airConditionerEnabled: z.boolean(),
  targetTemperatureCelsius: z.number().int().min(18).max(30),
  baseVentSpeed: z.number().int().min(0).max(4),
});

const desiredEnvironmentControlSchema = z.strictObject({
  airConditionerEnabled: z.boolean(),
  targetTemperatureCelsius: z.number().int().min(18).max(30),
  ventSpeed: z.number().int().min(0).max(4),
});

const confirmedEnvironmentControlSchema = z.strictObject({
  airConditionerEnabled: z.boolean().nullable(),
  targetTemperatureCelsius: z.number().int().min(18).max(30).nullable(),
  ventSpeed: z.number().int().min(0).max(4).nullable(),
});

const environmentControlActionAuditSchema = z.strictObject({
  actionId: z.string().min(1).max(128),
  source: environmentControlSourceSchema,
  action: z.enum([
    "set_air_conditioner",
    "set_target_temperature",
    "set_base_vent_speed",
    "temporarily_stop_vent",
    "restore_base_vent_speed",
    "retry_current_desired",
  ]),
  acceptedAt: z.iso.datetime(),
});

export const environmentControlSnapshotSchema = z.strictObject({
  schemaVersion: z.literal("vem-environment-control/v1"),
  revision: z.number().int().nonnegative(),
  settings: environmentControlSettingsSchema,
  desired: desiredEnvironmentControlSchema,
  confirmed: confirmedEnvironmentControlSchema,
  convergence: environmentControlConvergenceSchema,
  reasonCode: z.string().min(1).max(128),
  message: z.string().max(500).nullable(),
  lastAction: environmentControlActionAuditSchema.nullable(),
  updatedAt: z.iso.datetime(),
  lastAttemptAt: z.iso.datetime().nullable(),
  confirmedAt: z.iso.datetime().nullable(),
});

export const environmentControlAdmissionSchema = z.strictObject({
  outcome: z.enum(["accepted", "deduplicated"]),
  acceptedRevision: z.number().int().nonnegative(),
  snapshot: environmentControlSnapshotSchema,
});

export const environmentControlProjectionSchema = z.strictObject({
  snapshot: environmentControlSnapshotSchema,
  observedAt: z.iso.datetime(),
  stale: z.boolean(),
});

export const daemonIpcEnvironmentControlContractSchema = z.strictObject({
  action: environmentControlActionSchema,
  admission: environmentControlAdmissionSchema,
  snapshot: environmentControlSnapshotSchema,
});

export type EnvironmentControlSource = z.infer<
  typeof environmentControlSourceSchema
>;
export type EnvironmentControlActionKind = z.infer<
  typeof environmentControlActionKindSchema
>;
export type EnvironmentControlAction = z.infer<
  typeof environmentControlActionSchema
>;
export type EnvironmentControlConvergence = z.infer<
  typeof environmentControlConvergenceSchema
>;
export type EnvironmentControlSnapshot = z.infer<
  typeof environmentControlSnapshotSchema
>;
export type EnvironmentControlAdmission = z.infer<
  typeof environmentControlAdmissionSchema
>;
export type EnvironmentControlProjection = z.infer<
  typeof environmentControlProjectionSchema
>;
