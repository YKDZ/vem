import {
  adminHardwareErrorPolicyListResponseSchema,
  adminHardwareErrorPolicyResponseSchema,
  upsertHardwareErrorPolicySchema,
  type AdminHardwareErrorPolicyResponse,
} from "@vem/shared";
import { z } from "zod";

import { getContract, postContract } from "./request";

const emptyQuerySchema = z.strictObject({});

export type HardwareErrorPolicy = AdminHardwareErrorPolicyResponse;

export async function listHardwareErrorPolicies(): Promise<
  HardwareErrorPolicy[]
> {
  return await getContract(
    "/hardware-error-policies",
    emptyQuerySchema,
    adminHardwareErrorPolicyListResponseSchema,
    {},
  );
}

export async function upsertHardwareErrorPolicy(
  input: z.input<typeof upsertHardwareErrorPolicySchema>,
): Promise<HardwareErrorPolicy> {
  return await postContract(
    "/hardware-error-policies",
    upsertHardwareErrorPolicySchema,
    adminHardwareErrorPolicyResponseSchema,
    input,
  );
}
