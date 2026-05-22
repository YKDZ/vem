import { get, post } from "./request";

export type HardwareErrorPolicy = {
  id: string;
  errorCode: string | null;
  restoreInventory: boolean;
  faultSlot: boolean;
  requestRefund: boolean;
  createWorkOrder: boolean;
  severity: "info" | "warning" | "critical";
  createdAt: string;
  updatedAt: string;
};

export type UpsertHardwareErrorPolicyInput = {
  errorCode: string | null;
  restoreInventory: boolean;
  faultSlot: boolean;
  requestRefund: boolean;
  createWorkOrder: boolean;
  severity: "info" | "warning" | "critical";
};

export async function listHardwareErrorPolicies(): Promise<
  HardwareErrorPolicy[]
> {
  return await get<HardwareErrorPolicy[]>("/hardware-error-policies");
}

export async function upsertHardwareErrorPolicy(
  input: UpsertHardwareErrorPolicyInput,
): Promise<HardwareErrorPolicy> {
  return await post<HardwareErrorPolicy>("/hardware-error-policies", input);
}
