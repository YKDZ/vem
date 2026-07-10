import { z } from "zod";

export const maintenancePeerRoleSchema = z.enum([
  "relay",
  "runner",
  "maintainer",
  "machine",
]);
export type MaintenancePeerRole = z.infer<typeof maintenancePeerRoleSchema>;
export const maintenancePeerRoles = maintenancePeerRoleSchema.options;

export const maintenanceSessionProtocolSchema = z.literal("tcp");
export type MaintenanceSessionProtocol = z.infer<
  typeof maintenanceSessionProtocolSchema
>;

export const maintenanceSessionPortSchema = z.literal(22);
export type MaintenanceSessionPort = z.infer<
  typeof maintenanceSessionPortSchema
>;

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const maintenanceWireGuardPublicKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9+/]{43}=$/,
    "WireGuard public key must be canonical base64 for exactly 32 bytes",
  )
  .refine(
    (value) => BASE64_ALPHABET.indexOf(value.charAt(42)) % 4 === 0,
    "WireGuard public key must be canonical base64 for exactly 32 bytes",
  );

export const registerMaintenancePeerRequestSchema = z.discriminatedUnion(
  "role",
  [
    z.strictObject({
      role: z.enum(["relay", "runner", "maintainer"]),
      publicKey: maintenanceWireGuardPublicKeySchema,
    }),
    z.strictObject({
      role: z.literal("machine"),
      publicKey: maintenanceWireGuardPublicKeySchema,
      machineId: z.uuid(),
    }),
  ],
);
export type RegisterMaintenancePeerRequest = z.infer<
  typeof registerMaintenancePeerRequestSchema
>;

export const maintenancePublicPeerSchema = z.strictObject({
  id: z.uuid(),
  role: maintenancePeerRoleSchema,
  publicKey: maintenanceWireGuardPublicKeySchema,
  tunnelAddress: z.ipv4(),
});
export type MaintenancePublicPeer = z.infer<typeof maintenancePublicPeerSchema>;

export const maintenanceSessionAuthorizationSchema = z.strictObject({
  sessionId: z.uuid(),
  sourcePeerId: z.uuid(),
  sourceTunnelAddress: z.ipv4(),
  targetMachineId: z.uuid(),
  targetTunnelAddress: z.ipv4(),
  protocol: maintenanceSessionProtocolSchema,
  port: maintenanceSessionPortSchema,
  expiresAt: z.iso.datetime(),
});
export type MaintenanceSessionAuthorization = z.infer<
  typeof maintenanceSessionAuthorizationSchema
>;

export const maintenanceRelayDesiredStateSchema = z.strictObject({
  schemaVersion: z.literal("maintenance-relay-desired-state/v1"),
  desiredStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  generatedAt: z.iso.datetime(),
  peers: z.array(maintenancePublicPeerSchema),
  authorizations: z.array(maintenanceSessionAuthorizationSchema),
});
export type MaintenanceRelayDesiredState = z.infer<
  typeof maintenanceRelayDesiredStateSchema
>;

export const maintenanceRelayPeerObservationSchema = z.strictObject({
  peerId: z.uuid(),
  latestHandshakeAt: z.iso.datetime().nullable(),
});
export type MaintenanceRelayPeerObservation = z.infer<
  typeof maintenanceRelayPeerObservationSchema
>;

export const maintenanceRelayAuthorizationObservationSchema = z.strictObject({
  sessionId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type MaintenanceRelayAuthorizationObservation = z.infer<
  typeof maintenanceRelayAuthorizationObservationSchema
>;

const maintenanceRelayHealthReasonSchema = z.string().min(1).max(500);

export const maintenanceRelayTransportSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("https"),
    health: z.literal("healthy"),
    reason: z.null(),
  }),
  z.strictObject({
    mode: z.literal("insecure-http"),
    health: z.literal("degraded"),
    reason: maintenanceRelayHealthReasonSchema,
  }),
  z.strictObject({
    mode: z.literal("unknown"),
    health: z.literal("unreported"),
    reason: z.literal("relay transport has not been reported"),
  }),
]);
export type MaintenanceRelayTransport = z.infer<
  typeof maintenanceRelayTransportSchema
>;

export const maintenanceRelayHealthSchema = z.discriminatedUnion(
  "observation",
  [
    z.strictObject({
      observation: z.literal("current"),
      overall: z.enum(["healthy", "degraded", "unknown"]),
      stale: z.literal(false),
      observedAt: z.iso.datetime(),
    }),
    z.strictObject({
      observation: z.literal("stale"),
      overall: z.literal("unknown"),
      stale: z.literal(true),
      observedAt: z.iso.datetime(),
    }),
    z.strictObject({
      observation: z.literal("unreported"),
      overall: z.literal("unknown"),
      stale: z.literal(false),
      observedAt: z.null(),
    }),
  ],
);
export type MaintenanceRelayHealth = z.infer<
  typeof maintenanceRelayHealthSchema
>;

export const maintenanceRelayFailureReasonCodeSchema = z.enum([
  "desired_state_rejected",
  "wireguard_apply_failed",
  "firewall_apply_failed",
  "journal_persist_failed",
  "peer_observation_failed",
  "relay_internal_error",
]);
export type MaintenanceRelayFailureReasonCode = z.infer<
  typeof maintenanceRelayFailureReasonCodeSchema
>;

export const maintenanceRelayFailureSchema = z.strictObject({
  reasonCode: maintenanceRelayFailureReasonCodeSchema,
});
export type MaintenanceRelayFailure = z.infer<
  typeof maintenanceRelayFailureSchema
>;

export const maintenanceFailureProjectionSchema = z.strictObject({
  reasonCode: maintenanceRelayFailureReasonCodeSchema,
  summary: z.string().min(1).max(200),
});
export type MaintenanceFailureProjection = z.infer<
  typeof maintenanceFailureProjectionSchema
>;

export const maintenanceRelayObservedStateSchema = z.strictObject({
  schemaVersion: z.literal("maintenance-relay-observed-state/v1"),
  observedAt: z.iso.datetime(),
  desiredStateSchemaVersion: z.literal("maintenance-relay-desired-state/v1"),
  appliedDesiredStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  attemptedDesiredStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  appliedPeerIds: z.array(z.uuid()),
  appliedAuthorizationIds: z.array(z.uuid()),
  peerObservations: z.array(maintenanceRelayPeerObservationSchema),
  activeAuthorizationObservations: z.array(
    maintenanceRelayAuthorizationObservationSchema,
  ),
  transport: maintenanceRelayTransportSchema,
  failure: maintenanceRelayFailureSchema.nullable(),
});
export type MaintenanceRelayObservedState = z.infer<
  typeof maintenanceRelayObservedStateSchema
>;

export const maintenanceRelayCredentialExchangeRequestSchema = z.strictObject({
  credential: z.string().min(32).max(512),
});
export type MaintenanceRelayCredentialExchangeRequest = z.infer<
  typeof maintenanceRelayCredentialExchangeRequestSchema
>;

export const maintenanceRelayCredentialExchangeResponseSchema = z.strictObject({
  actor: z.literal("maintenance_relay"),
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
});
export type MaintenanceRelayCredentialExchangeResponse = z.infer<
  typeof maintenanceRelayCredentialExchangeResponseSchema
>;

export const maintenanceSessionStatusSchema = z.enum([
  "active",
  "expired",
  "failed",
  "revoked",
]);
export type MaintenanceSessionStatus = z.infer<
  typeof maintenanceSessionStatusSchema
>;

export const maintenanceSessionKindSchema = z.enum(["human", "ci"]);
export type MaintenanceSessionKind = z.infer<
  typeof maintenanceSessionKindSchema
>;

export const maintenanceSessionRelayConvergenceSchema = z.strictObject({
  desiredStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  appliedDesiredStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["pending", "applied", "removed", "failed", "unknown"]),
});
export type MaintenanceSessionRelayConvergence = z.infer<
  typeof maintenanceSessionRelayConvergenceSchema
>;

export const maintenanceTargetMachineSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  maintenancePeerId: z.uuid(),
  tunnelAddress: z.ipv4(),
});
export type MaintenanceTargetMachine = z.infer<
  typeof maintenanceTargetMachineSchema
>;

const maintenanceSessionResponseBaseShape = {
  id: z.uuid(),
  targetMachine: maintenanceTargetMachineSchema,
  protocol: maintenanceSessionProtocolSchema,
  port: maintenanceSessionPortSchema,
  reason: z.string().min(3).max(500),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  expiredAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  failure: maintenanceFailureProjectionSchema.nullable(),
  revokedAt: z.iso.datetime().nullable(),
  status: maintenanceSessionStatusSchema,
  relayConvergence: maintenanceSessionRelayConvergenceSchema,
};

export const maintenanceHumanSessionResponseSchema = z.strictObject({
  ...maintenanceSessionResponseBaseShape,
  kind: z.literal("human"),
  actor: z.strictObject({
    type: z.literal("admin"),
    adminUserId: z.uuid(),
  }),
  sourcePeer: maintenancePublicPeerSchema.extend({
    role: z.literal("maintainer"),
  }),
});

export const maintenanceCiSessionResponseSchema = z.strictObject({
  ...maintenanceSessionResponseBaseShape,
  kind: z.literal("ci"),
  actor: z.strictObject({
    type: z.literal("automation"),
    automationActorId: z.string().min(1).max(128),
  }),
  sourcePeer: maintenancePublicPeerSchema.extend({
    role: z.literal("runner"),
  }),
});

export const maintenanceSessionResponseSchema = z.discriminatedUnion("kind", [
  maintenanceHumanSessionResponseSchema,
  maintenanceCiSessionResponseSchema,
]);
export type MaintenanceSessionResponse = z.infer<
  typeof maintenanceSessionResponseSchema
>;

export const createHumanMaintenanceSessionRequestSchema = z.strictObject({
  sourcePeerId: z.uuid(),
  targetMachineId: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  ttlMinutes: z
    .union([z.literal(30), z.literal(60), z.literal(120), z.literal(180)])
    .default(30),
  protocol: maintenanceSessionProtocolSchema.default("tcp"),
  port: maintenanceSessionPortSchema.default(22),
});
export type CreateHumanMaintenanceSessionRequest = z.infer<
  typeof createHumanMaintenanceSessionRequestSchema
>;

export const CI_MAINTENANCE_SESSION_TTL_MINUTES = 150;

export const createCiMaintenanceSessionCommandSchema = z.strictObject({
  sourcePeerId: z.uuid(),
  targetMachineId: z.uuid(),
  automationActorId: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(3).max(500),
  protocol: maintenanceSessionProtocolSchema.default("tcp"),
  port: maintenanceSessionPortSchema.default(22),
});
export type CreateCiMaintenanceSessionCommand = z.infer<
  typeof createCiMaintenanceSessionCommandSchema
>;

// Transitional alias while callers move to the explicitly human contract.
export const createMaintenanceSessionRequestSchema =
  createHumanMaintenanceSessionRequestSchema;
export type CreateMaintenanceSessionRequest =
  CreateHumanMaintenanceSessionRequest;

export const maintenanceSessionListQuerySchema = z.strictObject({
  status: maintenanceSessionStatusSchema.optional(),
  kind: maintenanceSessionKindSchema.optional(),
});
export type MaintenanceSessionListQuery = z.infer<
  typeof maintenanceSessionListQuerySchema
>;

export const maintenanceAccessAuditListQuerySchema = z.strictObject({
  sessionId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MaintenanceAccessAuditListQuery = z.infer<
  typeof maintenanceAccessAuditListQuerySchema
>;

export const maintenancePeerHealthSchema = z.strictObject({
  peer: maintenancePublicPeerSchema,
  relayApplied: z.boolean(),
  lastHandshakeAt: z.iso.datetime().nullable(),
  health: z.enum(["healthy", "stale", "unknown"]),
});
export type MaintenancePeerHealth = z.infer<typeof maintenancePeerHealthSchema>;

export const maintenanceAccessOverviewResponseSchema = z.strictObject({
  schemaVersion: z.literal("maintenance-access-overview/v1"),
  sourcePeers: z.array(maintenancePublicPeerSchema),
  targetMachines: z.array(maintenanceTargetMachineSchema),
  peerHealth: z.array(maintenancePeerHealthSchema),
  sessions: z.array(maintenanceSessionResponseSchema),
  desiredState: maintenanceRelayDesiredStateSchema,
  observedState: maintenanceRelayObservedStateSchema,
  relayFailure: maintenanceFailureProjectionSchema.nullable(),
  relayHealth: maintenanceRelayHealthSchema,
});
export type MaintenanceAccessOverviewResponse = z.infer<
  typeof maintenanceAccessOverviewResponseSchema
>;
