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
  buildFunctionalAiAcceptanceGuestInput,
  canonicalAiAcceptanceInputManifest,
  containedCalibrationSourcePath,
  identicalAiAcceptanceInputSnapshot,
  materializeHostCalibrationSourceSnapshot,
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

test("builds a functional AI guest input without trusted pipeline prerequisites", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-functional-"));
  try {
    const runtime = file(
      root,
      "runtime/vision-runtime.zip",
      "runtime",
      "a".repeat(40),
    );
    const fixture = file(
      root,
      "fixture/recorded-fixtures.zip",
      "fixture",
      "a".repeat(40),
    );
    const modelPack = file(root, "model/model-pack.zip", "model");
    const materialized = directory(root, "model-materialized", [
      ["ai-model-manifest.json", "{}"],
    ]);
    const preparation = await buildFunctionalAiAcceptanceGuestInput({
      visionCoreArtifacts: {
        runtimeArchive: runtime,
        recordedFixtureArchive: fixture,
      },
      aiVirtualTryOnFunctional: {
        materializedModelPackRoot: materialized.hostPath,
        modelPackArchive: modelPack.hostPath,
        modelPackByteSize: modelPack.byteSize,
        modelPackSha256: modelPack.sha256,
      },
    });
    assert.equal(preparation.guestInput.functional, true);
    assert.equal(preparation.guestInput.phase, "measurement");
    assert.equal(preparation.guestInput.modelPackSha256, modelPack.sha256);
    assert.equal(
      preparation.guestInput.identities.materializedModelPackRoot.sha256,
      materialized.sha256,
    );
    assert.equal(preparation.transfers.length, 4);
    assert.equal("candidateInputDirectory" in preparation.guestInput, false);
    assert.equal("windowsProofInputDirectory" in preparation.guestInput, false);
    assert.equal("acceptanceAuthorityReceipt" in preparation.guestInput, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    proofCompanion: {
      archiveSha256: "b".repeat(64),
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
    visionCore: {
      recordedFixtureArchive: {
        format: "vending-vision-main-artifacts/v1",
        sha256: digest("fixture"),
        sourceCommit,
      },
      runtimeArchive: {
        format: "vending-vision-candidate-artifact/v3",
        sha256: candidateByName["candidate.zip"].sha256,
        sourceCommit,
      },
    },
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
      sourceCommit,
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
    assert.notEqual(
      value.recordedFixtureArchive.sha256,
      JSON.parse(
        readFileSync(value.acceptanceAuthorityReceipt.hostPath, "utf8"),
      ).proofCompanion.archiveSha256,
    );
    assert.equal("calibrationReceipt" in checked.guestInput, false);
    assert.equal(checked.transfers.length, 7);
    const retainedRoot = "D:\\runtime-cache\\v1\\acceptance-inputs";
    assert.equal(
      checked.guestInput.inputRoot,
      `${retainedRoot}\\manifests\\${checked.manifestSha256}`,
    );
    assert.equal(
      checked.guestInput.installedVisionRuntimeArchive,
      `${retainedRoot}\\files\\${value.installedVisionRuntimeArchive.sha256}\\vision-runtime.zip`,
    );
    assert.equal(
      checked.guestInput.candidateInputDirectory,
      `${retainedRoot}\\directories\\${value.candidateInput.sha256}`,
    );
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

test("contains Windows calibration source members with win32 semantics", () => {
  assert.equal(
    containedCalibrationSourcePath(
      "C:\\ProgramData\\VEM\\measurement-source",
      "C:\\ProgramData\\VEM\\measurement-source\\regional\\short\\one.json",
      "Windows measurement member",
    ),
    "C:\\ProgramData\\VEM\\measurement-source\\regional\\short\\one.json",
  );
  assert.throws(
    () =>
      containedCalibrationSourcePath(
        "C:\\ProgramData\\VEM\\measurement-source",
        "C:\\ProgramData\\VEM\\outside.json",
        "Windows measurement member",
      ),
    /remain inside/,
  );
});

test("rewrites a copied Windows measurement closure into host-calibratable paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-roundtrip-"));
  try {
    const source = calibrationSourceBundle(root);
    const inputPath = join(source.hostPath, "calibration-source-input.json");
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    const guestRoot = "C:\\ProgramData\\VEM\\testbed\\measurement";
    input.artifactRoot = guestRoot;
    for (const [key, name] of [
      ["acceptanceReport", "acceptance-report.json"],
      ["acceptanceAuthorityReceipt", "acceptance-authority-receipt.json"],
      ["releaseProof", "release-proof.json"],
      ["recoverySupport", "recovery-support.json"],
      ["evidenceManifest", "evidence-manifest.json"],
    ])
      input[key].path = `${guestRoot}\\${name}`;
    writeFileSync(inputPath, canonicalAiAcceptanceInputManifest(input));
    const manifestPath = join(source.hostPath, "evidence-manifest.json");
    writeFileSync(
      manifestPath,
      canonicalAiAcceptanceInputManifest({
        files: [
          {
            path: `${guestRoot}\\regional\\short\\short.json`,
            sha256: digest("{}\n"),
          },
          {
            path: `${guestRoot}\\regional\\long\\long.json`,
            sha256: digest("{}\n"),
          },
        ],
      }),
    );
    const snapshot = await materializeHostCalibrationSourceSnapshot(
      source.hostPath,
      join(root, "host-source"),
    );
    const rewritten = JSON.parse(readFileSync(snapshot.inputPath, "utf8"));
    assert.equal(rewritten.artifactRoot, snapshot.artifactRoot);
    assert.equal(
      rewritten.acceptanceReport.path.startsWith(snapshot.artifactRoot),
      true,
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(snapshot.artifactRoot, "evidence-manifest.json"),
          "utf8",
        ),
      ).files.every((entry) => entry.path.startsWith(snapshot.artifactRoot)),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
