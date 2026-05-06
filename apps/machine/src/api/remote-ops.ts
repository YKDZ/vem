import { z } from "zod";

import { createMachineApiClient } from "./request";

export const remoteOpSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  status: z.string(),
  requestedAt: z.string(),
});

export type RemoteOp = z.infer<typeof remoteOpSchema>;

export async function listPendingRemoteOps(
  apiBaseUrl: string,
): Promise<RemoteOp[]> {
  const client = createMachineApiClient(apiBaseUrl);
  const data = await client.get<unknown>("/machine-ops/pending");
  return z.array(remoteOpSchema).parse(data);
}

export async function completeLogExport(
  apiBaseUrl: string,
  opId: string,
  body: {
    fileName: string;
    contentType: string;
    base64: string;
    sizeBytes: number;
  },
): Promise<void> {
  const client = createMachineApiClient(apiBaseUrl);
  await client.post(`/machine-ops/${opId}/complete-log-export`, body);
}

export async function failRemoteOp(
  apiBaseUrl: string,
  opId: string,
  reason: string,
): Promise<void> {
  const client = createMachineApiClient(apiBaseUrl);
  await client.post(`/machine-ops/${opId}/fail`, { reason });
}
