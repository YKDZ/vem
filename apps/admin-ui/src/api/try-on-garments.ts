import type { z } from "zod";

import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminTryOnGarmentConfirmationContract,
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

export type { TryOnGarmentDraftRequest, TryOnGarmentResponse };
