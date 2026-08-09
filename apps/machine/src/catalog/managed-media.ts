import {
  isManagedMediaReference,
  type ManagedMediaProjection,
} from "@vem/shared";

export type ManagedMediaResolution = {
  url: string | null;
  diagnostic: string | null;
};

/** Machine presentation consumes only the daemon's verified loopback projection. */
export function resolveDaemonManagedMedia(
  projection: ManagedMediaProjection | null | undefined,
  fallback: string,
): ManagedMediaResolution {
  if (!projection) {
    return { url: fallback, diagnostic: "managed media is unavailable" };
  }
  if (projection.readiness !== "ready" || !projection.readyUrl) {
    return {
      url: fallback,
      diagnostic:
        projection.diagnostic ?? `managed media is ${projection.readiness}`,
    };
  }
  try {
    const url = new URL(projection.readyUrl);
    if (
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "[::1]" &&
      url.hostname !== "localhost"
    ) {
      return { url: fallback, diagnostic: "daemon media URL is not loopback" };
    }
    return { url: projection.readyUrl, diagnostic: null };
  } catch {
    return { url: fallback, diagnostic: "daemon media URL is invalid" };
  }
}

export function resolveDaemonReadyUrl(
  readyUrl: string | null | undefined,
  fallback: string,
): ManagedMediaResolution {
  if (readyUrl === undefined) return { url: null, diagnostic: null };
  if (!readyUrl)
    return { url: fallback, diagnostic: "managed media is not ready" };
  try {
    const url = new URL(readyUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return { url: fallback, diagnostic: "daemon media URL is not loopback" };
    }
    return { url: readyUrl, diagnostic: null };
  } catch {
    return { url: fallback, diagnostic: "daemon media URL is invalid" };
  }
}

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
  const match = /^(media:[^:]+:coverImageUrl)(?:$|:)/.exec(diagnosticKey);
  return match?.[1] ?? null;
}
