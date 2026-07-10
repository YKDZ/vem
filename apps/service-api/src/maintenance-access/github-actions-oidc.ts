import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";

const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_ACTIONS_AUDIENCE = "vem-maintenance";
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_TOKEN_LIFETIME_SECONDS = 600;
const gitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const refProtectedSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

const githubActionsOidcHeaderSchema = z.strictObject({
  alg: z.literal("RS256"),
  kid: z.string().min(1).max(256),
  typ: z.literal("JWT").optional(),
});

const githubActionsOidcClaimsSchema = z
  .object({
    iss: z.string().min(1).max(512),
    aud: z.string().min(1).max(512),
    repository_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    workflow: z.string().min(1).max(512),
    workflow_ref: z.string().min(1).max(1_024),
    workflow_sha: gitCommitShaSchema,
    job_workflow_ref: z.string().min(1).max(1_024).optional(),
    job_workflow_sha: gitCommitShaSchema.optional(),
    ref: z.string().min(1).max(512),
    ref_protected: refProtectedSchema,
    event_name: z.string().min(1).max(128),
    sha: gitCommitShaSchema,
    run_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    run_attempt: z.string().regex(/^[1-9][0-9]{0,9}$/),
    environment: z.string().min(1).max(255),
    jti: z.string().min(1).max(512),
    exp: z.number().int().positive(),
    iat: z.number().int().positive(),
    nbf: z.number().int().positive(),
  })
  .loose();

const githubOidcJwkSchema = z.strictObject({
  kty: z.literal("RSA"),
  kid: z.string().min(1).max(256),
  use: z.literal("sig").optional(),
  alg: z.literal("RS256").optional(),
  n: z.string().min(1),
  e: z.string().min(1),
  x5c: z.array(z.string().min(1)).min(1).max(4).optional(),
  x5t: z.string().min(1).optional(),
  "x5t#S256": z.string().min(1).optional(),
});

const githubOidcJwksSchema = z.strictObject({
  keys: z.array(githubOidcJwkSchema).min(1).max(32),
});

const allowedWorkflowShasSchema = z
  .array(gitCommitShaSchema)
  .min(1)
  .max(32)
  .optional();

const githubOidcWorkflowIdentitySchema = z.discriminatedUnion("claimModel", [
  z.strictObject({
    claimModel: z.literal("direct"),
    workflowRef: z.string().min(1).max(1_024),
    allowedWorkflowShas: allowedWorkflowShasSchema,
  }),
  z.strictObject({
    claimModel: z.literal("reusable"),
    workflowRef: z.string().min(1).max(1_024),
    jobWorkflowRef: z.string().min(1).max(1_024),
    allowedWorkflowShas: allowedWorkflowShasSchema,
    allowedJobWorkflowShas: allowedWorkflowShasSchema,
  }),
]);

const githubOidcTrustPolicySchema = z.strictObject({
  repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
  workflowIdentity: githubOidcWorkflowIdentitySchema,
  refs: z.array(z.string().min(1).max(512)).min(1).max(32),
  events: z.array(z.string().min(1).max(128)).min(1).max(16),
  environments: z.array(z.string().min(1).max(255)).min(1).max(16),
  requireRefProtected: z.boolean(),
  targetMachineCodes: z.array(z.string().min(1).max(64)).min(1).max(64),
});

export type GithubOidcTrustPolicy = z.infer<typeof githubOidcTrustPolicySchema>;

export function parseGithubOidcTrustPolicy(
  input: unknown,
): GithubOidcTrustPolicy {
  return githubOidcTrustPolicySchema.parse(parseJsonConfiguration(input));
}

export function parseGithubOidcJwks(input: unknown): unknown {
  return githubOidcJwksSchema.parse(parseJsonConfiguration(input));
}

export type VerifiedGithubActionsIdentity = {
  issuer: string;
  repositoryId: string;
  workflow: string;
  claimModel: "direct" | "reusable";
  workflowRef: string;
  workflowSha: string;
  jobWorkflowRef?: string;
  jobWorkflowSha?: string;
  ref: string;
  refProtected: boolean;
  eventName: string;
  sha: string;
  runId: string;
  runAttempt: string;
  environment: string;
  tokenId: string;
  issuedAt: Date;
  expiresAt: Date;
};

export class GithubActionsOidcValidationError extends Error {
  constructor(readonly reasonCode: string) {
    super(`GitHub OIDC token rejected: ${reasonCode}`);
  }
}

function parseJsonConfiguration(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("GitHub OIDC deployment configuration must be JSON");
  }
}

export async function validateGithubActionsOidcToken(
  token: string,
  options: {
    jwks: unknown;
    now?: number;
    policy: GithubOidcTrustPolicy;
  },
): Promise<VerifiedGithubActionsIdentity> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const policy = githubOidcTrustPolicySchema.safeParse(options.policy);
  if (!policy.success) throw new GithubActionsOidcValidationError("policy");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !isBase64Url(part))) {
    throw new GithubActionsOidcValidationError("malformed");
  }

  const header = parseJsonPart(
    parts[0],
    githubActionsOidcHeaderSchema,
    "header",
  );
  const jwks = githubOidcJwksSchema.safeParse(options.jwks);
  if (!jwks.success) throw new GithubActionsOidcValidationError("jwks");
  const jwk = jwks.data.keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new GithubActionsOidcValidationError("jwks_key");
  if (jwk.use && jwk.use !== "sig") {
    throw new GithubActionsOidcValidationError("jwks_key");
  }
  if (jwk.alg && jwk.alg !== "RS256") {
    throw new GithubActionsOidcValidationError("jwks_key");
  }

  const signature = Buffer.from(parts[2], "base64url");
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  let signatureValid = false;
  try {
    signatureValid = verify(
      "RSA-SHA256",
      signingInput,
      createPublicKey({ key: jwk, format: "jwk" }),
      signature,
    );
  } catch {
    throw new GithubActionsOidcValidationError("invalid_signature");
  }
  if (!signatureValid) {
    throw new GithubActionsOidcValidationError("invalid_signature");
  }

  const claims = parseGithubActionsClaims(parts[1]);
  if (claims.iss !== GITHUB_ACTIONS_ISSUER) {
    throw new GithubActionsOidcValidationError("issuer");
  }
  if (claims.aud !== GITHUB_ACTIONS_AUDIENCE) {
    throw new GithubActionsOidcValidationError("audience");
  }
  if (claims.exp <= now) {
    throw new GithubActionsOidcValidationError("expired");
  }
  if (claims.iat > now + CLOCK_TOLERANCE_SECONDS) {
    throw new GithubActionsOidcValidationError("issued_at");
  }
  if (claims.nbf > now + CLOCK_TOLERANCE_SECONDS) {
    throw new GithubActionsOidcValidationError("not_before");
  }
  if (
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS
  ) {
    throw new GithubActionsOidcValidationError("lifetime");
  }
  if (claims.repository_id !== policy.data.repositoryId) {
    throw new GithubActionsOidcValidationError("repository");
  }
  validateWorkflowIdentity(claims, policy.data.workflowIdentity);
  if (!policy.data.refs.includes(claims.ref)) {
    throw new GithubActionsOidcValidationError("ref");
  }
  if (policy.data.requireRefProtected && !claims.ref_protected) {
    throw new GithubActionsOidcValidationError("ref_protected");
  }
  if (!policy.data.events.includes(claims.event_name)) {
    throw new GithubActionsOidcValidationError("event");
  }
  if (!policy.data.environments.includes(claims.environment)) {
    throw new GithubActionsOidcValidationError("environment");
  }

  return {
    issuer: claims.iss,
    repositoryId: claims.repository_id,
    workflow: claims.workflow,
    claimModel: policy.data.workflowIdentity.claimModel,
    workflowRef: claims.workflow_ref,
    workflowSha: claims.workflow_sha,
    ...(claims.job_workflow_ref
      ? { jobWorkflowRef: claims.job_workflow_ref }
      : {}),
    ...(claims.job_workflow_sha
      ? { jobWorkflowSha: claims.job_workflow_sha }
      : {}),
    ref: claims.ref,
    refProtected: claims.ref_protected,
    eventName: claims.event_name,
    sha: claims.sha,
    runId: claims.run_id,
    runAttempt: claims.run_attempt,
    environment: claims.environment,
    tokenId: claims.jti,
    issuedAt: new Date(claims.iat * 1_000),
    expiresAt: new Date(claims.exp * 1_000),
  };
}

function validateWorkflowIdentity(
  claims: z.infer<typeof githubActionsOidcClaimsSchema>,
  policy: z.infer<typeof githubOidcWorkflowIdentitySchema>,
): void {
  if (claims.workflow_ref !== policy.workflowRef) {
    throw new GithubActionsOidcValidationError("workflow_ref");
  }
  if (claims.workflow_sha !== claims.sha) {
    throw new GithubActionsOidcValidationError("workflow_sha");
  }
  if (
    policy.allowedWorkflowShas &&
    !policy.allowedWorkflowShas.includes(claims.workflow_sha)
  ) {
    throw new GithubActionsOidcValidationError("workflow_sha");
  }
  if (policy.claimModel === "direct") {
    if (claims.job_workflow_ref || claims.job_workflow_sha) {
      throw new GithubActionsOidcValidationError("claim_model");
    }
    return;
  }
  if (claims.job_workflow_ref !== policy.jobWorkflowRef) {
    throw new GithubActionsOidcValidationError("job_workflow_ref");
  }
  if (!claims.job_workflow_sha) {
    throw new GithubActionsOidcValidationError("job_workflow_sha");
  }
  if (
    policy.allowedJobWorkflowShas &&
    !policy.allowedJobWorkflowShas.includes(claims.job_workflow_sha)
  ) {
    throw new GithubActionsOidcValidationError("job_workflow_sha");
  }
}

function isBase64Url(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function parseJsonPart<T extends z.ZodType>(
  part: string,
  schema: T,
  reasonCode: string,
): z.infer<T> {
  try {
    const parsed = schema.safeParse(
      JSON.parse(Buffer.from(part, "base64url").toString("utf8")),
    );
    if (!parsed.success) throw new Error("invalid schema");
    return parsed.data;
  } catch {
    throw new GithubActionsOidcValidationError(reasonCode);
  }
}

function parseGithubActionsClaims(part: string) {
  try {
    const raw = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    const parsed = githubActionsOidcClaimsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const field = parsed.error.issues[0]?.path[0];
    const reasonCode =
      typeof field === "string" &&
      [
        "repository_id",
        "workflow",
        "workflow_ref",
        "workflow_sha",
        "job_workflow_ref",
        "job_workflow_sha",
        "ref",
        "ref_protected",
        "event_name",
        "sha",
        "run_id",
        "run_attempt",
        "environment",
        "jti",
        "exp",
        "iat",
        "nbf",
      ].includes(field)
        ? field
        : "claims";
    throw new GithubActionsOidcValidationError(reasonCode);
  } catch (error) {
    if (error instanceof GithubActionsOidcValidationError) throw error;
    throw new GithubActionsOidcValidationError("claims");
  }
}
