import {
  machineRecommendationItemSchema,
  machineRecommendationRequestSchema,
  type MachineRecommendationItem,
  type MachineRecommendationRequest,
} from "@vem/shared";
import { z } from "zod";

import type { MachineApiClient } from "./request";

const machineRecommendationResponseSchema = z.array(
  machineRecommendationItemSchema,
);

export async function getMachineRecommendations(
  client: MachineApiClient,
  machineCode: string,
  input: MachineRecommendationRequest,
): Promise<MachineRecommendationItem[]> {
  const response = await client.post<unknown>(
    `/machines/${encodeURIComponent(machineCode)}/recommendations`,
    machineRecommendationRequestSchema.parse(input),
  );
  return machineRecommendationResponseSchema.parse(response);
}
