import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { GithubOidcTrustPolicy } from "./github-actions-oidc";

import {
  GITHUB_ACTIONS_JWKS_URL,
  GITHUB_ACTIONS_JWKS_MAX_BYTES,
  GithubActionsOidcJwksProvider,
  validateGithubActionsOidcTokenWithProvider,
} from "./github-actions-oidc-jwks";

const liveShapedJwks = {
  keys: [
    {
      kty: "RSA",
      kid: "live-shaped-key",
      use: "sig",
      alg: "RS256",
      n: "test-modulus",
      e: "AQAB",
      x5c: ["test-certificate"],
      x5t: "test-thumbprint",
      "x5t#S256": "test-sha256-thumbprint",
    },
  ],
};

describe("GitHub Actions OIDC JWKS provider", () => {
  it("fetches only the fixed GitHub HTTPS endpoint and refuses redirects", async () => {
    const fetchSpy = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify(liveShapedJwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const provider = new GithubActionsOidcJwksProvider({ fetch: fetchSpy });

    await expect(provider.get()).resolves.toMatchObject({
      jwks: liveShapedJwks,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      GITHUB_ACTIONS_JWKS_URL,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects a redirect response even when a fetch implementation returns it", async () => {
    const provider = new GithubActionsOidcJwksProvider({
      fetch: vi.fn(async () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/jwks" },
          }),
        ),
      ),
    });

    await expect(provider.get()).rejects.toThrow("JWKS request failed");
  });

  it("rejects a JWKS response whose declared size exceeds the fixed bound", async () => {
    const oversized = JSON.stringify({
      keys: [
        {
          ...liveShapedJwks.keys[0],
          x5c: ["x".repeat(GITHUB_ACTIONS_JWKS_MAX_BYTES)],
        },
      ],
    });
    const provider = new GithubActionsOidcJwksProvider({
      fetch: vi.fn(async () =>
        Promise.resolve(
          new Response(oversized, {
            headers: { "content-length": String(Buffer.byteLength(oversized)) },
          }),
        ),
      ),
    });

    await expect(provider.get()).rejects.toThrow("JWKS response is too large");
  });

  it("stops reading a chunked JWKS response at the fixed size bound", async () => {
    const oversized = JSON.stringify({
      keys: [
        {
          ...liveShapedJwks.keys[0],
          x5c: ["x".repeat(GITHUB_ACTIONS_JWKS_MAX_BYTES)],
        },
      ],
    });
    const provider = new GithubActionsOidcJwksProvider({
      fetch: vi.fn(async () => Promise.resolve(new Response(oversized))),
    });

    await expect(provider.get()).rejects.toThrow("JWKS response is too large");
  });

  it("caches a valid key set and singleflights concurrent cache misses", async () => {
    const fetchSpy = vi.fn(async () =>
      Promise.resolve(new Response(JSON.stringify(liveShapedJwks))),
    );
    const provider = new GithubActionsOidcJwksProvider({ fetch: fetchSpy });

    const concurrent = await Promise.all([
      provider.get(),
      provider.get(),
      provider.get(),
    ]);
    const cached = await provider.get();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(concurrent.map((snapshot) => snapshot.generation)).toEqual([
      1, 1, 1,
    ]);
    expect(cached.generation).toBe(1);
  });

  it("refreshes an unknown kid once for all validators that saw the same generation", async () => {
    const rotatedJwks = {
      keys: [{ ...liveShapedJwks.keys[0], kid: "rotated-key" }],
    };
    const responses = [liveShapedJwks, rotatedJwks];
    const fetchSpy = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(responses[fetchSpy.mock.calls.length - 1])),
      ),
    );
    const provider = new GithubActionsOidcJwksProvider({ fetch: fetchSpy });
    const initial = await provider.get();

    const refreshed = await Promise.all([
      provider.refreshAfterUnknownKid(initial.generation),
      provider.refreshAfterUnknownKid(initial.generation),
      provider.refreshAfterUnknownKid(initial.generation),
    ]);
    const late = await provider.refreshAfterUnknownKid(initial.generation);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.map((snapshot) => snapshot.generation)).toEqual([2, 2, 2]);
    expect(late).toMatchObject({ generation: 2, jwks: rotatedJwks });
  });

  it("never uses the network when a deployment mounts a static key set", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not be used");
    });
    const provider = new GithubActionsOidcJwksProvider({
      staticJwks: liveShapedJwks,
      fetch: fetchSpy,
    });

    const initial = await provider.get();
    const refresh = await provider.refreshAfterUnknownKid(initial.generation);

    expect(initial).toEqual({ jwks: liveShapedJwks, generation: 1 });
    expect(refresh).toBe(initial);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes exactly once when signed validation encounters a rotated kid", async () => {
    const oldKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oldPublic = oldKey.publicKey.export({ format: "jwk" });
    const rotatedPublic = rotatedKey.publicKey.export({ format: "jwk" });
    const responses = [
      { keys: [{ ...oldPublic, kid: "old-key", alg: "RS256", use: "sig" }] },
      {
        keys: [
          { ...rotatedPublic, kid: "rotated-key", alg: "RS256", use: "sig" },
        ],
      },
    ];
    const fetchSpy = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(responses[fetchSpy.mock.calls.length - 1])),
      ),
    );
    const provider = new GithubActionsOidcJwksProvider({ fetch: fetchSpy });
    const now = 1_783_684_800;
    const policy: GithubOidcTrustPolicy = {
      repositoryId: "123456789",
      workflowIdentity: {
        claimModel: "direct",
        workflowRef:
          "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
      },
      refs: ["refs/heads/main"],
      events: ["workflow_dispatch"],
      environments: ["vem-maintenance-testbed"],
      requireRefProtected: true,
      allowedRunnerPeerIds: ["11111111-1111-4111-8111-111111111111"],
      targetMachineCodes: ["VEM-TESTBED-RUNTIME-ACCEPTANCE"],
    };
    const header = encode({ alg: "RS256", kid: "rotated-key", typ: "JWT" });
    const payload = encode({
      iss: "https://token.actions.githubusercontent.com",
      aud: "vem-maintenance",
      repository_id: "123456789",
      workflow: "VM Runtime Acceptance",
      workflow_ref:
        "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
      workflow_sha: "a".repeat(40),
      ref: "refs/heads/main",
      ref_protected: "true",
      event_name: "workflow_dispatch",
      sha: "a".repeat(40),
      run_id: "987654321",
      run_attempt: "3",
      environment: "vem-maintenance-testbed",
      jti: "rotated-key-fixture",
      iat: now - 1,
      nbf: now - 1,
      exp: now + 299,
    });
    const signingInput = `${header}.${payload}`;
    const token = `${signingInput}.${sign(
      "RSA-SHA256",
      Buffer.from(signingInput),
      rotatedKey.privateKey,
    ).toString("base64url")}`;

    await expect(
      validateGithubActionsOidcTokenWithProvider(token, {
        now,
        policy,
        provider,
      }),
    ).resolves.toMatchObject({ workflowSha: "a".repeat(40) });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
