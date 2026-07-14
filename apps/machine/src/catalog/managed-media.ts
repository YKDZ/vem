import { isManagedMediaReference } from "@vem/shared";

export type ManagedMediaResolution = {
  url: string | null;
  diagnostic: string | null;
};

export function resolveManagedMediaReference(
  reference: string | null | undefined,
  provisionedApiBaseUrl: string,
): ManagedMediaResolution {
  if (!reference) {
    return {
      url: null,
      diagnostic: "managed media reference is missing",
    };
  }
  if (!isManagedMediaReference(reference)) {
    return {
      url: null,
      diagnostic: "managed media reference is outside the allowed content path",
    };
  }

  try {
    const origin = new URL(provisionedApiBaseUrl).origin;
    return { url: new URL(reference, origin).toString(), diagnostic: null };
  } catch {
    return {
      url: null,
      diagnostic: "provisioned API origin is invalid for managed media",
    };
  }
}
