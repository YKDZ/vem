import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonicalAiAcceptanceInputManifest,
  identicalAiAcceptanceInputSnapshot,
  materializeAiAcceptanceInputSnapshot,
  validateAiAcceptanceInputManifest,
} from "./ai-acceptance-input-provisioning.mjs";
import { readCalibrationSourceClosure } from "./calibrate-ai-regional-evidence.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function file(root, name, content, sourceCommit) {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return {
    hostPath: path,
    sha256: digest(content),
    byteSize: Buffer.byteLength(content),
    ...(sourceCommit ? { sourceCommit } : {}),
  };
}

function directory(root, name, entries) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  const members = entries
    .map(([entry, content]) => {
      mkdirSync(join(path, entry, ".."), { recursive: true });
      writeFileSync(join(path, entry), content);
      return {
        name: entry,
        sha256: digest(content),
        byteSize: Buffer.byteLength(content),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    hostPath: path,
    members,
    byteSize: members.reduce((sum, member) => sum + member.byteSize, 0),
    sha256: digest(
      members
        .map(
          (member) => `${member.name}\0${member.sha256}\0${member.byteSize}\n`,
        )
        .join(""),
    ),
  };
}

function canonical(value) {
  return `${JSON.stringify(value, Object.keys(value).sort())}\n`;
}

function compactCanonical(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  return `${JSON.stringify(sort(value))}\n`;
}

function calibrationSourceBundle(root) {
  const bundleRoot = join(root, "calibration-source");
  const documents = [
    ["acceptanceReport", "acceptance-report.json", "{}\n"],
    ["acceptanceAuthorityReceipt", "acceptance-authority-receipt.json", "{}\n"],
    ["releaseProof", "release-proof.json", "{}\n"],
    ["recoverySupport", "recovery-support.json", "{}\n"],
    [
      "evidenceManifest",
      "evidence-manifest.json",
      compactCanonical({ files: [] }),
    ],
  ];
  const sidecars = [
    ["regional/short/short.json", "{}\n"],
    ["regional/long/long.json", "{}\n"],
  ];
  const references = Object.fromEntries(
    documents.map(([key, name, content]) => [
      key,
      { path: join(bundleRoot, name), sha256: digest(content) },
    ]),
  );
  const attempts = sidecars.map(([name, content], index) => ({
    attempt: {
      regionalEvidence: { path: name, sha256: digest(content) },
    },
    attemptSha256: String(index + 1).repeat(64),
    caseKey: index === 0 ? "short" : "long",
  }));
  const input = canonicalAiAcceptanceInputManifest({
    artifactRoot: bundleRoot,
    ...references,
    attempts,
    schemaVersion: "vem-ai-regional-evidence-calibration-input/v2",
  });
  return directory(root, "calibration-source", [
    ...documents.map(([, name, content]) => [name, content]),
    ...sidecars,
    ["calibration-source-input.json", input],
  ]);
}

function manifest(root, phase = "measurement") {
  const sourceCommit = "a".repeat(40);
  const candidate = directory(root, "candidate", [
    ["candidate.zip", "candidate"],
    ["candidate-manifest.json", "manifest"],
    ["github-build-provenance.sigstore.json", "attestation"],
    ["trusted-builder-evidence.json", "builder"],
  ]);
  const proof = directory(root, "proof", [
    ["precutover-ai-proof.json", "proof"],
    ["precutover-ai-proof.sigstore.json", "proof-attestation"],
    ["trusted-precutover-proof-evidence.json", "proof-evidence"],
  ]);
  const candidateByName = Object.fromEntries(
    candidate.members.map((member) => [member.name, member]),
  );
  const proofByName = Object.fromEntries(
    proof.members.map((member) => [member.name, member]),
  );
  const authorityValue = {
    candidate: {
      attestationBundleSha256:
        candidateByName["github-build-provenance.sigstore.json"].sha256,
      embeddedManifestSha256: candidateByName["candidate-manifest.json"].sha256,
      sourceCommit,
      subjectSha256: candidateByName["candidate.zip"].sha256,
      trustedBuilderEvidenceSha256:
        candidateByName["trusted-builder-evidence.json"].sha256,
    },
    companion: {
      archiveSha256: digest("fixture"),
      descriptorSha256: "c".repeat(64),
      sourceCommit: "d".repeat(40),
    },
    contract: {
      bundleDigest: "e".repeat(64),
      manifestSha256: "f".repeat(64),
      protocol: "vem.vision.v2",
    },
    modelPack: {
      archive: { byteSize: 10, sha256: digest("model-pack".padEnd(10, "x")) },
      descriptorSha256: "2".repeat(64),
      sourceRevision: "3".repeat(40),
    },
    resources: {
      aiLockSha256: "4".repeat(64),
      runtimeDescriptorSha256: "5".repeat(64),
      sourceDescriptorSha256: "6".repeat(64),
      workerExecutableSha256: "7".repeat(64),
    },
    schemaVersion: "vem.testbed.ai-acceptance-authority/v1",
    scope: "installed_windows_acceptance",
    trustStatus: "verified_for_acceptance",
    windowsProof: {
      authorityDescriptorSha256: `sha256:${"8".repeat(64)}`,
      proofAttestationBundleSha256:
        proofByName["precutover-ai-proof.sigstore.json"].sha256,
      signedProofSha256: proofByName["precutover-ai-proof.json"].sha256,
      trustedProofEvidenceSha256:
        proofByName["trusted-precutover-proof-evidence.json"].sha256,
      workflowSha: "9".repeat(40),
    },
  };
  const authority = file(
    root,
    "authority.json",
    compactCanonical(authorityValue),
  );
  const value = {
    acceptanceAuthorityReceipt: authority,
    candidateInput: candidate,
    installedVisionRuntimeArchive: {
      ...file(root, "vision-runtime.zip", "candidate"),
      sourceCommit,
    },
    modelPack: {
      archive: file(root, "model-pack.zip", "model-pack".padEnd(10, "x")),
      delivery: { kind: "host-local-cache" },
      materializedRoot: directory(root, "model-pack", [
        ["weights/model.bin", "weights"],
      ]),
    },
    phase,
    recordedFixtureArchive: {
      ...file(root, "recorded-fixtures.zip", "fixture"),
      sourceCommit: "d".repeat(40),
    },
    schemaVersion: "vem-runtime-testbed-ai-input/v4",
    windowsProofInput: proof,
  };
  if (phase === "formal") {
    value.calibratedRegionalPolicy = file(
      root,
      "calibrated-policy.json",
      "policy",
    );
    value.calibrationReceipt = file(
      root,
      "calibration-receipt.json",
      canonicalAiAcceptanceInputManifest({
        calibrationInputSha256: "0".repeat(64),
      }),
    );
    value.calibrationSourceInput = calibrationSourceBundle(root);
  }
  return value;
}

test("accepts a measurement v4 manifest without calibration and projects complete guest identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-input-v4-"));
  try {
    const value = manifest(root);
    const checked = await validateAiAcceptanceInputManifest(
      canonicalAiAcceptanceInputManifest(value),
    );
    assert.equal(checked.guestInput.phase, "measurement");
    assert.equal("calibrationReceipt" in checked.guestInput, false);
    assert.equal(checked.transfers.length, 7);
    const snapshot = await materializeAiAcceptanceInputSnapshot(
      checked,
      join(root, "snapshots"),
    );
    assert.equal(
      snapshot.transfers.every((transfer) =>
        transfer.hostPath.includes("snapshots"),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packages the formal source closure as the third exact-three member", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-input-formal-"));
  try {
    const value = manifest(root, "formal");
    const checked = await validateAiAcceptanceInputManifest(
      canonicalAiAcceptanceInputManifest(value),
    );
    assert.equal(checked.guestInput.phase, "formal");
    assert.equal(checked.transfers.length, 10);
    assert.equal(
      checked.guestInput.calibrationSourceInput.endsWith(
        "\\calibration-source",
      ),
      true,
    );
    assert.equal(
      checked.guestInput.identities.calibrationSourceInput.members.length,
      8,
    );
    const snapshot = await materializeAiAcceptanceInputSnapshot(
      checked,
      join(root, "snapshots"),
    );
    rmSync(value.calibrationSourceInput.hostPath, {
      recursive: true,
      force: true,
    });
    const bundleTransfer = snapshot.transfers.find(
      (transfer) =>
        transfer.guestPath === snapshot.guestInput.calibrationSourceInput,
    );
    assert.equal(bundleTransfer.members.length, 8);
    const rewritten = JSON.parse(
      readFileSync(
        join(bundleTransfer.hostPath, "calibration-source-input.json"),
        "utf8",
      ),
    );
    assert.equal(
      rewritten.artifactRoot,
      snapshot.guestInput.calibrationSourceInput,
    );
    assert.equal(
      rewritten.acceptanceReport.path.includes(
        value.calibrationSourceInput.hostPath,
      ),
      false,
    );
    const guestAssemblyInput = join(
      bundleTransfer.hostPath,
      "calibration-source-input.json",
    );
    const localGuestInput = JSON.parse(
      readFileSync(guestAssemblyInput, "utf8"),
    );
    localGuestInput.artifactRoot = bundleTransfer.hostPath;
    for (const [key, name] of [
      ["acceptanceReport", "acceptance-report.json"],
      ["acceptanceAuthorityReceipt", "acceptance-authority-receipt.json"],
      ["releaseProof", "release-proof.json"],
      ["recoverySupport", "recovery-support.json"],
      ["evidenceManifest", "evidence-manifest.json"],
    ])
      localGuestInput[key].path = join(bundleTransfer.hostPath, name);
    writeFileSync(
      guestAssemblyInput,
      canonicalAiAcceptanceInputManifest(localGuestInput),
    );
    assert.doesNotThrow(() => readCalibrationSourceClosure(guestAssemblyInput));
    delete value.calibrationReceipt;
    await assert.rejects(
      validateAiAcceptanceInputManifest(
        canonicalAiAcceptanceInputManifest(value),
      ),
      /root fields are invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects authority receipts outside installed Windows acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-input-authority-"));
  try {
    const value = manifest(root);
    const receipt = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(value.acceptanceAuthorityReceipt.hostPath, "utf8"),
    );
    receipt.scope = "release_set";
    writeFileSync(
      value.acceptanceAuthorityReceipt.hostPath,
      compactCanonical(receipt),
    );
    value.acceptanceAuthorityReceipt.sha256 = digest(compactCanonical(receipt));
    value.acceptanceAuthorityReceipt.byteSize = Buffer.byteLength(
      compactCanonical(receipt),
    );
    await assert.rejects(
      validateAiAcceptanceInputManifest(
        canonicalAiAcceptanceInputManifest(value),
      ),
      /scope or trust status is invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains full-pass drift detection", () => {
  const base = {
    manifestSha256: "1".repeat(64),
    artifactDigests: { candidateInput: { sha256: "2".repeat(64) } },
  };
  assert.equal(
    identicalAiAcceptanceInputSnapshot(base, structuredClone(base)),
    true,
  );
  assert.equal(
    identicalAiAcceptanceInputSnapshot(base, {
      ...base,
      artifactDigests: { candidateInput: { sha256: "3".repeat(64) } },
    }),
    false,
  );
});
