import { z } from "zod";

import type { MachineConfig } from "@/config/machine-config";

import { getMachineRuntimeConfig } from "@/native/local-config";

import { requestMachineToken } from "./machine-auth";
import { createMachineApiClient } from "./request";

export const mockPaymentTransitionSchema = z.object({
  paymentNo: z.string().min(1),
  status: z.string().min(1),
  orderId: z.uuid(),
  alreadyHandled: z.boolean(),
});

export type MockPaymentTransition = z.infer<typeof mockPaymentTransitionSchema>;

async function getMockPaymentToken(config: MachineConfig): Promise<string> {
  // Always fetch a fresh token for mock payments.
  // Use getMachineRuntimeConfig to get secrets from browserRuntimeSecrets,
  // which survive clearPlaintextSecrets() and HMR token state resets.
  const runtimeConfig = await getMachineRuntimeConfig();
  const fullConfig: MachineConfig = {
    ...runtimeConfig,
    apiBaseUrl: config.apiBaseUrl || runtimeConfig.apiBaseUrl,
  };
  const response = await requestMachineToken(fullConfig);
  return response.accessToken;
}

export async function markMockPaymentSucceeded(
  config: MachineConfig,
  orderNo: string,
): Promise<MockPaymentTransition> {
  const token = await getMockPaymentToken(config);
  const client = createMachineApiClient(config.apiBaseUrl, {
    skipAuthRetry: true,
  });
  const response = await client.post<unknown>(
    `/machine-orders/${encodeURIComponent(orderNo)}/mock-payment/succeed`,
    undefined,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return mockPaymentTransitionSchema.parse(response);
}

export async function markMockPaymentFailed(
  config: MachineConfig,
  orderNo: string,
): Promise<MockPaymentTransition> {
  const token = await getMockPaymentToken(config);
  const client = createMachineApiClient(config.apiBaseUrl, {
    skipAuthRetry: true,
  });
  const response = await client.post<unknown>(
    `/machine-orders/${encodeURIComponent(orderNo)}/mock-payment/fail`,
    undefined,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return mockPaymentTransitionSchema.parse(response);
}
