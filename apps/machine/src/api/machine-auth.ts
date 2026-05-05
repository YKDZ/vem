import {
  machineAuthTokenRequestSchema,
  machineAuthTokenResponseSchema,
  type MachineAuthTokenResponse,
} from "@vem/shared";

import type { MachineConfig } from "@/config/machine-config";

import { createMachineApiClient } from "./request";

export async function requestMachineToken(
  config: MachineConfig,
): Promise<MachineAuthTokenResponse> {
  if (!config.machineCode || !config.machineSecret) {
    throw new Error("machineCode and machineSecret are required");
  }
  const client = createMachineApiClient(config.apiBaseUrl);
  const response = await client.post<MachineAuthTokenResponse>(
    "/machine-auth/token",
    machineAuthTokenRequestSchema.parse({
      machineCode: config.machineCode,
      machineSecret: config.machineSecret,
    }),
  );
  return machineAuthTokenResponseSchema.parse(response);
}
