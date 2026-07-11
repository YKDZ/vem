import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildFactoryMedia,
  createRedistributableFixtureIso,
  inspectBootableIso,
} from "./build-factory-media.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { canonicalJson, createFactoryManifest } from "./factory-manifest.mjs";
import { createSignedAssetEvidence } from "./verify-asset-evidence.mjs";
import {
  createVisionReleaseApproval,
  createVisionReleaseDescriptor,
} from "./vision-release.mjs";

const ISO_BUILDER_PATH = "/usr/bin/genisoimage";
const BUILDER_IMAGE_HASH = "f".repeat(64);
const EVIDENCE_BUILDER =
  "github-actions://vem/vem/.github/workflows/build.yml@refs/heads/main";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-media-"));
  const isoBuilderDigest = `sha256:${createHash("sha256")
    .update(await readFile(ISO_BUILDER_PATH))
    .digest("hex")}`;
  const isoBuilder = {
    identity: `tool://genisoimage@${isoBuilderDigest}`,
    digest: isoBuilderDigest,
    version: "1.1.11",
  };
  const sourceIsoPath = join(
    root,
    "redistributable-windows-boundary-fixture.iso",
  );
  const sourceFixture = await createRedistributableFixtureIso({
    isoBuilderPath: ISO_BUILDER_PATH,
    isoBuilder,
    outputPath: sourceIsoPath,
  });
  assert.deepEqual(sourceFixture.structure, {
    iso9660: true,
    udf: true,
    elTorito: true,
    bootable: true,
    bootCatalogSector: sourceFixture.structure.bootCatalogSector,
  });

  const bytesByRole = new Map([
    ["windows-source-iso", await readFile(sourceIsoPath)],
    ["openssh-installer", Buffer.from("openssh redistributable fixture\n")],
    ["wireguard-installer", Buffer.from("wireguard redistributable fixture\n")],
    ["vem-daemon", Buffer.from("daemon fixture\n")],
    ["vem-machine-ui", Buffer.from("machine UI fixture\n")],
    ["webview2-loader", Buffer.from("WebView2 loader fixture\n")],
    ["vision-release", Buffer.from("vision release fixture\n")],
  ]);
  const evidenceStoreRoot = join(root, "evidence");
  await mkdir(join(evidenceStoreRoot, "sha256"), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const definitions = [];
  for (const [role, bytes] of bytesByRole) {
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const signed = createSignedAssetEvidence({
      assetDigest: digest,
      privateKey,
      sourceIdentity: `git+https://github.com/vem/fixtures@${"1".repeat(40)}#${role}`,
      builderIdentity: EVIDENCE_BUILDER,
      buildId: "github-actions://vem/vem/actions/runs/42/attempts/1",
    });
    for (const evidence of signed.evidence) {
      await writeFile(
        join(evidenceStoreRoot, "sha256", evidence.digest.slice(7)),
        evidence.bytes,
      );
    }
    definitions.push({
      role,
      identity: `factory-cas://sha256/${digest.slice(7)}`,
      digest,
      version:
        role === "windows-source-iso"
          ? "10.0.19045"
          : role === "vision-release"
            ? "2026.7.11"
            : "1.0.0",
      signature: signed.signature,
      provenance: signed.provenance,
      ...(role === "vision-release"
        ? {
            release: {
              descriptorIdentity: signed.signature.evidenceIdentity,
              descriptorDigest: signed.signature.evidenceDigest,
              attestationIdentity: signed.signature.evidenceIdentity,
              attestationDigest: signed.signature.evidenceDigest,
              approvalIdentity: signed.signature.evidenceIdentity,
              approvalDigest: signed.signature.evidenceDigest,
              conformanceEvidenceIdentity: signed.signature.evidenceIdentity,
              conformanceEvidenceDigest: signed.signature.evidenceDigest,
            },
          }
        : {}),
      bytes,
    });
  }
  const builderImage = {
    identity: `oci://ghcr.io/vem/factory-builder@sha256:${BUILDER_IMAGE_HASH}`,
    digest: `sha256:${BUILDER_IMAGE_HASH}`,
    version: "1.0.0",
  };
  const visionAsset = definitions.find(({ role }) => role === "vision-release");
  const sbomBytes = Buffer.from('{"spdxVersion":"SPDX-2.3"}');
  const provenanceBytes = Buffer.from(
    '{"predicateType":"https://slsa.dev/provenance/v1"}',
  );
  const sha256 = (bytes) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const evidenceIdentity = (value) =>
    `factory-evidence://${value.replace(":", "/")}`;
  const descriptor = createVisionReleaseDescriptor({
    releaseVersion: "1.0.0",
    bundle: {
      digest: visionAsset.digest,
      bytes: visionAsset.bytes.length,
      platform: { os: "windows", architecture: "x86_64" },
      format: "zip",
      extractor: {
        contractVersion: "vem-vision-extractor/v1",
        handler: "zip-safe-v1",
      },
    },
    entrypoint: { command: "vision.exe", arguments: [] },
    lifecycle: { requiresInteractiveSession: true, shutdownTimeoutMs: 5000 },
    configuration: {
      format: "json",
      schemaVersion: "fixture/v1",
      argument: "--config",
    },
    health: {
      port: 7892,
      path: "/health",
      expectedStatus: 200,
      timeoutMs: 5000,
    },
    protocol: { version: "vem.vision.v1", webSocketPath: "/ws" },
    sbom: {
      identity: evidenceIdentity(sha256(sbomBytes)),
      digest: sha256(sbomBytes),
      format: "spdx-json",
    },
    provenance: {
      identity: evidenceIdentity(sha256(provenanceBytes)),
      digest: sha256(provenanceBytes),
      predicateType: "https://slsa.dev/provenance/v1",
    },
  });
  const descriptorBytes = Buffer.from(canonicalJson(descriptor));
  const attestation = {
    schemaVersion: "vem-vision-artifact-attestation/v1",
    kind: "vision-artifact-attestation",
    bundleDigest: descriptor.bundle.digest,
    descriptorDigest: descriptor.identity,
    sbomDigest: descriptor.sbom.digest,
    provenanceDigest: descriptor.provenance.digest,
    signerIdentity: `spki-sha256:${"a".repeat(64)}`,
  };
  const attestationBytes = Buffer.from(canonicalJson(attestation));
  const conformanceBytes = Buffer.from(
    canonicalJson({
      schemaVersion: "vem-vision-conformance/v1",
      kind: "vision-release-conformance",
      bundleDigest: descriptor.bundle.digest,
      descriptorDigest: descriptor.identity,
      protocolVersion: "vem.vision.v1",
    }),
  );
  const approval = createVisionReleaseApproval({
    releaseVersion: descriptor.releaseVersion,
    bundleDigest: descriptor.bundle.digest,
    descriptorDigest: descriptor.identity,
    attestationDigest: sha256(attestationBytes),
    conformanceEvidenceDigest: sha256(conformanceBytes),
    approverIdentity: "vem-release-approval:fixture",
  });
  const approvalBytes = Buffer.from(canonicalJson(approval));
  const documents = {
    descriptor: descriptorBytes,
    attestation: attestationBytes,
    sbom: sbomBytes,
    provenance: provenanceBytes,
    conformance: conformanceBytes,
    approval: approvalBytes,
  };
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const signerIdentity = `spki-sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
  const signatures = Object.fromEntries(
    Object.entries(documents).map(([role, bytes]) => [
      role,
      {
        signer: {
          identity: signerIdentity,
          publicKey: publicKeyDer.toString("base64"),
        },
        signature: sign(
          null,
          Buffer.from(canonicalJson({ role, digest: sha256(bytes) })),
          privateKey,
        ).toString("base64"),
      },
    ]),
  );
  visionAsset.version = descriptor.releaseVersion;
  visionAsset.release = {
    descriptorIdentity: evidenceIdentity(descriptor.identity),
    descriptorDigest: descriptor.identity,
    attestationIdentity: evidenceIdentity(sha256(attestationBytes)),
    attestationDigest: sha256(attestationBytes),
    approvalIdentity: evidenceIdentity(approval.identity),
    approvalDigest: approval.identity,
    conformanceEvidenceIdentity: evidenceIdentity(sha256(conformanceBytes)),
    conformanceEvidenceDigest: sha256(conformanceBytes),
  };
  const manifest = createFactoryManifest({
    schemaVersion: "vem-factory-manifest/v1",
    kind: "factory-manifest",
    profile: "testbed",
    source: {
      windowsMedia: (({ bytes, ...definition }) => definition)(definitions[0]),
    },
    assets: definitions.slice(1).map(({ bytes, ...definition }) => definition),
    toolchain: { builderImage, isoBuilder },
    outputPolicy: {
      isoFileName: "vem-factory-{manifestId}.iso",
      reproducible: true,
      includeProvenance: true,
      assemblyMode: "bootable-fixture-envelope",
    },
  });
  const sourcePaths = {};
  for (const definition of definitions) {
    const path =
      definition.role === "windows-source-iso"
        ? sourceIsoPath
        : join(root, `${definition.role}.asset`);
    if (definition.role !== "windows-source-iso")
      await writeFile(path, definition.bytes);
    sourcePaths[definition.identity] = path;
  }
  return {
    root,
    manifest,
    sourcePaths,
    evidenceStoreRoot,
    approvalPolicy: {
      signerIdentities: [definitions[0].signature.signerIdentity],
      builderIdentities: [EVIDENCE_BUILDER],
      authenticodeSignerIdentities: [],
    },
    visionReleaseDeliveryUnit: { documents, signatures },
    repositoryVisionTrustedRoots: Object.fromEntries(
      Object.keys(documents).map((role) => [role, [signerIdentity]]),
    ),
    factoryVisionTrustedRoots: Object.fromEntries(
      Object.keys(documents).map((role) => [role, [signerIdentity]]),
    ),
    visionEvidenceVerifierPath: "/usr/bin/true",
    builderImage,
  };
}

describe("real deterministic Factory ISO builder", () => {
  it("executes the pinned builder twice in independent directories and emits bootable ISO9660/UDF/El Torito media", async () => {
    const data = await fixture();
    try {
      const result = await buildFactoryMedia({
        manifest: data.manifest,
        store: new ContentAddressedAssetStore(join(data.root, "cas")),
        sourcePaths: data.sourcePaths,
        evidenceStoreRoot: data.evidenceStoreRoot,
        approvalPolicy: data.approvalPolicy,
        visionReleaseDeliveryUnit: data.visionReleaseDeliveryUnit,
        repositoryVisionTrustedRoots: data.repositoryVisionTrustedRoots,
        factoryVisionTrustedRoots: data.factoryVisionTrustedRoots,
        visionEvidenceVerifierPath: data.visionEvidenceVerifierPath,
        isoBuilderPath: ISO_BUILDER_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "output"),
        reproducibility: true,
      });

      assert.equal(result.reproducibility.builds, 2);
      assert.equal(result.reproducibility.independentDirectories, true);
      assert.equal(result.reproducibility.independentProcesses, true);
      assert.equal(result.reproducibility.identical, true);
      assert.deepEqual(
        inspectBootableIso(await readFile(result.output.path)),
        result.provenance.output.structure,
      );
      assert.equal(result.provenance.output.windowsInstallerCustomized, false);
      assert.equal(
        result.provenance.output.requiresIssue15CustomizationAssets,
        true,
      );
      assert.equal(result.provenance.toolchain.isoBuilder.executed, true);
      assert.equal(result.provenance.inputs.length, 7);
      assert.equal(
        result.provenance.inputs.every(
          (input) => input.signature.verified && input.provenance.verified,
        ),
        true,
      );
      assert.equal(
        JSON.stringify(result.provenance).includes(data.root),
        false,
      );
      assert.equal(result.provenance.evidence.cache.misses, 6);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a different executed builder image or ISO builder binary", async () => {
    const data = await fixture();
    try {
      const common = {
        manifest: data.manifest,
        store: new ContentAddressedAssetStore(join(data.root, "cas")),
        sourcePaths: data.sourcePaths,
        evidenceStoreRoot: data.evidenceStoreRoot,
        approvalPolicy: data.approvalPolicy,
        visionReleaseDeliveryUnit: data.visionReleaseDeliveryUnit,
        repositoryVisionTrustedRoots: data.repositoryVisionTrustedRoots,
        factoryVisionTrustedRoots: data.factoryVisionTrustedRoots,
        visionEvidenceVerifierPath: data.visionEvidenceVerifierPath,
        outputDirectory: join(data.root, "output"),
      };
      await assert.rejects(
        buildFactoryMedia({
          ...common,
          isoBuilderPath: ISO_BUILDER_PATH,
          executedBuilderImage: `oci://attacker@sha256:${BUILDER_IMAGE_HASH}`,
        }),
        /executed builder image/i,
      );
      const fakeBuilder = join(data.root, "fake-builder");
      await writeFile(fakeBuilder, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await assert.rejects(
        buildFactoryMedia({
          ...common,
          isoBuilderPath: fakeBuilder,
          executedBuilderImage: data.builderImage.identity,
        }),
        /ISO builder digest mismatch/i,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });
});
