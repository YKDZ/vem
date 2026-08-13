import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildMeasurementAiAcceptanceInputManifest,
  createFormalAiAcceptanceInputManifest,
  createMeasurementAiAcceptanceInputManifest,
} from "./ai-acceptance-input-manifest.mjs";
import {
  canonicalAiAcceptanceInputManifest,
  validateAiAcceptanceInputManifest,
} from "./ai-acceptance-input-provisioning.mjs";
import {
  AI_REGIONAL_EVIDENCE_POLICY,
  AI_REGIONAL_EVIDENCE_POLICY_SHA256,
} from "./ai-regional-evidence.mjs";
import { createAiRegionalMeasurement } from "./run-ai-regional-measurement.mjs";

const calibrationCli = join(
  dirname(fileURLToPath(import.meta.url)),
  "calibrate-ai-regional-evidence.mjs",
);
const contractBundleDigest = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../packages/shared/generated/vision-v2/manifest.json",
    ),
    "utf8",
  ),
).bundleDigest;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function put(root, name, content) {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function canonical(value) {
  const sort = (entry) =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, sort(entry[key])]),
          )
        : entry;
  return `${JSON.stringify(sort(value))}\n`;
}

function canonicalJson(value, { compact = false } = {}) {
  const sort = (entry) =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, sort(entry[key])]),
          )
        : entry;
  return compact
    ? `${JSON.stringify(sort(value))}\n`
    : `${JSON.stringify(sort(value), null, 2)}\n`;
}

function putJson(root, name, value, options) {
  return put(root, name, canonicalJson(value, options));
}

function inputs(root) {
  const sourceCommit = "a".repeat(40);
  const candidateInputDirectory = join(root, "candidate");
  const windowsProofInputDirectory = join(root, "proof");
  const materializedModelPackRoot = join(root, "models");
  mkdirSync(candidateInputDirectory);
  mkdirSync(windowsProofInputDirectory);
  mkdirSync(materializedModelPackRoot);
  const runtimeContent = "runtime";
  const manifestContent = "manifest";
  const candidateAttestation = "candidate-attestation";
  const candidateEvidence = "candidate-evidence";
  const proofContent = "proof";
  const proofAttestation = "proof-attestation";
  const proofEvidence = "proof-evidence";
  const runtime = put(candidateInputDirectory, "candidate.zip", runtimeContent);
  put(candidateInputDirectory, "candidate-manifest.json", manifestContent);
  put(
    candidateInputDirectory,
    "github-build-provenance.sigstore.json",
    candidateAttestation,
  );
  put(
    candidateInputDirectory,
    "trusted-builder-evidence.json",
    candidateEvidence,
  );
  put(windowsProofInputDirectory, "precutover-ai-proof.json", proofContent);
  put(
    windowsProofInputDirectory,
    "precutover-ai-proof.sigstore.json",
    proofAttestation,
  );
  put(
    windowsProofInputDirectory,
    "trusted-precutover-proof-evidence.json",
    proofEvidence,
  );
  put(materializedModelPackRoot, "weights/model.bin", "model");
  put(materializedModelPackRoot, "manifest.json", "model-manifest");
  const fixtureContent = "fixtures";
  const modelArchiveContent = "model-archive";
  const fixture = put(root, "fixtures.zip", fixtureContent);
  const modelArchive = put(root, "model-pack.zip", modelArchiveContent);
  const authority = put(
    root,
    "authority.json",
    canonical({
      candidate: {
        attestationBundleSha256: digest(candidateAttestation),
        embeddedManifestSha256: digest(manifestContent),
        sourceCommit,
        subjectSha256: digest(runtimeContent),
        trustedBuilderEvidenceSha256: digest(candidateEvidence),
      },
      contract: {
        bundleDigest: "b".repeat(64),
        manifestSha256: "c".repeat(64),
        protocol: "vem.vision.v2",
      },
      modelPack: {
        archive: {
          byteSize: Buffer.byteLength(modelArchiveContent),
          sha256: digest(modelArchiveContent),
        },
        descriptorSha256: "d".repeat(64),
        sourceRevision: "e".repeat(40),
      },
      proofCompanion: {
        archiveSha256: "f".repeat(64),
        descriptorSha256: "1".repeat(64),
        sourceCommit: "2".repeat(40),
      },
      resources: {
        aiLockSha256: "3".repeat(64),
        runtimeDescriptorSha256: "4".repeat(64),
        sourceDescriptorSha256: "5".repeat(64),
        workerExecutableSha256: "6".repeat(64),
      },
      schemaVersion: "vem.testbed.ai-acceptance-authority/v1",
      scope: "installed_windows_acceptance",
      trustStatus: "verified_for_acceptance",
      visionCore: {
        recordedFixtureArchive: {
          format: "vending-vision-main-artifacts/v1",
          sha256: digest(fixtureContent),
          sourceCommit,
        },
        runtimeArchive: {
          format: "vending-vision-candidate-artifact/v3",
          sha256: digest(runtimeContent),
          sourceCommit,
        },
      },
      windowsProof: {
        authorityDescriptorSha256: `sha256:${"7".repeat(64)}`,
        proofAttestationBundleSha256: digest(proofAttestation),
        signedProofSha256: digest(proofContent),
        trustedProofEvidenceSha256: digest(proofEvidence),
        workflowSha: "8".repeat(40),
      },
    }),
  );
  return {
    acceptanceAuthorityReceipt: authority,
    candidateInputDirectory,
    installedVisionRuntimeArchive: runtime,
    materializedModelPackRoot,
    modelPackArchive: modelArchive,
    recordedFixtureArchive: fixture,
    sourceCommit,
    windowsProofInputDirectory,
  };
}

function calibrationSource(root) {
  const bundle = join(root, "calibration-source");
  const documents = [
    ["acceptanceReport", "acceptance-report.json", "{}\n"],
    ["acceptanceAuthorityReceipt", "acceptance-authority-receipt.json", "{}\n"],
    ["releaseProof", "release-proof.json", "{}\n"],
    ["recoverySupport", "recovery-support.json", "{}\n"],
    ["evidenceManifest", "evidence-manifest.json", canonical({ files: [] })],
  ];
  const sidecars = [
    ["regional/long/attempt.json", "{}\n"],
    ["regional/short/attempt.json", "{}\n"],
  ];
  const references = Object.fromEntries(
    documents.map(([key, name, content]) => [
      key,
      { path: join(bundle, name), sha256: digest(content) },
    ]),
  );
  const input = canonicalAiAcceptanceInputManifest({
    ...references,
    artifactRoot: bundle,
    attempts: sidecars.map(([name, content], index) => ({
      attempt: { regionalEvidence: { path: name, sha256: digest(content) } },
      attemptSha256: String(index + 1).repeat(64),
      caseKey: index === 0 ? "long" : "short",
    })),
    schemaVersion: "vem-ai-regional-evidence-calibration-input/v2",
  });
  for (const [, name, content] of documents) put(bundle, name, content);
  for (const [name, content] of sidecars) put(bundle, name, content);
  put(bundle, "calibration-source-input.json", input);
  return bundle;
}

function formalIntegrationFixture(root) {
  const sourceCommit = "a".repeat(40);
  const candidateInputDirectory = join(root, "candidate");
  const windowsProofInputDirectory = join(root, "proof");
  const materializedModelPackRoot = join(root, "models");
  const artifactRoot = join(root, "recorded-artifacts");
  mkdirSync(candidateInputDirectory);
  mkdirSync(windowsProofInputDirectory);
  mkdirSync(materializedModelPackRoot);
  mkdirSync(artifactRoot);

  const runtime = put(candidateInputDirectory, "candidate.zip", "runtime");
  const candidateManifest = put(
    candidateInputDirectory,
    "candidate-manifest.json",
    "candidate-manifest",
  );
  const candidateAttestation = put(
    candidateInputDirectory,
    "github-build-provenance.sigstore.json",
    "candidate-attestation",
  );
  const candidateEvidence = put(
    candidateInputDirectory,
    "trusted-builder-evidence.json",
    "candidate-evidence",
  );
  const modelArchive = put(root, "model-pack.zip", "model-pack");
  put(materializedModelPackRoot, "manifest.json", "model-manifest");
  put(materializedModelPackRoot, "weights/model.bin", "model");
  const recordedFixtureArchive = put(root, "fixtures.zip", "fixtures");
  const proofAttestation = put(
    windowsProofInputDirectory,
    "precutover-ai-proof.sigstore.json",
    "proof-attestation",
  );
  const proofEvidence = put(
    windowsProofInputDirectory,
    "trusted-precutover-proof-evidence.json",
    "proof-evidence",
  );

  const release = {
    candidate: {
      attestationBundleSha256: digest(readFileSync(candidateAttestation)),
      embeddedManifestSha256: digest(readFileSync(candidateManifest)),
      sourceCommit,
      subjectSha256: digest(readFileSync(runtime)),
      trustedBuilderEvidenceSha256: digest(readFileSync(candidateEvidence)),
      workerExecutableSha256: "5".repeat(64),
      workerMode: "frozen-windows",
    },
    companion: {
      archiveSha256: "f".repeat(64),
      descriptorSha256: "1".repeat(64),
      sourceCommit: "2".repeat(40),
    },
    modelPack: {
      archive: {
        byteSize: readFileSync(modelArchive).byteLength,
        sha256: digest(readFileSync(modelArchive)),
      },
      descriptorSha256: "d".repeat(64),
      sourceRevision: "e".repeat(40),
    },
    probes: {},
    resources: {
      aiLockSha256: "3".repeat(64),
      runtimeDescriptorSha256: "4".repeat(64),
      sourceDescriptorSha256: "6".repeat(64),
    },
    schemaVersion: "vending-vision-precutover-proof/v2",
  };
  const releaseProof = putJson(
    windowsProofInputDirectory,
    "precutover-ai-proof.json",
    release,
    { compact: true },
  );
  const authority = putJson(
    root,
    "authority.json",
    {
      candidate: {
        attestationBundleSha256: release.candidate.attestationBundleSha256,
        embeddedManifestSha256: release.candidate.embeddedManifestSha256,
        sourceCommit,
        subjectSha256: release.candidate.subjectSha256,
        trustedBuilderEvidenceSha256:
          release.candidate.trustedBuilderEvidenceSha256,
      },
      contract: {
        bundleDigest: contractBundleDigest,
        manifestSha256: "c".repeat(64),
        protocol: "vem.vision.v2",
      },
      modelPack: release.modelPack,
      proofCompanion: release.companion,
      resources: {
        ...release.resources,
        workerExecutableSha256: release.candidate.workerExecutableSha256,
      },
      schemaVersion: "vem.testbed.ai-acceptance-authority/v1",
      scope: "installed_windows_acceptance",
      trustStatus: "verified_for_acceptance",
      visionCore: {
        recordedFixtureArchive: {
          format: "vending-vision-main-artifacts/v1",
          sha256: digest(readFileSync(recordedFixtureArchive)),
          sourceCommit,
        },
        runtimeArchive: {
          format: "vending-vision-candidate-artifact/v3",
          sha256: release.candidate.subjectSha256,
          sourceCommit,
        },
      },
      windowsProof: {
        authorityDescriptorSha256: `sha256:${"7".repeat(64)}`,
        proofAttestationBundleSha256: `sha256:${digest(readFileSync(proofAttestation))}`,
        signedProofSha256: `sha256:${digest(readFileSync(releaseProof))}`,
        trustedProofEvidenceSha256: `sha256:${digest(readFileSync(proofEvidence))}`,
        workflowSha: "b".repeat(40),
      },
    },
    { compact: true },
  );

  const attempts = ["short", "long"].map((caseKey, index) => {
    const attemptId = `0198f44e-21bd-7c62-8f52-b7c86cc2b00${index + 1}`;
    const sidecar = {
      attempt: {
        acquisitionSource: "direct_recorded_frame",
        decodedHeight: 32,
        decodedWidth: 40,
        garmentSha256: String(index + 3).repeat(64),
        inputSha256: String(index + 5).repeat(64),
        recordedFixtureSha256: String(index + 7).repeat(64),
        resultSha256: String(index + 9).repeat(64),
        sourceCamera: "front",
      },
      evaluator: {
        algorithm: AI_REGIONAL_EVIDENCE_POLICY.algorithm,
        atr: AI_REGIONAL_EVIDENCE_POLICY.atrEvaluator,
        lip: AI_REGIONAL_EVIDENCE_POLICY.lipEvaluator,
        pose: AI_REGIONAL_EVIDENCE_POLICY.poseEvaluator,
        sourceDescriptorSha256:
          AI_REGIONAL_EVIDENCE_POLICY.sourceDescriptorSha256,
      },
      kind: "regional-evidence",
      masks: {
        height: 32,
        protectedRegion: { encoding: "rle-row-major/v1", runs: [[1100, 100]] },
        upperBody: { encoding: "rle-row-major/v1", runs: [[0, 1024]] },
        width: 40,
      },
      measurements: {
        protectedRegion: {
          changedFractionBps: 0,
          changedPixels: 0,
          meanDelta: 0,
          sampledPixels: 100,
          verdict: "preserved",
        },
        upperBody: {
          changedFractionBps: index === 0 ? 7998 : 9003,
          changedPixels: index === 0 ? 819 : 922,
          meanDelta: index === 0 ? 40 : 50,
          sampledPixels: 1024,
          verdict: "changed",
        },
      },
      policy: {
        schemaVersion: AI_REGIONAL_EVIDENCE_POLICY.schemaVersion,
        sha256: AI_REGIONAL_EVIDENCE_POLICY_SHA256,
      },
      schemaVersion: "vem-ai-regional-evidence/v1",
      verdict: "passed",
    };
    const relative = `regional/${caseKey}/${attemptId}.regional-evidence.json`;
    const sidecarPath = putJson(artifactRoot, relative, sidecar, {
      compact: true,
    });
    const attempt = {
      attemptId,
      caseKey,
      garment: { sha256: sidecar.attempt.garmentSha256 },
      input: { sha256: sidecar.attempt.inputSha256 },
      regionalEvidence: {
        path: relative,
        schemaVersion: "vem-ai-regional-evidence-reference/v1",
        sha256: digest(readFileSync(sidecarPath)),
        verdict: "passed",
      },
      result: {
        decodedHeight: 32,
        decodedWidth: 40,
        sha256: sidecar.attempt.resultSha256,
      },
      template:
        caseKey === "short" ? "tshirt_short_sleeve" : "tshirt_long_sleeve",
    };
    return { attempt, caseKey };
  });
  const evidenceManifest = putJson(root, "evidence-manifest.json", {
    files: attempts.map(({ attempt }) => {
      const path = join(artifactRoot, attempt.regionalEvidence.path);
      return {
        byteLength: readFileSync(path).byteLength,
        kind: "supportingEvidence",
        path,
        sha256: attempt.regionalEvidence.sha256,
        track: "aiVirtualTryOn",
      };
    }),
  });
  const report = putJson(
    root,
    "acceptance-report.json",
    {
      attempts: attempts.map(({ attempt }) => attempt),
      error:
        "AI regional evidence policy awaits Issue10 two-garment calibration",
      execution: {
        identities: {
          aiRuntime: `sha256:${release.resources.runtimeDescriptorSha256}`,
          contract: `sha256:${contractBundleDigest}`,
          modelPack: `sha256:${release.modelPack.archive.sha256}`,
          runtime: `sha256:${release.candidate.subjectSha256}`,
        },
        noDirectWorker: true,
        protocol: "vem.vision.v2",
        recordedSources: ["front", "top"],
        source: "installed_machine_ui_cdp",
      },
      ok: false,
      postAi: {
        browseAvailable: true,
        ordinarySaleCompleted: true,
        saleAvailable: true,
      },
      schemaVersion: "vem-ai-virtual-try-on-acceptance/v2",
    },
    { compact: true },
  );
  const recovery = putJson(
    root,
    "recovery.json",
    {
      facts: {
        recovery: {
          aiReadinessDiagnostic: "ready",
          aiReady: true,
          modelPackSha256: release.modelPack.archive.sha256,
          runtimeDescriptorSha256: release.resources.runtimeDescriptorSha256,
          sourceCommit,
          workerExecutableSha256: release.candidate.workerExecutableSha256,
        },
      },
      kind: "installed-runtime",
      schemaVersion: "vem.testbed.ai-virtual-try-on-support.v1",
    },
    { compact: true },
  );

  const calibrationSourceInputDirectory = join(root, "calibration-source");
  createAiRegionalMeasurement({
    acceptanceAuthorityReceipt: authority,
    artifactRoot,
    evidenceManifest,
    out: join(root, "calibration-measurement.json"),
    recoverySupport: recovery,
    releaseProof,
    report,
    sourceRoot: calibrationSourceInputDirectory,
  });
  const calibratedRegionalPolicy = join(root, "calibration", "policy.json");
  const calibrationReceipt = join(root, "calibration", "receipt.json");
  const calibration = spawnSync(
    process.execPath,
    [
      calibrationCli,
      "--input",
      join(calibrationSourceInputDirectory, "calibration-source-input.json"),
      "--out-policy",
      calibratedRegionalPolicy,
      "--out-receipt",
      calibrationReceipt,
    ],
    { encoding: "utf8" },
  );
  assert.equal(calibration.status, 0, calibration.stderr);

  const measurementManifest = join(root, "out", "measurement.json");
  return {
    authority,
    calibratedRegionalPolicy,
    calibrationReceipt,
    calibrationSourceInputDirectory,
    measurementManifest,
    measurementOptions: {
      acceptanceAuthorityReceipt: authority,
      candidateInputDirectory,
      installedVisionRuntimeArchive: runtime,
      materializedModelPackRoot,
      modelPackArchive: modelArchive,
      outputPath: measurementManifest,
      recordedFixtureArchive,
      windowsProofInputDirectory,
    },
  };
}

test("builds measurement v4 identities from production host inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-manifest-"));
  try {
    const options = inputs(root);
    const manifest = await buildMeasurementAiAcceptanceInputManifest(options);

    assert.equal(manifest.schemaVersion, "vem-runtime-testbed-ai-input/v4");
    assert.equal(manifest.phase, "measurement");
    assert.deepEqual(manifest.modelPack.delivery, {
      kind: "host-local-cache",
    });
    assert.equal(
      manifest.installedVisionRuntimeArchive.sourceCommit,
      options.sourceCommit,
    );
    assert.equal(
      manifest.recordedFixtureArchive.sourceCommit,
      options.sourceCommit,
    );
    assert.equal(
      manifest.installedVisionRuntimeArchive.sha256,
      digest("runtime"),
    );
    assert.equal(manifest.modelPack.archive.sha256, digest("model-archive"));
    assert.deepEqual(
      manifest.candidateInput.members.map((entry) => entry.name),
      [
        "candidate-manifest.json",
        "candidate.zip",
        "github-build-provenance.sigstore.json",
        "trusted-builder-evidence.json",
      ],
    );
    assert.deepEqual(
      manifest.modelPack.materializedRoot.members.map((entry) => entry.name),
      ["manifest.json", "weights/model.bin"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates canonical measurement manifest once through the public writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-create-"));
  try {
    const outputPath = join(root, "out", "measurement.json");
    const options = { ...inputs(root), outputPath };
    await createMeasurementAiAcceptanceInputManifest(options);
    const raw = readFileSync(outputPath, "utf8");
    assert.equal(raw, canonicalAiAcceptanceInputManifest(JSON.parse(raw)));
    await assert.rejects(
      createMeasurementAiAcceptanceInputManifest(options),
      /EEXIST/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects uncalibrated formal descriptors before writing output", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-formal-manifest-"));
  try {
    const measurementPath = join(root, "out", "measurement.json");
    const measurementOptions = { ...inputs(root), outputPath: measurementPath };
    await createMeasurementAiAcceptanceInputManifest(measurementOptions);
    const calibratedRegionalPolicy = put(
      root,
      "calibration/calibrated-policy.json",
      "{}\n",
    );
    const calibrationReceipt = put(
      root,
      "calibration/calibration-receipt.json",
      "{}\n",
    );
    const outputPath = join(root, "out", "formal.json");

    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        measurementManifest: measurementPath,
        calibratedRegionalPolicy,
        calibrationReceipt,
        calibrationSourceInputDirectory: calibrationSource(root),
        outputPath,
      }),
      /AI regional evidence policy authority is invalid/,
    );
    assert.equal(readdirSync(join(root, "out")).includes("formal.json"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a non-measurement source, missing formal artifacts, and a non-exact-eight source", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-formal-reject-"));
  try {
    const measurementPath = join(root, "out", "measurement.json");
    await createMeasurementAiAcceptanceInputManifest({
      ...inputs(root),
      outputPath: measurementPath,
    });
    const source = calibrationSource(root);
    const policy = put(root, "calibration/policy.json", "{}\n");
    const receipt = put(root, "calibration/receipt.json", "{}\n");
    const common = {
      calibratedRegionalPolicy: policy,
      calibrationReceipt: receipt,
      calibrationSourceInputDirectory: source,
      measurementManifest: measurementPath,
    };
    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        ...common,
        calibratedRegionalPolicy: join(root, "missing-policy.json"),
        outputPath: join(root, "out", "missing-policy.json"),
      }),
      /calibrated regional policy is missing/,
    );
    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        ...common,
        calibrationReceipt: join(root, "missing-receipt.json"),
        outputPath: join(root, "out", "missing-receipt.json"),
      }),
      /calibration receipt is missing/,
    );
    put(source, "unexpected.json", "{}\n");
    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        ...common,
        outputPath: join(root, "out", "bad-source.json"),
      }),
      /exact-eight closure files/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for formal output overlap, symlink ancestors, and existing output", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-formal-output-"));
  try {
    const sourceInputs = inputs(root);
    const measurementPath = join(root, "out", "measurement.json");
    await createMeasurementAiAcceptanceInputManifest({
      ...sourceInputs,
      outputPath: measurementPath,
    });
    const source = calibrationSource(root);
    const common = {
      calibratedRegionalPolicy: put(root, "calibration/policy.json", "{}\n"),
      calibrationReceipt: put(root, "calibration/receipt.json", "{}\n"),
      calibrationSourceInputDirectory: source,
      measurementManifest: measurementPath,
    };
    for (const directory of [
      sourceInputs.candidateInputDirectory,
      sourceInputs.windowsProofInputDirectory,
      sourceInputs.materializedModelPackRoot,
      source,
    ])
      await assert.rejects(
        createFormalAiAcceptanceInputManifest({
          ...common,
          outputPath: join(directory, "nested", "formal.json"),
        }),
        /outside every formal input directory/,
      );
    const outputAlias = join(root, "output-alias");
    symlinkSync(sourceInputs.candidateInputDirectory, outputAlias);
    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        ...common,
        outputPath: join(outputAlias, "formal.json"),
      }),
      /symlink ancestor/,
    );
    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        ...common,
        outputPath: join(outputAlias, "formal.json"),
      }),
      /symlink ancestor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects measurement input directories with symlink ancestors", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-formal-input-alias-"));
  try {
    const sourceInputs = inputs(root);
    const alias = join(root, "input-alias");
    symlinkSync(root, alias);
    const measurementPath = join(root, "out", "measurement.json");
    await assert.rejects(
      createMeasurementAiAcceptanceInputManifest({
        ...sourceInputs,
        candidateInputDirectory: join(alias, "candidate"),
        outputPath: measurementPath,
      }),
      /candidate input directory must not have a symlink ancestor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a validated measurement whose recorded input is replaced by a symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-replaced-"));
  try {
    const source = inputs(root);
    const measurementPath = join(root, "out", "measurement.json");
    await createMeasurementAiAcceptanceInputManifest({
      ...source,
      outputPath: measurementPath,
    });
    const measurement = JSON.parse(readFileSync(measurementPath, "utf8"));
    const realCandidate = join(root, "candidate-real");
    mkdirSync(realCandidate);
    for (const name of readdirSync(source.candidateInputDirectory))
      writeFileSync(
        join(realCandidate, name),
        readFileSync(join(source.candidateInputDirectory, name)),
      );
    rmSync(source.candidateInputDirectory, { recursive: true });
    symlinkSync(realCandidate, source.candidateInputDirectory);
    writeFileSync(
      measurementPath,
      canonicalAiAcceptanceInputManifest(measurement),
    );
    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        calibratedRegionalPolicy: put(root, "policy.json", "{}\n"),
        calibrationReceipt: put(root, "receipt.json", "{}\n"),
        calibrationSourceInputDirectory: calibrationSource(root),
        measurementManifest: measurementPath,
        outputPath: join(root, "out", "formal.json"),
      }),
      /measurement manifest input must not have a symlink ancestor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects output inside every measured input directory before mutation", async () => {
  for (const key of [
    "candidateInputDirectory",
    "windowsProofInputDirectory",
    "materializedModelPackRoot",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-overlap-"));
    try {
      const options = inputs(root);
      const before = readdirSync(options[key], { recursive: true }).sort();
      await assert.rejects(
        createMeasurementAiAcceptanceInputManifest({
          ...options,
          outputPath: join(options[key], "nested", "measurement.json"),
        }),
        /output must remain outside candidate, proof, and model input directories/,
      );
      assert.deepEqual(
        readdirSync(options[key], { recursive: true }).sort(),
        before,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("creates and validates a formal manifest through production measurement and calibration CLIs", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-formal-integration-"));
  try {
    const fixture = formalIntegrationFixture(root);
    await createMeasurementAiAcceptanceInputManifest(
      fixture.measurementOptions,
    );
    const measurementRaw = readFileSync(fixture.measurementManifest, "utf8");
    const measurement = JSON.parse(measurementRaw);
    const outputPath = join(root, "out", "formal.json");

    await createFormalAiAcceptanceInputManifest({
      calibratedRegionalPolicy: fixture.calibratedRegionalPolicy,
      calibrationReceipt: fixture.calibrationReceipt,
      calibrationSourceInputDirectory: fixture.calibrationSourceInputDirectory,
      measurementManifest: fixture.measurementManifest,
      outputPath,
    });

    const raw = readFileSync(outputPath, "utf8");
    const formal = JSON.parse(raw);
    await validateAiAcceptanceInputManifest(raw);
    assert.equal(raw, canonicalAiAcceptanceInputManifest(formal));
    assert.equal(formal.phase, "formal");
    for (const descriptor of [
      "acceptanceAuthorityReceipt",
      "candidateInput",
      "installedVisionRuntimeArchive",
      "modelPack",
      "recordedFixtureArchive",
      "windowsProofInput",
    ])
      assert.deepEqual(formal[descriptor], measurement[descriptor]);
    assert.deepEqual(
      Object.keys(formal)
        .filter((key) => key.startsWith("calibrat"))
        .sort(),
      [
        "calibratedRegionalPolicy",
        "calibrationReceipt",
        "calibrationSourceInput",
      ],
    );
    assert.equal(formal.calibrationSourceInput.members.length, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a canonically reidentified calibration receipt from another release", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-formal-release-drift-"));
  try {
    const fixture = formalIntegrationFixture(root);
    await createMeasurementAiAcceptanceInputManifest(
      fixture.measurementOptions,
    );
    const receipt = JSON.parse(
      readFileSync(fixture.calibrationReceipt, "utf8"),
    );
    receipt.release.runtime = "0".repeat(64);
    writeFileSync(fixture.calibrationReceipt, canonicalJson(receipt));
    const outputPath = join(root, "out", "formal.json");

    await assert.rejects(
      createFormalAiAcceptanceInputManifest({
        calibratedRegionalPolicy: fixture.calibratedRegionalPolicy,
        calibrationReceipt: fixture.calibrationReceipt,
        calibrationSourceInputDirectory:
          fixture.calibrationSourceInputDirectory,
        measurementManifest: fixture.measurementManifest,
        outputPath,
      }),
      /not bound to this release/,
    );
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
