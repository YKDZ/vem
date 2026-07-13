import {
  qweatherConfigResponseSchema,
  qweatherConfigNoBodySchema,
  updateQweatherConfigSchema,
  type QweatherConfigResponse,
  type UpdateQweatherConfigInput,
} from "@vem/shared";

import { getContract, putContract } from "./request";

export async function getQweatherConfig(): Promise<QweatherConfigResponse> {
  return await getContract(
    "/qweather-config",
    qweatherConfigNoBodySchema,
    qweatherConfigResponseSchema,
    {},
  );
}

export async function updateQweatherConfig(
  body: UpdateQweatherConfigInput,
): Promise<QweatherConfigResponse> {
  return await putContract(
    "/qweather-config",
    updateQweatherConfigSchema,
    qweatherConfigResponseSchema,
    body,
  );
}
