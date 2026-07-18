import { z } from "zod";

export const VISION_CAMERA_MAINTENANCE_CONTRACT_VERSION =
  "vem.vision.camera-maintenance/v2" as const;

export const visionCameraMaintenanceRoleSchema = z.enum(["top", "front"]);

export const visionCameraBackendObservationSchema = z
  .object({
    backend: z.string().trim().min(1),
    index: z.number().int().min(0).nullable(),
    available: z.boolean(),
    mappingState: z.enum(["proven", "unproven"]),
  })
  .strict();

export const visionCameraMaintenanceCandidateSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    backendObservation: visionCameraBackendObservationSchema,
  })
  .strict();

const unboundRoleStatusSchema = z
  .object({
    role: visionCameraMaintenanceRoleSchema,
    state: z.literal("unbound"),
    ready: z.literal(false),
    reason: z.literal("camera_not_confirmed"),
  })
  .strict();

const missingRoleStatusSchema = z
  .object({
    role: visionCameraMaintenanceRoleSchema,
    state: z.literal("missing"),
    ready: z.literal(false),
    candidateId: z.string().trim().min(1),
    reason: z.enum(["bound_camera_missing", "bound_camera_unavailable"]),
    backendObservation: visionCameraBackendObservationSchema,
  })
  .strict();

const ambiguousRoleStatusSchema = z
  .object({
    role: visionCameraMaintenanceRoleSchema,
    state: z.literal("ambiguous"),
    ready: z.literal(false),
    candidateId: z.string().trim().min(1),
    reason: z.enum([
      "stable_identity_is_not_unique",
      "stable_identity_bound_to_multiple_roles",
      "camera_mapping_unproven",
    ]),
    backendObservation: visionCameraBackendObservationSchema,
  })
  .strict();

const readyRoleStatusSchema = z
  .object({
    role: visionCameraMaintenanceRoleSchema,
    state: z.literal("ready"),
    ready: z.literal(true),
    candidateId: z.string().trim().min(1),
    backendObservation: visionCameraBackendObservationSchema,
  })
  .strict();

export const visionCameraMaintenanceRoleStatusSchema = z.discriminatedUnion(
  "state",
  [
    unboundRoleStatusSchema,
    missingRoleStatusSchema,
    ambiguousRoleStatusSchema,
    readyRoleStatusSchema,
  ],
);

export const visionCameraMaintenanceContractSchema = z
  .object({
    contractVersion: z.literal(VISION_CAMERA_MAINTENANCE_CONTRACT_VERSION),
    generation: z.string().trim().min(1),
    candidates: z.array(visionCameraMaintenanceCandidateSchema),
    roles: z
      .object({
        top: visionCameraMaintenanceRoleStatusSchema,
        front: visionCameraMaintenanceRoleStatusSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.roles.top.role !== "top") {
      context.addIssue({
        code: "custom",
        path: ["roles", "top", "role"],
        message: "top role status must declare role=top",
      });
    }
    if (value.roles.front.role !== "front") {
      context.addIssue({
        code: "custom",
        path: ["roles", "front", "role"],
        message: "front role status must declare role=front",
      });
    }
  });

export const visionCameraMaintenanceTestRequestSchema = z
  .object({
    candidateId: z.string().trim().min(1),
  })
  .strict();

export const visionCameraMaintenanceEvidenceSchema = z
  .object({
    id: z.string().trim().min(1),
    role: visionCameraMaintenanceRoleSchema,
    candidateId: z.string().trim().min(1),
    generation: z.string().trim().min(1),
    expiresAt: z.number().int(),
  })
  .strict();

export const visionCameraMaintenanceTestResponseSchema = z
  .object({
    role: visionCameraMaintenanceRoleSchema,
    candidateId: z.string().trim().min(1),
    generation: z.string().trim().min(1),
    ok: z.literal(true),
    frame: z
      .object({
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      })
      .strict()
      .optional(),
    backendObservation: visionCameraBackendObservationSchema.optional(),
    evidence: visionCameraMaintenanceEvidenceSchema,
  })
  .strict();

export const visionCameraMaintenanceConfirmRequestSchema = z
  .object({
    candidateId: z.string().trim().min(1),
    testEvidenceId: z.string().trim().min(1),
    operatorVisualConfirmation: z.literal(true),
    expectedGeneration: z.string().trim().min(1),
  })
  .strict();

export const visionCameraMaintenanceConfirmResponseSchema =
  readyRoleStatusSchema;

export const visionCameraMaintenanceErrorSchema = z
  .object({
    contractVersion: z.literal(VISION_CAMERA_MAINTENANCE_CONTRACT_VERSION),
    error: z
      .object({
        code: z.string().trim().min(1),
        message: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export type VisionCameraMaintenanceRole = z.infer<
  typeof visionCameraMaintenanceRoleSchema
>;
export type VisionCameraMaintenanceContract = z.infer<
  typeof visionCameraMaintenanceContractSchema
>;
export type VisionCameraMaintenanceRoleStatus = z.infer<
  typeof visionCameraMaintenanceRoleStatusSchema
>;
export type VisionCameraMaintenanceCandidate = z.infer<
  typeof visionCameraMaintenanceCandidateSchema
>;
export type VisionCameraMaintenanceTestRequest = z.infer<
  typeof visionCameraMaintenanceTestRequestSchema
>;
export type VisionCameraMaintenanceTestResponse = z.infer<
  typeof visionCameraMaintenanceTestResponseSchema
>;
export type VisionCameraMaintenanceConfirmRequest = z.infer<
  typeof visionCameraMaintenanceConfirmRequestSchema
>;
export type VisionCameraMaintenanceConfirmResponse = z.infer<
  typeof visionCameraMaintenanceConfirmResponseSchema
>;
