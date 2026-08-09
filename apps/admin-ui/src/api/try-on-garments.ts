import type { z } from "zod";

import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminListTryOnGarmentsByProductContract,
  adminTryOnGarmentConfirmationContract,
  adminTryOnGarmentActivationContract,
  adminTryOnGarmentAssociationContract,
  adminTryOnGarmentRetirementContract,
  adminTryOnGarmentSourceReplacementContract,
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

export async function listTryOnGarmentsByProduct(
  productId: string,
): Promise<TryOnGarmentResponse[]> {
  return await callAdminEndpointContract(
    adminListTryOnGarmentsByProductContract,
    {
      query: { productId },
    },
  );
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

export async function activateTryOnGarment(
  id: string,
): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(adminTryOnGarmentActivationContract, {
    pathParams: { id },
    body: {},
  });
}

export async function retireTryOnGarment(
  id: string,
): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(adminTryOnGarmentRetirementContract, {
    pathParams: { id },
    body: {},
  });
}

export async function replaceTryOnGarmentVariantAssociations(
  id: string,
  variantIds: string[],
): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(adminTryOnGarmentAssociationContract, {
    pathParams: { id },
    body: { variantIds },
  });
}

export async function replaceTryOnGarmentSource(
  id: string,
  sourceMediaAssetId: string,
  template: TryOnGarmentDraftRequest["template"],
): Promise<TryOnGarmentResponse> {
  return await callAdminEndpointContract(
    adminTryOnGarmentSourceReplacementContract,
    { pathParams: { id }, body: { sourceMediaAssetId, template } },
  );
}

export type { TryOnGarmentDraftRequest, TryOnGarmentResponse };
