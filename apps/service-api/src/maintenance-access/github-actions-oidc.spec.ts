import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GithubActionsOidcValidationError,
  validateGithubActionsOidcToken,
  type GithubOidcTrustPolicy,
} from "./github-actions-oidc";

const privateJwk = {
  kty: "RSA",
  n: "myxzfkvvok-UkVX2Pm4gVEn0_Fa2G1Xk9zyx-5QUGGxe3O2nXKP0mukpRpO-ERVAO_SVeo7LrQDwvCXWvacgEcDZ6i0xsHko-_d4fvOZ5skdH1mhH0JnHuM2TXu01yOM4WI6V2F1izt-2221f4rHkNwEa2PO1z8REu4a4-zzz14UOD6Lxl3WgovPljddYf7-dG73wYOuLTCurzf5szgdqahAOiUaDEI83cMYGj7_ooVi2JvkoZBTREKM76T7SrrsP9IvW9KdZQ_Lhs229lHgOWqjXLl6QMALk4qXZl7Z-gCsgdRGq13odPSujzZtSZaEXL9QtMabXe6WbGMH9ttlww",
  e: "AQAB",
  d: "FLyn1zjNAUsS8X85kACbQm27Fx58FK1xvVaiTxrBZWgqHz_amLHye4yYRFh0fdzx_3Er_ru8MquzADnVokpbf0k0oKvB0wcbYod2Vg-LltYelbTJKEpxSc_sebCuq1I9aVX9XPW8cHXBeg_bFvx-t02n1jV5jAtfZpZlB-ZVHiDg0WXDqpeT9frj8jkGTmG3VfTmqNXbh3AboqNxOC4ifdufV3SAYCJXXO5ZVZHvoC_3hNv9rKayOZGUiWNK_aMACrRAGR5gGS0owDO4G6cq6zxgVxKO_F-FQiNEe-noNW_pbGC-NAhsV0zrbTuNPkLHlVHIxD9yMlHqqEZnBiUKAQ",
  p: "2a7airKRaon5MOoH4fImue8c_0VTHfA6fRuGLlQyEIBLJHixvu9CFB4ddrpkHV9pTxt5lAIidB9SYskyOx4xwhGGolykFVlsCHKCoTsDQsaM1aUvX9jMDSDgMWNH7DVHV0MVE-YR2pQia5ykWwrW_ggbqbiz4pzfiug1JbLtRgE",
  q: "tnzTAzIhyTjoOftu8Hna-Y0GbDQ_6H-xv_LJZtTc-7nm69_4nqtVfu9FVuYsRgZhxkjldlW62OVeb6PnJcTviYIQcauzub6VDoGQrU_NJOXX26MA6nxXOvf1OS7KmKaZXA6TeRM3H9uXYE3y2h_Xfi6trPTT4Q3pFzZgmUHtE8M",
  dp: "cfR7K4h3X5KDBPw-zCV76HIod-nOrSmJNN0nzTD-VG0U6S7VveJ6cRWizvicWFQOSP9VEgpcBvYuptA0n4Ya_kE2feCJdTOuvm1TvRurhVVzfJRQzJgtmeHP-4rBqAHsKt5PNm-GgSpzKmqCD7cI_Us5UAwE_2ioDYup5uZYGAE",
  dq: "gWgfEuMYBmOuen-MekdPOywAY_bhYvQ6jk2S-LL2SiPYV2gqHAqPxEXUu_zZZIbeCwhif_nnWCu_PhfSsHvpCXAMTS9fcdZuSS0j9WLjrMi4u-3pll66VPzFDtnZnUp28kr71R4FNzg3LnnYP0nZPIfJbR7oqW1935IWClgv0JU",
  qi: "eJ3jlK6wm0xO71evQeXkHDitys1rvTzi6V0n5pGeSjc6WitqMDitgwNeTtVltB_7VB4tkclv0E8gC1qEDG5rhKhtYqfWd2vRTQLpLuOj8OryVFX6Vo4IkOtNS1Rn7cl8E0B5I-EVtivIfN2dtqekT2_OYNoMAO3MEKGN832TswU",
};

const jwks = {
  keys: [
    {
      kty: "RSA",
      kid: "github-actions-fixture-20260710",
      use: "sig",
      alg: "RS256",
      n: privateJwk.n,
      e: privateJwk.e,
      x5c: ["live-shaped-test-certificate"],
      x5t: "live-shaped-test-thumbprint",
      "x5t#S256": "live-shaped-test-sha256-thumbprint",
    },
  ],
};

const policy: GithubOidcTrustPolicy = {
  repositoryId: "123456789",
  workflowIdentity: {
    claimModel: "direct",
    workflowRef:
      "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
    allowedWorkflowShas: ["a".repeat(40)],
  },
  refs: ["refs/heads/main"],
  events: ["workflow_dispatch"],
  environments: ["vem-maintenance-testbed"],
  requireRefProtected: true,
  targetMachineCodes: ["VEM-TESTBED-RUNTIME-ACCEPTANCE"],
};

const directPolicy = policy;

const now = Math.floor(Date.parse("2026-07-10T12:00:00.000Z") / 1000);

function signedFixture(
  overrides: Record<string, unknown> = {},
  encodedHeader = base64Url({
    alg: "RS256",
    kid: jwks.keys[0].kid,
    typ: "JWT",
  }),
) {
  const payload = base64Url({
    iss: "https://token.actions.githubusercontent.com",
    aud: "vem-maintenance",
    repository_id: "123456789",
    workflow: "VM Runtime Acceptance",
    workflow_ref:
      "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
    workflow_sha: "a".repeat(40),
    ref: "refs/heads/main",
    ref_protected: true,
    event_name: "workflow_dispatch",
    sha: "a".repeat(40),
    run_id: "987654321",
    run_attempt: "3",
    environment: "vem-maintenance-testbed",
    jti: "fixture-jti-987654321-3",
    iat: now - 10,
    nbf: now - 10,
    exp: now + 290,
    ...overrides,
  });
  const signingInput = `${encodedHeader}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    createPrivateKey({ key: privateJwk, format: "jwk" }),
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("GitHub Actions OIDC validation", () => {
  it("rejects a correctly signed JWT whose base64url segments are not canonical", async () => {
    const canonicalHeader = base64Url({
      alg: "RS256",
      kid: jwks.keys[0].kid,
      typ: "JWT",
    });
    expect(canonicalHeader.endsWith("Q")).toBe(true);
    const nonCanonicalHeader = `${canonicalHeader.slice(0, -1)}R`;
    expect(Buffer.from(nonCanonicalHeader, "base64url")).toEqual(
      Buffer.from(canonicalHeader, "base64url"),
    );

    await expect(
      validateGithubActionsOidcToken(signedFixture({}, nonCanonicalHeader), {
        jwks,
        now,
        policy,
      }),
    ).rejects.toMatchObject(new GithubActionsOidcValidationError("malformed"));
  });

  it("accepts the immutable workflow_ref claims emitted by a direct workflow", async () => {
    await expect(
      validateGithubActionsOidcToken(
        signedFixture({
          job_workflow_ref: undefined,
          workflow_ref:
            "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
          workflow_sha: "a".repeat(40),
          ref_protected: "true",
        }),
        { jwks, now, policy: directPolicy },
      ),
    ).resolves.toMatchObject({
      claimModel: "direct",
      workflowRef:
        "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
      workflowSha: "a".repeat(40),
    });
  });

  it("uses job_workflow_ref only when policy explicitly selects the reusable claim model", async () => {
    const reusablePolicy: GithubOidcTrustPolicy = {
      ...policy,
      workflowIdentity: {
        claimModel: "reusable",
        workflowRef: "vem/vem/.github/workflows/caller.yml@refs/heads/main",
        jobWorkflowRef:
          "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
        allowedWorkflowShas: ["a".repeat(40)],
        allowedJobWorkflowShas: ["b".repeat(40)],
      },
    };

    await expect(
      validateGithubActionsOidcToken(
        signedFixture({
          workflow_ref: "vem/vem/.github/workflows/caller.yml@refs/heads/main",
          job_workflow_ref:
            "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
          job_workflow_sha: "b".repeat(40),
        }),
        { jwks, now, policy: reusablePolicy },
      ),
    ).resolves.toMatchObject({
      claimModel: "reusable",
      jobWorkflowSha: "b".repeat(40),
    });
  });

  it("verifies a representative signed GitHub JWT against its JWKS before trusting claims", async () => {
    await expect(
      validateGithubActionsOidcToken(signedFixture(), {
        jwks,
        now,
        policy,
      }),
    ).resolves.toMatchObject({
      repositoryId: "123456789",
      runId: "987654321",
      runAttempt: "3",
      sha: "a".repeat(40),
    });
  });

  it.each([
    [
      "tampered signature",
      () => {
        const parts = signedFixture().split(".");
        parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
        return parts.join(".");
      },
      "invalid_signature",
    ],
    [
      "wrong issuer",
      () => signedFixture({ iss: "https://example.invalid" }),
      "issuer",
    ],
    ["wrong audience", () => signedFixture({ aud: "other" }), "audience"],
    ["expired token", () => signedFixture({ exp: now - 1 }), "expired"],
    ["future token", () => signedFixture({ nbf: now + 61 }), "not_before"],
    [
      "wrong repository",
      () => signedFixture({ repository_id: "111" }),
      "repository",
    ],
    [
      "wrong workflow ref",
      () => signedFixture({ workflow_ref: "other" }),
      "workflow_ref",
    ],
    [
      "an old workflow SHA disallowed by policy",
      () =>
        signedFixture({
          sha: "b".repeat(40),
          workflow_sha: "b".repeat(40),
        }),
      "workflow_sha",
    ],
    [
      "a workflow SHA not bound to the run SHA",
      () => signedFixture({ workflow_sha: "b".repeat(40) }),
      "workflow_sha",
    ],
    [
      "an unprotected ref",
      () => signedFixture({ ref_protected: false }),
      "ref_protected",
    ],
    [
      "reusable-only claims under a direct policy",
      () =>
        signedFixture({
          job_workflow_ref:
            "vem/vem/.github/workflows/other.yml@refs/heads/main",
          job_workflow_sha: "b".repeat(40),
        }),
      "claim_model",
    ],
    ["wrong ref", () => signedFixture({ ref: "refs/heads/feature" }), "ref"],
    [
      "wrong event",
      () => signedFixture({ event_name: "pull_request" }),
      "event",
    ],
    ["invalid sha", () => signedFixture({ sha: "not-a-commit" }), "sha"],
    ["missing run id", () => signedFixture({ run_id: undefined }), "run_id"],
    [
      "untrusted environment",
      () => signedFixture({ environment: "production" }),
      "environment",
    ],
  ])(
    "rejects %s with a stable reason code",
    async (_label, token, reasonCode) => {
      await expect(
        validateGithubActionsOidcToken(token(), { jwks, now, policy }),
      ).rejects.toMatchObject(new GithubActionsOidcValidationError(reasonCode));
    },
  );
});
