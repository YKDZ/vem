import { z } from "zod";

import {
  hardwareSlotTopologyIdentitySchema,
  machineClaimRequestSchema,
  machineProvisioningProfileSchema,
} from "./machines";

export const runtimeBootstrapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provisioningApiBaseUrl: z.url(),
  hardwareModel: z.string().trim().min(1).max(128),
  topology: hardwareSlotTopologyIdentitySchema,
});

const claimMqttConnectionSchema =
  machineProvisioningProfileSchema.shape.credentials.shape.mqttConnection;

export const machineProvisioningProfileSnapshotSchema =
  machineProvisioningProfileSchema.omit({ credentials: true }).extend({
    mqttConnection: claimMqttConnectionSchema.omit({ password: true }).extend({
      username: claimMqttConnectionSchema.shape.username.nullable(),
    }),
  });

export const provisioningProfileCacheSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generation: z.number().int().positive(),
  acceptedAt: z.iso.datetime({ offset: true }),
  profile: machineProvisioningProfileSnapshotSchema,
});

const secretStatusSchema = z.strictObject({
  machineSecretConfigured: z.boolean(),
  mqttSigningSecretConfigured: z.boolean(),
  mqttPasswordConfigured: z.boolean(),
});

const stableSerialIdentitySchema = z.strictObject({
  identityKey: z.string().trim().min(1).max(256),
  instanceId: z.string().trim().min(1).max(512).nullable(),
  containerId: z.uuid().nullable(),
  hardwareIds: z.array(z.string().trim().min(1).max(256)).max(16),
  serialNumber: z.string().trim().min(1).max(128).nullable(),
});

const localSerialRoleBindingSchema = z.strictObject({
  identity: stableSerialIdentitySchema,
  confirmedAt: z.iso.datetime({ offset: true }),
  confirmedBy: z.string().trim().min(1).max(128),
  testEvidenceCode: z.string().trim().min(1).max(128),
});

export const scannerProtocolParametersSchema = z.strictObject({
  baudRate: z.number().int().min(1_200).max(230_400),
  frameSuffix: z.enum(["crlf", "lf", "cr", "none"]),
});

export const audioPreferencesSchema = z.strictObject({
  volume: z.number().min(0).max(1),
  cuesEnabled: z.boolean(),
  presenceCuesEnabled: z.boolean(),
  transactionCuesEnabled: z.boolean(),
});

export const confirmHardwareBindingRequestSchema = z.strictObject({
  identityKey: z.string().trim().min(1).max(256),
  testEvidenceToken: z.uuid(),
});

export const clearHardwareBindingRequestSchema = z.strictObject({});

export const setScannerProtocolParametersRequestSchema =
  scannerProtocolParametersSchema.nullable();

export const setAudioPreferencesRequestSchema = audioPreferencesSchema;

export const effectiveMachineRuntimeConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  sourceRevisions: z.strictObject({
    bootstrapSchemaVersion: z.literal(1),
    profile: z
      .strictObject({
        generation: z.number().int().positive(),
        profileRevision: z.number().int().positive(),
        acceptedAt: z.iso.datetime({ offset: true }),
      })
      .nullable(),
    localSettingsRevision: z.number().int().nonnegative(),
  }),
  sourceDocuments: z.strictObject({
    bootstrap: runtimeBootstrapSchema,
    profileCache: provisioningProfileCacheSchema.nullable(),
  }),
  machine: machineProvisioningProfileSnapshotSchema.shape.machine.nullable(),
  platform: z
    .strictObject({
      apiBaseUrl: machineProvisioningProfileSnapshotSchema.shape.apiBaseUrl,
      runtimeEndpoints:
        machineProvisioningProfileSnapshotSchema.shape.runtimeEndpoints,
      mqttConnection:
        machineProvisioningProfileSnapshotSchema.shape.mqttConnection,
      paymentCapability:
        machineProvisioningProfileSnapshotSchema.shape.paymentCapability,
    })
    .nullable(),
  hardware: z.strictObject({
    model: runtimeBootstrapSchema.shape.hardwareModel,
    topology: runtimeBootstrapSchema.shape.topology,
    expectedProfile:
      machineProvisioningProfileSnapshotSchema.shape.hardwareProfile.nullable(),
    lowerControllerBinding: localSerialRoleBindingSchema.nullable(),
    scannerBinding: localSerialRoleBindingSchema.nullable(),
    scannerProtocol: scannerProtocolParametersSchema.nullable(),
  }),
  experience: z.strictObject({
    audio: audioPreferencesSchema,
  }),
  secretStatus: secretStatusSchema,
  profileRefresh: z.strictObject({
    status: z.enum(["unclaimed", "accepted", "degraded"]),
    lastError: z.string().nullable(),
  }),
});

export type RuntimeBootstrap = z.infer<typeof runtimeBootstrapSchema>;
export type ProvisioningProfileCache = z.infer<
  typeof provisioningProfileCacheSchema
>;
export type MachineProvisioningProfileSnapshot = z.infer<
  typeof machineProvisioningProfileSnapshotSchema
>;
export type EffectiveMachineRuntimeConfiguration = z.infer<
  typeof effectiveMachineRuntimeConfigurationSchema
>;
export type ConfirmHardwareBindingRequest = z.infer<
  typeof confirmHardwareBindingRequestSchema
>;
export type ClearHardwareBindingRequest = z.infer<
  typeof clearHardwareBindingRequestSchema
>;
export type SetScannerProtocolParametersRequest = z.infer<
  typeof setScannerProtocolParametersRequestSchema
>;
export type SetAudioPreferencesRequest = z.infer<
  typeof setAudioPreferencesRequestSchema
>;

export type RuntimeConfigurationJsonSchemaDocument = {
  $schema: "https://json-schema.org/draft/2020-12/schema";
} & Record<string, unknown>;

export function exportScannerProtocolParametersJsonSchema(): RuntimeConfigurationJsonSchemaDocument {
  return {
    ...z.toJSONSchema(scannerProtocolParametersSchema),
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "ScannerProtocolParameters",
  };
}

export function exportRuntimeConfigurationJsonSchema(): RuntimeConfigurationJsonSchemaDocument {
  // The daemon generator needs every HTTP boundary from this source, while
  // each route still validates one member of this strict union.
  const schema = z.toJSONSchema(
    z.union([
      effectiveMachineRuntimeConfigurationSchema,
      confirmHardwareBindingRequestSchema,
      clearHardwareBindingRequestSchema,
      setScannerProtocolParametersRequestSchema,
      setAudioPreferencesRequestSchema,
      machineClaimRequestSchema,
      machineProvisioningProfileSchema,
      machineProvisioningProfileSnapshotSchema,
    ]),
  );
  return {
    ...schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "RuntimeConfigurationContract",
  };
}
