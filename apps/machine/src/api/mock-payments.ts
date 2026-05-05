import { z } from "zod";

import type { MachineApiClient } from "./request";

export const mockPaymentTransitionSchema = z.object({
  paymentNo: z.string().min(1),
  status: z.string().min(1),
  orderId: z.uuid(),
  alreadyHandled: z.boolean(),
});

export type MockPaymentTransition = z.infer<typeof mockPaymentTransitionSchema>;

export async function markMockPaymentSucceeded(
  client: MachineApiClient,
  paymentNo: string,
): Promise<MockPaymentTransition> {
  const response = await client.post<unknown>(
    `/payments/mock/${encodeURIComponent(paymentNo)}/succeed`,
  );
  return mockPaymentTransitionSchema.parse(response);
}

export async function markMockPaymentFailed(
  client: MachineApiClient,
  paymentNo: string,
): Promise<MockPaymentTransition> {
  const response = await client.post<unknown>(
    `/payments/mock/${encodeURIComponent(paymentNo)}/fail`,
  );
  return mockPaymentTransitionSchema.parse(response);
}
