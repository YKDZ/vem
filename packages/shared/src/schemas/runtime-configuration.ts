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
  hardwareSlotTopology: hardwareSlotTopologyIdentitySchema,
  paymentCapability: z.strictObject({
    profile: z.literal("production"),
    qrCodeEnabled: z.boolean(),
    paymentCodeEnabled: z.boolean(),
    serverTime: z.iso.datetime({ offset: true }),
  }),
  metadata: z.strictObject({
    profileVersion: z.literal(1),
    claimCodeId: z.uuid(),
    claimedAt: z.iso.datetime({ offset: true }),
    serverTime: z.iso.datetime({ offset: true }),
  }),
});

export const provisioningProfileCacheSchema = z.strictObject({
  schemaVersion: z.literal(1),
  acceptedAt: z.iso.datetime({ offset: true }),
  profile: cachedProvisioningProfileSchema,
});

const secretStatusSchema = z.strictObject({
  machineSecretConfigured: z.boolean(),
  mqttSigningSecretConfigured: z.boolean(),
  mqttPasswordConfigured: z.boolean(),
});

export const effectiveMachineRuntimeConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  bootstrap: runtimeBootstrapSchema,
  profileCache: provisioningProfileCacheSchema.nullable(),
  profileRefresh: z.strictObject({
    status: z.enum(["unclaimed", "accepted", "degraded"]),
    lastError: z.string().nullable(),
  }),
  configuredSecrets: secretStatusSchema,
});

export type RuntimeBootstrap = z.infer<typeof runtimeBootstrapSchema>;
export type ProvisioningProfileCache = z.infer<
  typeof provisioningProfileCacheSchema
>;
export type EffectiveMachineRuntimeConfiguration = z.infer<
  typeof effectiveMachineRuntimeConfigurationSchema
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
