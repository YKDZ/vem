import { z } from "zod";

const maintenanceSshTargetPolicySchema = z.strictObject({
  profile: z.enum(["testbed", "production"]),
  targetMachineCodes: z
    .array(z.string().trim().min(1).max(64))
    .min(1)
    .max(128)
    .refine((codes) => new Set(codes).size === codes.length),
});

export type MaintenanceSshTargetPolicy = z.infer<
  typeof maintenanceSshTargetPolicySchema
>;

export function parseMaintenanceSshTargetPolicy(
  input: string,
): MaintenanceSshTargetPolicy {
  try {
    return maintenanceSshTargetPolicySchema.parse(JSON.parse(input));
  } catch {
    throw new Error("Maintenance SSH target policy is invalid");
  }
}
