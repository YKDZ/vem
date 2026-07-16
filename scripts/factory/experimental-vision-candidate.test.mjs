import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createPreapprovalDeliveryManifest,
  FACTORY_VISION_INSTALLER_FILES,
  manifestBuilderIdentity,
  manifestSourceIdentity,
  stageFactoryVisionInstaller,
  stagePreapprovalDeliveryUnit,
} from "./experimental-vision-candidate.mjs";
import { canonicalJson, createFactoryManifest } from "./factory-manifest.mjs";
import {
  verifyFactoryVisionDelivery,
  verifyPreapprovalDelivery,
} from "./verify-vision-delivery-assembly.mjs";
import {
  createVisionReleaseDescriptor,
  verifySignedVisionReleaseEvidence,
} from "./vision-release.mjs";

const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function writeSignedCandidate(root) {
  const bundle = Buffer.from("exact Candidate bundle for finalizer CLI");
  const sbom = Buffer.from('{"spdxVersion":"SPDX-2.3"}\n');
  const provenance = Buffer.from(
    canonicalJson({
      predicate: {
        buildDefinition: {
          resolvedDependencies: [
            {
              uri: `git+https://example.invalid/vision@${"a".repeat(40)}`,
            },
          ],
        },
        runDetails: {
          builder: { id: "https://github.com/actions/runner/windows" },
          metadata: { invocationId: "fixture-run-1" },
        },
      },
    }),
  );
  const descriptor = createVisionReleaseDescriptor({
    releaseVersion: "0.2.1-rc.8",
    bundle: {
      digest: digest(bundle),
      bytes: bundle.length,
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
      identity: `factory-evidence://${digest(sbom).replace(":", "/")}`,
      digest: digest(sbom),
      format: "spdx-json",
    },
    provenance: {
      identity: `factory-evidence://${digest(provenance).replace(":", "/")}`,
      digest: digest(provenance),
      predicateType: "https://slsa.dev/provenance/v1",
    },
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const supplierIdentity = `spki-sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
  const attestation = {
    schemaVersion: "vem-vision-artifact-attestation/v1",
    kind: "vision-artifact-attestation",
    bundleDigest: descriptor.bundle.digest,
    descriptorDigest: descriptor.identity,
    sbomDigest: descriptor.sbom.digest,
    provenanceDigest: descriptor.provenance.digest,
    signerIdentity: supplierIdentity,
  };
  const documents = {
    descriptor: Buffer.from(`${canonicalJson(descriptor)}\n`),
    attestation: Buffer.from(`${canonicalJson(attestation)}\n`),
    sbom,
    provenance,
  };
  for (const [role, bytes] of Object.entries(documents)) {
    const file = {
      descriptor: "vision-release-descriptor.json",
      attestation: "vision-artifact-attestation.json",
      sbom: "vision-sbom.spdx.json",
      provenance: "vision-provenance.json",
    }[role];
    const signature = {
      signer: {
        identity: supplierIdentity,
        publicKey: publicKeyDer.toString("base64"),
      },
      signature: sign(
        null,
        Buffer.from(canonicalJson({ role, digest: digest(bytes) })),
        privateKey,
      ).toString("base64"),
    };
    writeFileSync(join(root, file), bytes);
    writeFileSync(
      join(root, `${file}.sig.json`),
      `${canonicalJson(signature)}\n`,
    );
  }
  writeFileSync(
    join(root, "vending-vision-0.2.1-rc.1-windows-x86_64.zip"),
    bundle,
  );
  return { bundle, descriptor, supplierIdentity };
}

function writeBaseFactoryManifest(path) {
  const hash = "a".repeat(64);
  const asset = (role, version = "1.0.0") => ({
    role,
    mediaFileName: `${role}.bin`,
    identity: `factory-cas://sha256/${hash}`,
    digest: `sha256:${hash}`,
    version,
    signature: {
      scheme: "detached-ed25519",
      signerIdentity: `spki-sha256:${hash}`,
      evidenceIdentity: `factory-evidence://sha256/${hash}`,
      evidenceDigest: `sha256:${hash}`,
    },
    provenance: {
      predicateType: "https://slsa.dev/provenance/v1",
      sourceIdentity: `source:${role}`,
      builderIdentity: "builder:fixture",
      buildId: "fixture-build-1",
      signerIdentity: `spki-sha256:${hash}`,
      evidenceIdentity: `factory-evidence://sha256/${hash}`,
      evidenceDigest: `sha256:${hash}`,
    },
    ...(role === "vision-release"
      ? {
          release: {
            descriptorIdentity: `factory-evidence://sha256/${hash}`,
            descriptorDigest: `sha256:${hash}`,
            attestationIdentity: `factory-evidence://sha256/${hash}`,
            attestationDigest: `sha256:${hash}`,
            approvalIdentity: `factory-evidence://sha256/${hash}`,
            approvalDigest: `sha256:${hash}`,
            conformanceEvidenceIdentity: `factory-evidence://sha256/${hash}`,
            conformanceEvidenceDigest: `sha256:${hash}`,
          },
        }
      : {}),
  });
  const manifest = createFactoryManifest({
    schemaVersion: "vem-factory-manifest/v1",
    kind: "factory-manifest",
    profile: "testbed",
    source: {
      windowsMedia: asset("windows-source-iso", "10.0.19045"),
      installImageIndex: 1,
      installImageEdition: "Professional",
      installImageDigest: `sha256:${hash}`,
      targetFirmware: "uefi",
    },
    factoryPreparation: {
      schemaVersion: "vem-factory-preparation/v1",
      kind: "factory-preparation",
      environmentName: "fixture",
      deploymentBatch: "fixture-batch",
      provisioningEndpoint: "http://platform.invalid/api",
      mqttUrl: "mqtt://platform.invalid:1883",
      hardware: {
        mode: "simulated",
        model: "fixture",
        topologyIdentity: "topology:fixture",
        topologyVersion: "1",
      },
      display: { width: 1080, height: 1920, orientation: "portrait" },
      accounts: {
        kioskUser: "VEMKiosk",
        maintenanceUser: "YKDZ",
        autoLogonUser: "VEMKiosk",
      },
      expectedKioskShell: "C:\\VEM\\bringup\\machine.exe",
      targetLayoutVersion: "vem-runtime/v1",
      maintenance: {
        wireGuardInterfaceAlias: "VEM-Maintenance",
        wireGuardListenAddress: "10.0.0.2/32",
        runnerSourceAllowlist: ["10.77.20.2/32"],
        maintainerSourceAllowlist: ["fd00:77:20::3/128"],
        openSsh: {
          version: "9.8.1",
          approvedSignerThumbprint: "A".repeat(40),
          approvedRootThumbprint: "B".repeat(40),
        },
        wireGuard: {
          version: "0.5.3",
          approvedSignerThumbprint: "C".repeat(40),
          approvedRootThumbprint: "D".repeat(40),
        },
      },
    },
    assets: [
      "openssh-installer",
      "wireguard-installer",
      "vem-daemon",
      "vem-machine-ui",
      "webview2-loader",
      "vision-release",
      "vision-configuration",
      "maintenance-ssh-ca-public-key",
    ].map((role) => asset(role)),
    toolchain: {
      builderImage: {
        identity: `oci://builder@sha256:${hash}`,
        digest: `sha256:${hash}`,
        version: "1.0.0",
      },
      udfExtractor: {
        identity: `tool://7z@sha256:${hash}`,
        digest: `sha256:${hash}`,
        version: "1.0.0",
      },
      udfWriter: {
        identity: `tool://genisoimage@sha256:${hash}`,
        digest: `sha256:${hash}`,
        version: "1.0.0",
      },
      wimlib: {
        identity: `tool://wimlib@sha256:${hash}`,
        digest: `sha256:${hash}`,
        version: "1.0.0",
      },
    },
    outputPolicy: {
      isoFileName: "vem-factory-{manifestId}.iso",
      reproducible: true,
      includeProvenance: true,
      assemblyMode: "windows-serviced-iso",
    },
  });
  writeFileSync(path, `${canonicalJson(manifest)}\n`);
}

describe("experimental Vision preapproval delivery", () => {
  it("normalizes only immutable credential-free provenance identities", () => {
    const commit = "a".repeat(40);
    assert.equal(
      manifestSourceIdentity(
        `git+https://github.com/hbhjt/vending-vision@${commit}`,
      ),
      `git-commit:github.com/hbhjt/vending-vision@${commit}`,
    );
    assert.equal(
      manifestBuilderIdentity("https://github.com/actions/runner/windows"),
      "builder-uri-sha256:79bf7ae0eb73b778188a967d2bf120bf6187afce6c156ccfa575b89e9fe94d39",
    );
    for (const source of [
      "git+https://github.com/hbhjt/vending-vision@main",
      `git+https://github.com/hbhjt/vending-vision@${commit}?mutable=true`,
      `git+https://github.com/hbhjt/vending-vision@${commit}#fragment`,
      ` git+https://github.com/hbhjt/vending-vision@${commit}`,
      `git+https://user@example.invalid/vision@${commit}`,
      `git+https://example.invalid:443/vision@${commit}`,
      `git+ssh://example.invalid/vision@${commit}`,
    ]) {
      assert.throws(() => manifestSourceIdentity(source), /provenance source/i);
    }
    for (const builder of [
      " git+https://example.invalid/builder",
      "git+https://user@example.invalid/builder",
      "https://example.invalid/builder?mutable=true",
      "https://example.invalid:443/builder",
      "https://example.invalid/builder#fragment",
      "git+ssh://example.invalid/builder",
      "git+ssh:example.invalid/builder",
    ]) {
      assert.throws(
        () => manifestBuilderIdentity(builder),
        /provenance builder/i,
      );
    }
  });

  it("stages every finalizer script through the actual Factory producer", () => {
    const staged = new Map();
    stageFactoryVisionInstaller((relative, bytes) =>
      staged.set(relative, bytes),
    );
    assert.deepEqual(FACTORY_VISION_INSTALLER_FILES, [
      "install-vision-release.ps1",
      "provision-vision-factory-release.ps1",
      "vision-release-materialization.psm1",
      "vision-diagnostic-redaction.psm1",
    ]);
    assert.deepEqual([...staged.keys()].sort(), [
      "VISION-INSTALLER/install-vision-release.ps1",
      "VISION-INSTALLER/provision-vision-factory-release.ps1",
      "VISION-INSTALLER/vision-diagnostic-redaction.psm1",
      "VISION-INSTALLER/vision-release-materialization.psm1",
    ]);
    for (const [relative, bytes] of staged) {
      assert.equal(
        digest(bytes),
        digest(readFileSync(`scripts/windows/${relative.split("/").at(-1)}`)),
      );
    }
  });

  it("writes a self-contained, byte-pinned preapproval producer output", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-preapproval-"));
    try {
      const bundle = Buffer.from("candidate bundle");
      const descriptor = Buffer.from('{"descriptor":true}\n');
      const result = stagePreapprovalDeliveryUnit({
        outputDirectory: root,
        candidate: { bundle, documents: { descriptor } },
        verified: { bundleDigest: digest(bundle) },
      });
      const manifest = JSON.parse(
        readFileSync(join(result.root, "preapproval-manifest.json"), "utf8"),
      );
      assert.deepEqual(Object.keys(manifest.files).sort(), [
        "bundle.bin",
        "test-vision-candidate.ps1",
        "vision-diagnostic-redaction.psm1",
        "vision-release-descriptor.json",
        "vision-release-materialization.psm1",
      ]);
      for (const [name, expected] of Object.entries(manifest.files)) {
        assert.equal(digest(readFileSync(join(result.root, name))), expected);
      }
      const evidence = verifyPreapprovalDelivery(result.root);
      assert.deepEqual(
        Object.keys(evidence.files).sort(),
        Object.keys(manifest.files).sort(),
      );
      writeFileSync(
        join(result.root, "vision-diagnostic-redaction.psm1"),
        "tampered",
      );
      assert.throws(
        () => verifyPreapprovalDelivery(result.root),
        /digest does not bind its staged bytes/,
      );
      assert.equal(existsSync(join(result.root, "SHA256SUMS")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes the exact candidate and every executed script hash-addressable", () => {
    const bundle = Buffer.from("exact candidate bundle");
    const descriptor = Buffer.from('{"descriptor":true}\n');
    const manifest = createPreapprovalDeliveryManifest({
      bundle,
      descriptor,
      expectedBundleDigest: digest(bundle),
      testEntry: Buffer.from("candidate entry"),
      materializer: Buffer.from("materializer"),
      redactor: Buffer.from("redactor"),
    });

    assert.equal(manifest.expectedDigest, digest(bundle));
    assert.equal(manifest.descriptorDigest, digest(descriptor));
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      "bundle.bin",
      "test-vision-candidate.ps1",
      "vision-diagnostic-redaction.psm1",
      "vision-release-descriptor.json",
      "vision-release-materialization.psm1",
    ]);
    const { identity, ...unsigned } = manifest;
    assert.equal(identity, digest(Buffer.from(`${canonicalJson(unsigned)}\n`)));
  });

  it("does not produce a delivery manifest for a mismatched ExpectedDigest", () => {
    assert.throws(
      () =>
        createPreapprovalDeliveryManifest({
          bundle: Buffer.from("candidate"),
          descriptor: Buffer.from("descriptor"),
          expectedBundleDigest: `sha256:${"0".repeat(64)}`,
          testEntry: Buffer.from("entry"),
          materializer: Buffer.from("materializer"),
          redactor: Buffer.from("redactor"),
        }),
      /ExpectedDigest/,
    );
  });

  it("runs the preapproval and finalizer CLIs before independently byte-verifying their produced delivery units", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-experimental-cli-"));
    try {
      const candidateRoot = join(root, "candidate");
      const preapprovalRoot = join(root, "preapproval");
      const finalizerRoot = join(root, "finalizer");
      mkdirSync(candidateRoot, { recursive: true });
      const candidate = writeSignedCandidate(candidateRoot);
      const commonArgs = [
        "--candidate-dir",
        candidateRoot,
        "--tag",
        "v0.2.1-rc.8",
        "--expected-bundle-digest",
        digest(candidate.bundle),
        "--expected-supplier-identity",
        candidate.supplierIdentity,
      ];
      const preapproval = spawnSync(
        process.execPath,
        [
          "scripts/factory/experimental-vision-candidate.mjs",
          "prepare-preapproval",
          ...commonArgs,
          "--output",
          preapprovalRoot,
        ],
        { encoding: "utf8" },
      );
      assert.equal(preapproval.status, 0, preapproval.stderr);
      const stagedPreapproval = join(preapprovalRoot, "VEM-VISION-PREAPPROVAL");
      verifyPreapprovalDelivery(stagedPreapproval);
      const preapprovalProof = spawnSync(
        process.execPath,
        [
          "scripts/factory/verify-vision-delivery-assembly.mjs",
          "--kind",
          "preapproval",
          "--root",
          stagedPreapproval,
        ],
        { encoding: "utf8" },
      );
      assert.equal(preapprovalProof.status, 0, preapprovalProof.stderr);
      assert.equal(
        JSON.parse(preapprovalProof.stdout).kind,
        "vision-preapproval-delivery-assembly",
      );

      const conformancePath = join(root, "conformance.json");
      writeFileSync(
        conformancePath,
        `${canonicalJson({
          schemaVersion: "vem-vision-conformance/v1",
          kind: "vision-release-conformance",
          bundleDigest: digest(candidate.bundle),
          descriptorDigest: candidate.descriptor.identity,
          protocolVersion: "vem.vision.v1",
        })}\n`,
      );
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const acceptanceKey = join(root, "acceptance.pem");
      writeFileSync(
        acceptanceKey,
        privateKey.export({ type: "pkcs8", format: "pem" }),
      );
      const acceptanceIdentity = `spki-sha256:${createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex")}`;
      const verifierPath = join(root, "verifier.bin");
      const baseManifestPath = join(root, "factory-manifest.json");
      writeFileSync(verifierPath, "fixture verifier bytes");
      writeBaseFactoryManifest(baseManifestPath);
      const finalizer = spawnSync(
        process.execPath,
        [
          "scripts/factory/experimental-vision-candidate.mjs",
          "finalize",
          ...commonArgs,
          "--conformance",
          conformancePath,
          "--acceptance-private-key",
          acceptanceKey,
          "--expected-acceptance-identity",
          acceptanceIdentity,
          "--verifier",
          verifierPath,
          "--base-manifest",
          baseManifestPath,
          "--output",
          finalizerRoot,
        ],
        { encoding: "utf8" },
      );
      assert.equal(finalizer.status, 0, finalizer.stderr);
      const stagedFactory = join(finalizerRoot, "VEM");
      const finalizedManifest = JSON.parse(
        readFileSync(
          join(stagedFactory, "VISION-RELEASE", "factory-manifest.json"),
          "utf8",
        ),
      );
      const finalizedVision = finalizedManifest.assets.find(
        (asset) => asset.role === "vision-release",
      );
      const finalizedApprovalBytes = readFileSync(
        join(stagedFactory, "VISION-RELEASE", "approval.json"),
      );
      const finalizedDescriptorBytes = readFileSync(
        join(stagedFactory, "VISION-RELEASE", "descriptor.json"),
      );
      assert.equal(
        finalizedVision.release.descriptorDigest,
        digest(finalizedDescriptorBytes),
      );
      assert.equal(
        finalizedVision.release.descriptorIdentity,
        `factory-evidence://${digest(finalizedDescriptorBytes).replace(":", "/")}`,
      );
      assert.equal(
        finalizedVision.release.approvalDigest,
        digest(finalizedApprovalBytes),
      );
      assert.equal(
        finalizedVision.release.approvalIdentity,
        `factory-evidence://${digest(finalizedApprovalBytes).replace(":", "/")}`,
      );
      assert.equal(
        finalizedVision.provenance.sourceIdentity,
        `git-commit:example.invalid/vision@${"a".repeat(40)}`,
      );
      assert.match(
        finalizedVision.provenance.builderIdentity,
        /^builder-uri-sha256:[a-f0-9]{64}$/,
      );
      const delivery = JSON.parse(
        readFileSync(join(finalizerRoot, "delivery-unit.json"), "utf8"),
      );
      const documents = Object.fromEntries(
        Object.entries(delivery.documents).map(([role, value]) => [
          role,
          Buffer.from(value, "base64"),
        ]),
      );
      verifySignedVisionReleaseEvidence({
        manifestAsset: {
          role: finalizedVision.role,
          digest: finalizedVision.digest,
          version: finalizedVision.version,
          release: finalizedVision.release,
        },
        documents,
        signatures: delivery.signatures,
        approvedIdentities: {
          descriptor: [candidate.supplierIdentity],
          attestation: [candidate.supplierIdentity],
          sbom: [candidate.supplierIdentity],
          provenance: [candidate.supplierIdentity],
          conformance: [acceptanceIdentity],
          approval: [acceptanceIdentity],
        },
      });
      const contentDescriptorIdentity = JSON.parse(
        finalizedDescriptorBytes.toString("utf8"),
      ).identity;
      assert.notEqual(
        contentDescriptorIdentity,
        finalizedVision.release.descriptorDigest,
      );
      assert.throws(
        () =>
          verifySignedVisionReleaseEvidence({
            manifestAsset: {
              role: finalizedVision.role,
              digest: finalizedVision.digest,
              version: finalizedVision.version,
              release: {
                ...finalizedVision.release,
                descriptorIdentity: `factory-evidence://${contentDescriptorIdentity.replace(":", "/")}`,
                descriptorDigest: contentDescriptorIdentity,
              },
            },
            documents,
            signatures: delivery.signatures,
            approvedIdentities: {
              descriptor: [candidate.supplierIdentity],
              attestation: [candidate.supplierIdentity],
              sbom: [candidate.supplierIdentity],
              provenance: [candidate.supplierIdentity],
              conformance: [acceptanceIdentity],
              approval: [acceptanceIdentity],
            },
          }),
        /Factory Manifest.*descriptor|selection must match/i,
      );
      verifyFactoryVisionDelivery(stagedFactory);
      const factoryProof = spawnSync(
        process.execPath,
        [
          "scripts/factory/verify-vision-delivery-assembly.mjs",
          "--kind",
          "factory",
          "--root",
          stagedFactory,
        ],
        { encoding: "utf8" },
      );
      assert.equal(factoryProof.status, 0, factoryProof.stderr);
      assert.equal(
        JSON.parse(factoryProof.stdout).kind,
        "factory-vision-delivery-assembly",
      );

      writeFileSync(
        join(
          stagedFactory,
          "VISION-INSTALLER",
          "vision-diagnostic-redaction.psm1",
        ),
        "tampered",
      );
      assert.throws(
        () => verifyFactoryVisionDelivery(stagedFactory),
        /digest does not bind its staged bytes/,
      );
      const tamperedProof = spawnSync(
        process.execPath,
        [
          "scripts/factory/verify-vision-delivery-assembly.mjs",
          "--kind",
          "factory",
          "--root",
          stagedFactory,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(tamperedProof.status, 0);
      assert.match(
        tamperedProof.stderr,
        /digest does not bind its staged bytes/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
