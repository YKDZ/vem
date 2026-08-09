import type { z } from "zod";

import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminTryOnGarmentConfirmationContract,
  adminTryOnGarmentActivationContract,
  adminTryOnGarmentRetirementContract,
  adminTryOnGarmentUploadContract,
  type TryOnGarmentDraftRequest,
  type TryOnGarmentMediaAsset,
  type TryOnGarmentResponse,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export async function uploadTryOnGarment(
  file: File,
): Promise<TryOnGarmentMediaAsset> {
  return await callAdminEndpointContract(adminTryOnGarmentUploadContract, {
    body: { file },
  });
}

export async function createTryOnGarmentDraft(
  body: z.input<typeof adminCreateTryOnGarmentContract.bodySchema>,
): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(adminCreateTryOnGarmentContract, {
    body,
  });
}

export async function getTryOnGarment(
  id: string,
): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(adminGetTryOnGarmentContract, {
    pathParams: { id },
  });
}

export async function confirmTryOnGarment(
  id: string,
): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(
    adminTryOnGarmentConfirmationContract,
    {
      pathParams: { id },
      body: {},
    },
  );
}

export async function activateTryOnGarment(id: string): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(adminTryOnGarmentActivationContract, {
    pathParams: { id }, body: {},
  });
}

export async function retireTryOnGarment(id: string): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(adminTryOnGarmentRetirementContract, {
    pathParams: { id }, body: {},
  });
}

export type { TryOnGarmentDraftRequest, TryOnGarmentResponse };
