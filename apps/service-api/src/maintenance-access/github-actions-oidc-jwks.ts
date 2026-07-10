import {
  GithubActionsOidcValidationError,
  parseGithubOidcJwks,
  validateGithubActionsOidcToken,
  type GithubOidcTrustPolicy,
  type VerifiedGithubActionsIdentity,
} from "./github-actions-oidc";

export const GITHUB_ACTIONS_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
export const GITHUB_ACTIONS_JWKS_MAX_BYTES = 64 * 1024;
const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60_000;

export type GithubActionsOidcJwksSnapshot = {
  jwks: unknown;
  generation: number;
};
type GithubActionsOidcFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class GithubActionsOidcJwksProvider {
  private readonly fetchImpl: GithubActionsOidcFetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly staticSnapshot: GithubActionsOidcJwksSnapshot | undefined;
  private generation = 0;
  private cached:
    | { snapshot: GithubActionsOidcJwksSnapshot; expiresAt: number }
    | undefined;
  private inFlight: Promise<GithubActionsOidcJwksSnapshot> | undefined;

  constructor(
    options: {
      fetch?: GithubActionsOidcFetch;
      now?: () => number;
      cacheTtlMs?: number;
      staticJwks?: unknown;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
    this.staticSnapshot = options.staticJwks
      ? { jwks: parseGithubOidcJwks(options.staticJwks), generation: 1 }
      : undefined;
  }

  async get(): Promise<GithubActionsOidcJwksSnapshot> {
    if (this.staticSnapshot) return this.staticSnapshot;
    if (this.cached && this.cached.expiresAt > this.now()) {
      return this.cached.snapshot;
    }
    if (this.inFlight) return await this.inFlight;
    return await this.startFetch();
  }

  async refreshAfterUnknownKid(
    observedGeneration: number,
  ): Promise<GithubActionsOidcJwksSnapshot> {
    if (this.staticSnapshot) return this.staticSnapshot;
    if (this.cached && this.cached.snapshot.generation !== observedGeneration) {
      return this.cached.snapshot;
    }
    if (this.inFlight) return await this.inFlight;
    return await this.startFetch();
  }

  private async startFetch(): Promise<GithubActionsOidcJwksSnapshot> {
    const request = this.fetchRemote().finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    this.inFlight = request;
    return await request;
  }

  private async fetchRemote(): Promise<GithubActionsOidcJwksSnapshot> {
    const response = await this.fetchImpl(GITHUB_ACTIONS_JWKS_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error("GitHub Actions OIDC JWKS request failed");
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^[0-9]+$/.test(declaredLength)) {
        throw new Error("GitHub Actions OIDC JWKS response size is invalid");
      }
      if (Number(declaredLength) > GITHUB_ACTIONS_JWKS_MAX_BYTES) {
        throw new Error("GitHub Actions OIDC JWKS response is too large");
      }
    }
    const jwks = parseGithubOidcJwks(await readBoundedJson(response));
    this.generation += 1;
    const snapshot = {
      jwks,
      generation: this.generation,
    };
    this.cached = {
      snapshot,
      expiresAt: this.now() + this.cacheTtlMs,
    };
    return snapshot;
  }
}

export async function validateGithubActionsOidcTokenWithProvider(
  token: string,
  options: {
    now: number;
    policy: GithubOidcTrustPolicy;
    provider: GithubActionsOidcJwksProvider;
  },
): Promise<VerifiedGithubActionsIdentity> {
  const initial = await options.provider.get();
  try {
    return await validateGithubActionsOidcToken(token, {
      jwks: initial.jwks,
      now: options.now,
      policy: options.policy,
    });
  } catch (error) {
    if (
      !(error instanceof GithubActionsOidcValidationError) ||
      error.reasonCode !== "jwks_key"
    ) {
      throw error;
    }
    const refreshed = await options.provider.refreshAfterUnknownKid(
      initial.generation,
    );
    return await validateGithubActionsOidcToken(token, {
      jwks: refreshed.jwks,
      now: options.now,
      policy: options.policy,
    });
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error("GitHub Actions OIDC JWKS response body is missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  await readBoundedChunks(reader, chunks, 0);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("GitHub Actions OIDC JWKS response is not valid JSON");
  }
}

async function readBoundedChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  totalBytes: number,
): Promise<void> {
  const chunk = await reader.read();
  if (chunk.done) return;

  const nextTotalBytes = totalBytes + chunk.value.byteLength;
  if (nextTotalBytes > GITHUB_ACTIONS_JWKS_MAX_BYTES) {
    await reader.cancel();
    throw new Error("GitHub Actions OIDC JWKS response is too large");
  }
  chunks.push(chunk.value);
  await readBoundedChunks(reader, chunks, nextTotalBytes);
}
