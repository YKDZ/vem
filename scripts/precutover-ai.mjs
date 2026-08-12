#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { proveProductionRuntimeArtifacts } from "./precutover-runtime-artifacts.mjs";
import {
  verifyProductionWindowsPrecutoverProof,
  verifyWindowsPrecutoverProofForTest,
} from "./precutover-windows-proof.mjs";

const PATH_OPTIONS = new Set([
  "approved",
  "approval",
  "approval-attestation-bundle",
  "database-backup",
  "docker-binary",
  "gh-binary",
  "output",
  "python",
  "release-set",
  "release-set-input-directory",
  "repo-root",
  "vem-runtime-archive",
  "vision-candidate-input-directory",
  "vision-verifier-root",
  "windows-proof-input-directory",
]);

function fail(message) {
  throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(raw) {
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function writeExclusive(path, raw, revalidate) {
  const parent = dirname(path);
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(parent) !== parent
  ) {
    fail("AI final receipt parent is unsafe");
  }
  const temporary = `${path}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, raw, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    revalidate();
    linkSync(temporary, path);
    rmSync(temporary);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function withoutDigestPrefix(value) {
  return typeof value === "string" && value.startsWith("sha256:")
    ? value.slice(7)
    : value;
}

function crossBindWindowsProof(runtimeProof, windowsProof) {
  const releaseSet = runtimeProof.releaseSet;
  const runtime = runtimeProof.receipt;
  const proof = windowsProof.proof;
  const matches = [
    [
      proof.candidate.subjectSha256,
      releaseSet.vision.candidateSubjectSha256,
      "candidate subject",
    ],
    [
      proof.candidate.embeddedManifestSha256,
      releaseSet.vision.embeddedManifestSha256,
      "candidate manifest",
    ],
    [
      proof.candidate.sourceCommit,
      releaseSet.vision.sourceCommit,
      "candidate source",
    ],
    [
      proof.candidate.attestationBundleSha256,
      releaseSet.vision.attestationBundleSha256,
      "candidate attestation bundle",
    ],
    [
      proof.candidate.trustedBuilderEvidenceSha256,
      releaseSet.vision.trustedBuilderEvidenceSha256,
      "candidate trusted builder evidence",
    ],
    [
      proof.modelPack.archive.sha256,
      releaseSet.ai.modelPackArchive.sha256,
      "model archive",
    ],
    [
      proof.modelPack.archive.byteSize,
      releaseSet.ai.modelPackArchive.byteSize,
      "model archive size",
    ],
    [
      proof.modelPack.descriptorSha256,
      releaseSet.ai.modelDescriptorSha256,
      "model descriptor",
    ],
    [
      proof.resources.aiLockSha256,
      releaseSet.ai.requirementsLockSha256,
      "AI lock",
    ],
    [
      proof.resources.runtimeDescriptorSha256,
      releaseSet.ai.runtimeDescriptorSha256,
      "runtime descriptor",
    ],
    [
      proof.candidate.subjectSha256,
      runtime.vision.archive.sha256,
      "fresh runtime candidate",
    ],
    [
      proof.candidate.embeddedManifestSha256,
      runtime.vision.embeddedManifestSha256,
      "fresh runtime manifest",
    ],
    [
      proof.candidate.sourceCommit,
      runtime.vision.sourceCommit,
      "fresh runtime source",
    ],
    [
      proof.candidate.attestationBundleSha256,
      runtime.vision.attestationBundleSha256,
      "fresh runtime attestation bundle",
    ],
    [
      proof.candidate.trustedBuilderEvidenceSha256,
      runtime.vision.trustedBuilderEvidenceSha256,
      "fresh runtime trusted builder evidence",
    ],
    [
      proof.resources.aiLockSha256,
      runtime.vision.bindings.aiLock.sha256,
      "fresh runtime AI lock",
    ],
    [
      proof.modelPack.descriptorSha256,
      runtime.vision.bindings.modelPackDescriptor.sha256,
      "fresh runtime model descriptor",
    ],
    [
      proof.resources.runtimeDescriptorSha256,
      runtime.vision.bindings.runtimeDescriptor.sha256,
      "fresh runtime descriptor",
    ],
    [
      proof.resources.sourceDescriptorSha256,
      runtime.vision.bindings.sourceDescriptor.sha256,
      "fresh source descriptor",
    ],
    [
      proof.candidate.workerExecutableSha256,
      runtime.vision.bindings.workerExecutable.sha256,
      "fresh worker executable",
    ],
  ];
  for (const [actual, expected, label] of matches) {
    if (actual !== withoutDigestPrefix(expected)) {
      fail(`Windows proof ${label} does not match fresh Linux proof`);
    }
  }
}

async function finalize(options, dependencies) {
  for (const [key, value] of Object.entries(options)) {
    if (PATH_OPTIONS.has(key) && !isAbsolute(value))
      fail(`--${key} must be absolute`);
  }
  const privateRoot = mkdtempSync(
    join(tmpdir(), "vem-precutover-ai-finalize-"),
  );
  try {
    const runtimeProof = await dependencies.proveRuntimeArtifacts({
      ...options,
      output: join(privateRoot, "runtime-artifacts.json"),
    });
    if (
      runtimeProof?.aiMaterials !== undefined ||
      !runtimeProof?.receipt ||
      !runtimeProof?.releaseSet
    ) {
      fail("fresh Linux runtime proof must not export AI material bytes");
    }
    return dependencies.verifyWindowsProof(
      {
        ghBinaryPath: options["gh-binary"],
        inputDirectory: options["windows-proof-input-directory"],
        repoRoot: options["repo-root"],
        sourceRef: options["vision-source-ref"],
      },
      async (windowsProof, revalidateWindowsProof) => {
        crossBindWindowsProof(runtimeProof, windowsProof);
        const runtimeReceiptText = canonicalJson(runtimeProof.receipt);
        const receipt = {
          identityRoot: {
            approvedPrecutoverSha256:
              runtimeProof.receipt.identityRoot.approvedPrecutoverSha256,
            releaseApprovalSha256:
              runtimeProof.receipt.identityRoot.releaseApprovalSha256,
            releaseSetSha256:
              runtimeProof.receipt.identityRoot.releaseSetSha256,
            runtimeArtifactsReceiptSha256: sha256(runtimeReceiptText),
          },
          schemaVersion: "vem.precutover.ai.v2",
          trustStatus: "pending_final_aggregate_approval",
          windowsProof: {
            authorityDescriptorSha256: windowsProof.authority.descriptorSha256,
            candidate: {
              attestationBundleSha256:
                windowsProof.proof.candidate.attestationBundleSha256,
              trustedBuilderEvidenceSha256:
                windowsProof.proof.candidate.trustedBuilderEvidenceSha256,
            },
            companion: windowsProof.proof.companion,
            proofAttestationBundleSha256: windowsProof.files.bundle.sha256,
            signedProofSha256: windowsProof.files.proof.sha256,
            trustedProofEvidenceSha256: windowsProof.files.evidence.sha256,
            workflowSha: windowsProof.authority.workflowSha,
          },
        };
        writeExclusive(
          options.output,
          canonicalJson(receipt),
          revalidateWindowsProof,
        );
        return receipt;
      },
    );
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

export async function finalizePrecutoverAiForTest(options, dependencies) {
  if (process.env.NODE_ENV !== "test") {
    fail("test-only AI finalizer boundary requires NODE_ENV=test");
  }
  if (
    typeof dependencies?.proveRuntimeArtifacts !== "function" ||
    typeof dependencies?.verifyWindowsProofAttestation !== "function"
  ) {
    fail("test AI finalizer dependencies are incomplete");
  }
  return finalize(options, {
    proveRuntimeArtifacts: dependencies.proveRuntimeArtifacts,
    verifyWindowsProof: (input, consume) =>
      verifyWindowsPrecutoverProofForTest(
        input,
        dependencies.verifyWindowsProofAttestation,
        consume,
      ),
  });
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (command !== "finalize") {
    fail("usage: precutover-ai.mjs finalize [options]");
  }
  const required = [
    "approved",
    "approval",
    "approval-attestation-bundle",
    "approval-subject-sha256",
    "database-backup",
    "docker-binary",
    "expected-docker-byte-size",
    "expected-docker-sha256",
    "expected-docker-version",
    "gh-binary",
    "managed-media-origin",
    "managed-media-token",
    "output",
    "python",
    "release-set",
    "release-set-input-directory",
    "repo-root",
    "postgres-container",
    "postgres-user",
    "source-commit",
    "source-ref",
    "vem-runtime-archive",
    "vision-candidate-input-directory",
    "vision-source-ref",
    "vision-verifier-root",
    "windows-proof-input-directory",
  ];
  const options = { command };
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      fail("invalid CLI arguments");
    const key = flag.slice(2);
    if (!required.includes(key) || Object.hasOwn(options, key)) {
      fail(`unknown or duplicate option: ${flag}`);
    }
    options[key] = value;
  }
  for (const key of required) {
    if (!Object.hasOwn(options, key)) fail(`missing --${key}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await finalize(options, {
    proveRuntimeArtifacts: proveProductionRuntimeArtifacts,
    verifyWindowsProof: verifyProductionWindowsPrecutoverProof,
  });
  process.stdout.write("PRECUTOVER_AI_FINALIZE=PASS\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`PRECUTOVER_AI_FINALIZE=FAIL:${error.message}\n`);
    process.exitCode = 1;
  });
}
