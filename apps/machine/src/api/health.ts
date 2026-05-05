import type { MachineApiClient } from "./request";

export type HealthStatus = {
  database: "ok";
  mqtt: "connected" | "disconnected";
};

export async function getHealth(
  client: MachineApiClient,
): Promise<HealthStatus> {
  return await client.get<HealthStatus>("/health");
}
