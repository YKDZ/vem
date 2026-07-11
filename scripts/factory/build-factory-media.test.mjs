import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildFactoryMedia,
  assertWimMagic,
  createWindowsFactoryFirstBootMedia,
  expectedFactoryEffectiveInputRoles,
  factoryPreparationSplat,
  inspectBootableIso,
} from "./build-factory-media.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { admitFactoryAcceptance } from "./factory-acceptance-admission.mjs";
import { canonicalJson, createFactoryManifest } from "./factory-manifest.mjs";
import { createSignedAssetEvidence } from "./verify-asset-evidence.mjs";
import {
  createVisionReleaseApproval,
  createVisionReleaseDescriptor,
} from "./vision-release.mjs";

const XORRISO_PATH = process.env.VEM_FACTORY_TEST_XORRISO ?? "/usr/bin/xorriso";
const WIMLIB_PATH =
  process.env.VEM_FACTORY_TEST_WIMLIB ?? "/usr/bin/wimlib-imagex";
const SYNTHETIC_ISO_TOOL = "/usr/bin/genisoimage";
const BUILDER_IMAGE_HASH = "f".repeat(64);
const EVIDENCE_BUILDER =
  "github-actions://vem/vem/.github/workflows/build.yml@refs/heads/main";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function toolVersion(path, args, expression, label) {
  const output = execFileSync(path, args, { encoding: "utf8" });
  const version = expression.exec(output)?.[1];
  assert.ok(version, `${label} must report a version`);
  return version;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-media-"));
  const isoBuilderDigest = `sha256:${createHash("sha256")
    .update(await readFile(XORRISO_PATH))
    .digest("hex")}`;
  const isoBuilder = {
    identity: `tool://xorriso@${isoBuilderDigest}`,
    digest: isoBuilderDigest,
    version: toolVersion(
      XORRISO_PATH,
      ["-version"],
      /xorriso version\s*:\s*([0-9.]+)/i,
      "xorriso",
    ),
  };
  const sourceIsoPath = join(root, "windows-setup-synthetic.iso");
  const sourceTree = join(root, "synthetic-windows-setup");
  await mkdir(join(sourceTree, "boot"), { recursive: true });
  await mkdir(join(sourceTree, "efi", "microsoft", "boot"), {
    recursive: true,
  });
  await mkdir(join(sourceTree, "sources"), { recursive: true });
  await writeFile(
    join(sourceTree, "setup.exe"),
    "Windows Setup synthetic fixture\n",
  );
  await writeFile(
    join(sourceTree, "boot", "etfsboot.com"),
    Buffer.alloc(2048, 0),
  );
  await writeFile(
    join(sourceTree, "efi", "microsoft", "boot", "efisys.bin"),
    Buffer.alloc(2048, 0),
  );
  const wimInput = join(root, "wim-input");
  await mkdir(wimInput, { recursive: true });
  await writeFile(join(wimInput, "fixture.txt"), "factory wim fixture\n");
  execFileSync(WIMLIB_PATH, [
    "capture",
    wimInput,
    join(sourceTree, "sources", "install.wim"),
    "VEM Factory Fixture",
  ]);
  await writeFile(
    join(sourceTree, "sources", "boot.wim"),
    await readFile(join(sourceTree, "sources", "install.wim")),
  );
  execFileSync(SYNTHETIC_ISO_TOOL, [
    "-udf",
    "-J",
    "-R",
    "-iso-level",
    "3",
    "-o",
    sourceIsoPath,
    "-b",
    "boot/etfsboot.com",
    "-no-emul-boot",
    "-boot-load-size",
    "8",
    "-eltorito-alt-boot",
    "-e",
    "efi/microsoft/boot/efisys.bin",
    "-no-emul-boot",
    sourceTree,
  ]);

  const bytesByRole = new Map([
    ["windows-source-iso", await readFile(sourceIsoPath)],
    ["openssh-installer", Buffer.from("openssh redistributable fixture\n")],
    ["wireguard-installer", Buffer.from("wireguard redistributable fixture\n")],
    ["vem-daemon", Buffer.from("daemon fixture\n")],
    ["vem-machine-ui", Buffer.from("machine UI fixture\n")],
    ["webview2-loader", Buffer.from("WebView2 loader fixture\n")],
    ["vision-release", Buffer.from("vision release fixture\n")],
    ["vision-configuration", Buffer.from('{"schemaVersion":"fixture/v1"}\n')],
    [
      "maintenance-ssh-ca-public-key",
      Buffer.from(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFactoryPublicKey vem-factory\n",
      ),
    ],
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
      mediaFileName: {
        "windows-source-iso": "windows10.iso",
        "openssh-installer": "openssh.msi",
        "wireguard-installer": "wireguard.msi",
        "vem-daemon": "vending-daemon.exe",
        "vem-machine-ui": "machine.exe",
        "webview2-loader": "WebView2Loader.dll",
        "vision-release": "vision-release.zip",
        "vision-configuration": "vision-config.json",
        "maintenance-ssh-ca-public-key": "maintenance-ca.pub",
      }[role],
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
  const installImageDigest = `sha256:${createHash("sha256")
    .update(await readFile(join(sourceTree, "sources", "install.wim")))
    .digest("hex")}`;
  const wimlibDigest = `sha256:${createHash("sha256")
    .update(await readFile(WIMLIB_PATH))
    .digest("hex")}`;
  const visionAsset = definitions.find(({ role }) => role === "vision-release");
  const sbomBytes = Buffer.from('{"spdxVersion":"SPDX-2.3"}');
  const provenanceBytes = Buffer.from(
    '{"predicateType":"https://slsa.dev/provenance/v1"}',
  );
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
      installImageIndex: 1,
      installImageEdition: "VEM Factory Fixture",
      installImageDigest,
      targetFirmware: "uefi",
    },
    factoryPreparation: {
      schemaVersion: "vem-factory-preparation/v1",
      kind: "factory-preparation",
      environmentName: "fixture",
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
        runnerSourceAllowlist: ["runner:fixture"],
        maintainerSourceAllowlist: ["maintainer:fixture"],
        openSsh: {
          version: "1.0.0",
          approvedSignerThumbprint: "A".repeat(40),
          approvedRootThumbprint: "B".repeat(40),
        },
        wireGuard: {
          version: "1.0.0",
          approvedSignerThumbprint: "C".repeat(40),
          approvedRootThumbprint: "D".repeat(40),
        },
      },
    },
    assets: definitions.slice(1).map(({ bytes, ...definition }) => definition),
    toolchain: {
      builderImage,
      isoBuilder,
      wimlib: {
        identity: `tool://wimlib-imagex@${wimlibDigest}`,
        digest: wimlibDigest,
        version: toolVersion(
          WIMLIB_PATH,
          ["--version"],
          /wimlib-imagex\s+([0-9.]+)/i,
          "wimlib-imagex",
        ),
      },
    },
    outputPolicy: {
      isoFileName: "vem-factory-{manifestId}.iso",
      reproducible: true,
      includeProvenance: true,
      assemblyMode: "windows-serviced-iso",
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
  const visionEvidenceVerifierPath = join(root, "vision-release-verifier");
  await writeFile(visionEvidenceVerifierPath, await readFile("/usr/bin/true"), {
    mode: 0o555,
  });
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
    visionEvidenceVerifierPath,
    builderImage,
    definitions,
  };
}

describe("real deterministic Factory ISO builder", () => {
  it("recognizes the exact eight-byte magic from a wimlib-produced WIM", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-wim-magic-"));
    try {
      const input = join(root, "input");
      const image = join(root, "fixture.wim");
      await mkdir(input);
      await writeFile(join(input, "fixture.txt"), "fixture\n");
      execFileSync(WIMLIB_PATH, ["capture", input, image, "Fixture"]);
      assert.deepEqual(
        (await readFile(image)).subarray(0, 8),
        Buffer.from([0x4d, 0x53, 0x57, 0x49, 0x4d, 0, 0, 0]),
      );
      await assertWimMagic(image, "fixture WIM");
      await writeFile(join(root, "not-a-wim.bin"), Buffer.alloc(8));
      await assert.rejects(
        assertWimMagic(join(root, "not-a-wim.bin"), "invalid WIM"),
        /not a WIM image/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates Windows Setup OEM media with deterministic unattended baseline inputs and no personalization", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(join(data.root, "cas"));
      const resolvedAssets = [];
      for (const definition of data.definitions) {
        const reference = (({ bytes, ...value }) => value)(definition);
        if (reference.role !== "windows-source-iso") {
          await store.ensure(reference, data.sourcePaths[reference.identity]);
        }
        resolvedAssets.push({
          reference,
          ...(reference.role === "vision-release"
            ? {
                visionEvidence: {
                  deliveryUnit: data.visionReleaseDeliveryUnit,
                },
              }
            : {}),
        });
      }
      const directory = join(data.root, "windows-oem");
      const media = await createWindowsFactoryFirstBootMedia({
        manifest: data.manifest,
        resolvedAssets,
        store,
        directory,
        visionTrustMaterial: {
          anchorBytes: Buffer.from('{"anchor":true}'),
          policyBytes: Buffer.from('{"policy":true}'),
          verifierBytes: Buffer.from("fixture verifier"),
        },
      });
      assert.equal(media.unattended, "Autounattend.xml");
      assert.equal(
        media.firstBoot,
        "specialize/RunSynchronous + FirstLogonCommands + VemFactoryBootstrap(SYSTEM)",
      );
      const unattended = await readFile(
        join(directory, "Autounattend.xml"),
        "utf8",
      );
      assert.match(unattended, /<Type>EFI<\/Type><Size>260<\/Size>/);
      assert.match(unattended, /<Type>MSR<\/Type><Size>16<\/Size>/);
      assert.match(unattended, /DE94BBA4-06D1-4D40-A16A-BFD50179D6AC/);
      assert.match(unattended, /<PartitionID>3<\/PartitionID>/);
      assert.match(unattended, /\/IMAGE\/INDEX/);
      assert.equal(/password|private.?key|credential/i.test(unattended), false);
      const baseline = JSON.parse(
        await readFile(
          join(
            directory,
            "sources",
            "$OEM$",
            "$1",
            "VEM",
            "Factory",
            "factory-baseline.json",
          ),
          "utf8",
        ),
      );
      assert.equal(baseline.accounts.maintenance, "YKDZ");
      assert.equal(baseline.assets.length, 8);
      assert.equal(JSON.stringify(baseline).includes("password"), false);
      assert.equal(JSON.stringify(baseline).includes(data.root), false);
      const descriptor = JSON.parse(
        await readFile(
          join(
            directory,
            "sources",
            "$OEM$",
            "$1",
            "VEM",
            "Factory",
            "factory-preparation.json",
          ),
          "utf8",
        ),
      );
      assert.equal(descriptor.kind, "factory-preparation-descriptor");
      const splat = factoryPreparationSplat(
        descriptor,
        "C:\\VEM\\Factory",
        "C:\\ProgramData\\VEM\\factory\\one-time-personalization.json",
      );
      assert.deepEqual(
        Object.keys(splat).sort(),
        [
          "DaemonArtifactPath",
          "DaemonSha256",
          "MachineUiArtifactPath",
          "MachineUiSha256",
          "EnvironmentName",
          "ProvisioningEndpoint",
          "MqttUrl",
          "HardwareMode",
          "HardwareModel",
          "TopologyIdentity",
          "TopologyVersion",
          "ExpectedDisplayWidth",
          "ExpectedDisplayHeight",
          "ExpectedDisplayOrientation",
          "ExpectedKioskUser",
          "ExpectedMaintenanceUser",
          "ExpectedAutoLogonUser",
          "ExpectedKioskShell",
          "TargetLayoutVersion",
          "FactoryProfile",
          "PersonalizationMediaPath",
          "FactoryMediaRoot",
          "VisionConfigurationSourcePath",
          "OpenSshPackagePath",
          "OpenSshPackageSource",
          "OpenSshPackageVersion",
          "OpenSshPackageSha256",
          "OpenSshApprovedSignerThumbprint",
          "OpenSshApprovedRootThumbprint",
          "WireGuardPackagePath",
          "WireGuardPackageSource",
          "WireGuardPackageVersion",
          "WireGuardPackageSha256",
          "WireGuardApprovedSignerThumbprint",
          "WireGuardApprovedRootThumbprint",
          "MaintenanceSshCaPublicKeyPath",
          "MaintenanceSshCaPublicKeySha256",
          "MaintenanceRunnerSourceAllowlist",
          "MaintenanceMaintainerSourceAllowlist",
          "MaintenanceWireGuardInterfaceAlias",
          "MaintenanceWireGuardListenAddress",
          "ResetExistingVemState",
        ].sort(),
      );
      assert.equal(splat.DaemonSha256, descriptor.assets.daemon.sha256);
      assert.equal(
        splat.VisionConfigurationSourcePath,
        "C:\\VEM\\Factory\\assets\\vision-config.json",
      );
      const bootstrap = await readFile(
        join(
          directory,
          "sources",
          "$OEM$",
          "$1",
          "VEM",
          "Factory",
          "bootstrap-factory-runtime.ps1",
        ),
        "utf8",
      );
      for (const key of Object.keys(splat))
        assert.match(bootstrap, new RegExp(`\\b${key}\\b`));
      assert.match(
        bootstrap,
        /prepare-factory-runtime\.ps1[\s\S]*provision-vision-factory-release\.ps1[\s\S]*verify-factory-runtime\.ps1/,
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(
              directory,
              "sources",
              "$OEM$",
              "$1",
              "VEM",
              "Factory",
              "VEM",
              "VISION-FACTORY-PROVISIONING.JSON",
            ),
            "utf8",
          ),
        ).schemaVersion,
        "vem-vision-factory-provisioning/v1",
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("replays the source boot configuration and injects OEM media into a deterministic Windows ISO", async () => {
    const data = await fixture();
    try {
      const manifest = data.manifest;
      const result = await buildFactoryMedia({
        manifest,
        store: new ContentAddressedAssetStore(join(data.root, "cas")),
        sourcePaths: data.sourcePaths,
        evidenceStoreRoot: data.evidenceStoreRoot,
        approvalPolicy: data.approvalPolicy,
        visionReleaseDeliveryUnit: data.visionReleaseDeliveryUnit,
        repositoryVisionTrustedRoots: data.repositoryVisionTrustedRoots,
        factoryVisionTrustedRoots: data.factoryVisionTrustedRoots,
        visionEvidenceVerifierPath: data.visionEvidenceVerifierPath,
        isoBuilderPath: XORRISO_PATH,
        wimlibPath: WIMLIB_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "output"),
        reproducibility: true,
      });
      assert.equal(result.provenance.output.windowsInstallerCustomized, true);
      assert.equal(result.reproducibility.identical, true);
      assert.deepEqual(
        result.provenance.output.structure.windowsSetup.bootCatalog.map(
          ({ platform, isoEntry }) => ({ platform, isoEntry }),
        ),
        [
          { platform: "BIOS", isoEntry: "boot/etfsboot.com" },
          { platform: "UEFI", isoEntry: "efi/microsoft/boot/efisys.bin" },
        ],
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

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
        isoBuilderPath: XORRISO_PATH,
        wimlibPath: WIMLIB_PATH,
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
        (({ windowsSetup, ...structure }) => structure)(
          result.provenance.output.structure,
        ),
      );
      assert.equal(
        result.provenance.output.structure.windowsSetup.installImage,
        "sources/install.wim",
      );
      assert.equal(result.provenance.output.windowsInstallerCustomized, true);
      assert.equal(
        result.provenance.output.requiresIssue15CustomizationAssets,
        false,
      );
      assert.equal(result.provenance.toolchain.isoBuilder.executed, true);
      assert.equal(result.provenance.inputs.length, 9);
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
      assert.equal(result.provenance.evidence.cache.misses, 8);
      const manifestPath = join(data.root, "host-store-manifest.json");
      const provenancePath = join(data.root, "host-store-provenance.json");
      await writeFile(manifestPath, JSON.stringify(data.manifest));
      const provenanceBytes = Buffer.from(JSON.stringify(result.provenance));
      await writeFile(provenancePath, provenanceBytes);
      const admitted = await admitFactoryAcceptance({
        manifestPath,
        provenancePath,
        outputIsoPath: result.output.path,
        manifestIdentity: data.manifest.manifestId,
        provenanceDigest: sha256(provenanceBytes),
        outputIdentity: result.output.identity,
        outputDigest: result.output.digest,
        isoBuilderPath: XORRISO_PATH,
        wimlibPath: WIMLIB_PATH,
      });
      assert.equal(admitted.provenanceDigest, sha256(provenanceBytes));
      assert.deepEqual(
        result.provenance.effectiveInputs.map(({ role }) => role).sort(),
        expectedFactoryEffectiveInputRoles(data.manifest),
      );
      await writeFile(
        data.visionEvidenceVerifierPath,
        Buffer.concat([
          await readFile(data.visionEvidenceVerifierPath),
          Buffer.from("factory-effective-input-mutation\n"),
        ]),
        { mode: 0o555 },
      );
      const mutated = await buildFactoryMedia({
        manifest: data.manifest,
        store: new ContentAddressedAssetStore(join(data.root, "mutated-cas")),
        sourcePaths: data.sourcePaths,
        evidenceStoreRoot: data.evidenceStoreRoot,
        approvalPolicy: data.approvalPolicy,
        visionReleaseDeliveryUnit: data.visionReleaseDeliveryUnit,
        repositoryVisionTrustedRoots: data.repositoryVisionTrustedRoots,
        factoryVisionTrustedRoots: data.factoryVisionTrustedRoots,
        visionEvidenceVerifierPath: data.visionEvidenceVerifierPath,
        isoBuilderPath: XORRISO_PATH,
        wimlibPath: WIMLIB_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "mutated-output"),
        reproducibility: true,
      });
      assert.notEqual(mutated.output.identity, result.output.identity);
      assert.notDeepEqual(
        mutated.provenance.effectiveInputs,
        result.provenance.effectiveInputs,
      );
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
          isoBuilderPath: XORRISO_PATH,
          wimlibPath: WIMLIB_PATH,
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
