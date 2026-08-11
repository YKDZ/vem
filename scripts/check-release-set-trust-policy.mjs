import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { verifyTrustedGhBinary } from "./trusted-gh-cli.mjs";

const TRUSTED_COMMIT = "54f30f648f07c8bf5bc639f4ca2ba8f5a3d85981";
const TRUSTED_REPOSITORY = "YKDZ/vem";
const TRUSTED_WORKFLOW = ".github/workflows/trusted-release-set-attester.yml";
const PINNED_GH_BINARY = "/usr/bin/gh";

export class TrustPolicyError extends Error {}

function requirePolicy(condition, message) {
  if (!condition) throw new TrustPolicyError(message);
}

export function assertNoUntrustedRunExpressions(source, label) {
  let workflow;
  try {
    workflow = YAML.parse(source);
  } catch {
    throw new TrustPolicyError(`${label}: invalid YAML`);
  }
  requirePolicy(
    workflow?.jobs && typeof workflow.jobs === "object",
    `${label}: jobs missing`,
  );
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job?.steps ?? []) {
      if (typeof step.run === "string" && step.run.includes("${{")) {
        throw new TrustPolicyError(`${label}: workflow expression in run`);
      }
    }
  }
}

function trustedGitBytes(repositoryRoot, path) {
  return execFileSync("git", ["show", `${TRUSTED_COMMIT}:${path}`], {
    cwd: repositoryRoot,
  });
}

export function checkReleaseSetTrustPolicy(repositoryRoot) {
  const root = resolve(repositoryRoot);
  execFileSync("git", ["merge-base", "--is-ancestor", TRUSTED_COMMIT, "HEAD"], {
    cwd: root,
  });
  const attesterPath = resolve(root, TRUSTED_WORKFLOW);
  const callerPath = resolve(root, ".github/workflows/approve-release-set.yml");
  const attesterSource = readFileSync(attesterPath, "utf8");
  const callerSource = readFileSync(callerPath, "utf8");
  assertNoUntrustedRunExpressions(attesterSource, "trusted attester");
  assertNoUntrustedRunExpressions(callerSource, "approval caller");
  requirePolicy(
    readFileSync(attesterPath).equals(trustedGitBytes(root, TRUSTED_WORKFLOW)),
    "trusted attester bytes changed",
  );
  for (const path of [
    "scripts/backend-deployment-validation.mjs",
    "scripts/materialize_trusted_gh.py",
    "scripts/precutover-receipts.mjs",
    "scripts/release-set.mjs",
    "scripts/release-set-approval.mjs",
    "trusted-gh-cli-linux-amd64.json",
  ]) {
    requirePolicy(
      trustedGitBytes(root, path).length > 0,
      `trusted file missing: ${path}`,
    );
  }
  const caller = YAML.parse(callerSource);
  const trustedJob = caller.jobs?.trusted_approval;
  requirePolicy(
    trustedJob?.uses ===
      `${TRUSTED_REPOSITORY}/${TRUSTED_WORKFLOW}@${TRUSTED_COMMIT}`,
    "caller does not literally pin trusted attester",
  );
  requirePolicy(
    JSON.stringify(Object.keys(trustedJob?.with ?? {}).sort()) ===
      JSON.stringify(["source_commit", "source_ref"]),
    "trusted attester caller input allowlist changed",
  );
  const approvalSource = readFileSync(
    resolve(root, "scripts/release-set-approval.mjs"),
    "utf8",
  );
  for (const fragment of [
    `"${TRUSTED_COMMIT}"`,
    "verifyTrustedGhBinary(ghBinaryPath)",
    "spawnSync(\n    ghBinaryPath",
    '"--signer-workflow"',
    '"--signer-digest"',
    '"--source-ref"',
    '"--source-digest"',
    '"--deny-self-hosted-runners"',
    '"--format=json"',
  ]) {
    requirePolicy(
      approvalSource.includes(fragment),
      `production verifier policy missing: ${fragment}`,
    );
  }
  requirePolicy(
    !approvalSource.includes('spawnSync(\n    "gh"'),
    "production verifier must not resolve gh through PATH",
  );
  verifyTrustedGhBinary(PINNED_GH_BINARY);
  const missingRoot = `/tmp/vem-release-set-policy-${process.pid}`;
  const parsed = spawnSync(
    PINNED_GH_BINARY,
    [
      "attestation",
      "verify",
      `${missingRoot}.json`,
      "--bundle",
      `${missingRoot}.sigstore.json`,
      "--repo",
      TRUSTED_REPOSITORY,
      "--signer-workflow",
      `${TRUSTED_REPOSITORY}/${TRUSTED_WORKFLOW}`,
      "--signer-digest",
      TRUSTED_COMMIT,
      "--source-ref",
      "refs/tags/v0.0.0-rc.0",
      "--source-digest",
      "0".repeat(40),
      "--deny-self-hosted-runners",
      "--format=json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    },
  );
  const parserOutput = `${parsed.stdout}${parsed.stderr}`.toLowerCase();
  requirePolicy(
    parsed.status !== 0,
    "missing attestation fixture unexpectedly verified",
  );
  requirePolicy(
    parserOutput.includes("failed to open local artifact") ||
      parserOutput.includes("no such file"),
    "gh attestation flags did not reach artifact verification",
  );
  requirePolicy(
    !parserOutput.includes("unknown flag") &&
      !parserOutput.includes("mutually exclusive"),
    "gh attestation flags are invalid",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    checkReleaseSetTrustPolicy(process.cwd());
    process.stdout.write("RELEASE_SET_TRUST_POLICY=PASS\n");
  } catch (error) {
    process.stderr.write(`RELEASE_SET_TRUST_POLICY=FAIL:${error.message}\n`);
    process.exitCode = 1;
  }
}
