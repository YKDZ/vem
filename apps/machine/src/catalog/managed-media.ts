import { isManagedMediaReference } from "@vem/shared";

export type ManagedMediaResolution = {
  url: string | null;
  diagnostic: string | null;
};

export function managedMediaDiagnosticIdentity(reference: unknown): string {
  if (reference === null || reference === undefined) return "missing";
  if (typeof reference !== "string") return `invalid:${typeof reference}`;
  if (isManagedMediaReference(reference)) return `managed:${reference}`;
  return `invalid:${reference || "empty"}`;
}

export function managedMediaDiagnosticKey(
  locationKey: string,
  reference: unknown,
): string {
  return `${locationKey}:${managedMediaDiagnosticIdentity(reference)}`;
}

export function managedMediaDiagnosticLocation(
  diagnosticKey: string,
): string | null {
  const match =
    /^(media:[^:]+:(?:coverImageUrl|tryOnSilhouetteUrl))(?:$|:)/.exec(
      diagnosticKey,
    );
  return match?.[1] ?? null;
}

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
    if (typeof location !== "undefined" && location.origin) {
      return {
        url: new URL(reference, location.origin).toString(),
        diagnostic: null,
      };
    }
    return {
      url: null,
      diagnostic: "provisioned API origin is invalid for managed media",
    };
  }
}
