import type { z } from "zod";

import {
  adminGetQweatherConfigContract,
  adminUpdateQweatherConfigContract,
  updateQweatherConfigSchema,
  type QweatherConfigResponse,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export async function getQweatherConfig(): Promise<QweatherConfigResponse> {
  return await callAdminEndpointContract(adminGetQweatherConfigContract, {});
}

export async function updateQweatherConfig(
  body: z.input<typeof updateQweatherConfigSchema>,
): Promise<QweatherConfigResponse> {
  return await callAdminEndpointContract(adminUpdateQweatherConfigContract, {
    body,
  });
}
