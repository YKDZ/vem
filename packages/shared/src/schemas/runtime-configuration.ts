import { z } from "zod";

import { hardwareSlotTopologyIdentitySchema } from "./machines";

export const runtimeBootstrapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provisioningApiBaseUrl: z.url(),
  hardwareModel: z.string().trim().min(1).max(128),
  topology: hardwareSlotTopologyIdentitySchema,
});

const cachedProvisioningProfileSchema = z.strictObject({
  machine: z.strictObject({
    id: z.uuid(),
    code: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(128),
    status: z.string().trim().min(1).max(64),
    locationLabel: z.string().trim().min(1).max(256).nullable(),
  }),
  apiBaseUrl: z.url(),
  runtimeEndpoints: z.strictObject({
    apiBasePath: z.literal("/api"),
    machineAuthTokenPath: z.literal("/api/machine-auth/token"),
    machineApiBasePath: z.string().regex(/^\/api\/machines\/[^/]+$/),
    mqttTopicPrefix: z.string().regex(/^vem\/machines\/[^/]+$/),
  }),
  mqttConnection: z.strictObject({
    url: z.url(),
    clientId: z.string().trim().min(1).max(128),
    username: z.string().trim().min(1).max(128).nullable(),
  }),
  hardwareProfile: z.strictObject({
    profile: z.literal("production"),
    controller: z.strictObject({
      required: z.literal(true),
      protocol: z.literal("vem-vending-controller"),
    }),
    paymentScanner: z.strictObject({
      required: z.literal(true),
      supportsPaymentCode: z.boolean(),
    }),
    vision: z.strictObject({
      required: z.boolean(),
      supportsRecommendations: z.boolean(),
    }),
  }),
  hardwareModel: z.string().trim().min(1).max(128),
  hardwareSlotTopology: hardwareSlotTopologyIdentitySchema,
  paymentCapability: z.strictObject({
    profile: z.literal("production"),
    qrCodeEnabled: z.boolean(),
    paymentCodeEnabled: z.boolean(),
    serverTime: z.iso.datetime({ offset: true }),
  }),
  metadata: z.strictObject({
    profileVersion: z.literal(1),
    profileRevision: z.number().int().positive(),
    claimCodeId: z.uuid(),
    claimedAt: z.iso.datetime({ offset: true }),
    serverTime: z.iso.datetime({ offset: true }),
  }),
});

export const provisioningProfileCacheSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generation: z.number().int().positive(),
  acceptedAt: z.iso.datetime({ offset: true }),
  profile: cachedProvisioningProfileSchema,
});

const secretStatusSchema = z.strictObject({
  machineSecretConfigured: z.boolean(),
  mqttSigningSecretConfigured: z.boolean(),
  mqttPasswordConfigured: z.boolean(),
});

const stableSerialIdentitySchema = z.strictObject({
  identityKey: z.string().trim().min(1).max(256),
  instanceId: z.string().trim().min(1).max(512).nullable(),
  containerId: z.string().uuid().nullable(),
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
  machine: cachedProvisioningProfileSchema.shape.machine.nullable(),
  platform: z
    .strictObject({
      apiBaseUrl: cachedProvisioningProfileSchema.shape.apiBaseUrl,
      runtimeEndpoints: cachedProvisioningProfileSchema.shape.runtimeEndpoints,
      mqttConnection: cachedProvisioningProfileSchema.shape.mqttConnection,
      paymentCapability: cachedProvisioningProfileSchema.shape.paymentCapability,
    })
    .nullable(),
  hardware: z.strictObject({
    model: runtimeBootstrapSchema.shape.hardwareModel,
    topology: runtimeBootstrapSchema.shape.topology,
    expectedProfile: cachedProvisioningProfileSchema.shape.hardwareProfile.nullable(),
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

export function exportRuntimeConfigurationJsonSchema(): RuntimeConfigurationJsonSchemaDocument {
  const schema = z.toJSONSchema(effectiveMachineRuntimeConfigurationSchema);
  return {
    ...schema,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "EffectiveMachineRuntimeConfiguration",
  };
}
