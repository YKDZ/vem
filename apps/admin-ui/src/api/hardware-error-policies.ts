import {
  adminListHardwareErrorPoliciesContract,
  adminUpsertHardwareErrorPolicyContract,
  upsertHardwareErrorPolicySchema,
  type AdminHardwareErrorPolicyResponse,
} from "@vem/shared";
import { z } from "zod";

import { callAdminEndpointContract } from "./request";

export type HardwareErrorPolicy = AdminHardwareErrorPolicyResponse;

export async function listHardwareErrorPolicies(): Promise<
  HardwareErrorPolicy[]
> {
  return await callAdminEndpointContract(
    adminListHardwareErrorPoliciesContract,
    {},
  );
}

export async function upsertHardwareErrorPolicy(
  input: z.input<typeof upsertHardwareErrorPolicySchema>,
): Promise<HardwareErrorPolicy> {
  return await callAdminEndpointContract(
    adminUpsertHardwareErrorPolicyContract,
    { body: input },
  );
}
