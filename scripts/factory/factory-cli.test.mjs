import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { parse7ZipBannerVersion } from "./build-factory-media.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { canonicalJson, createFactoryManifest } from "./factory-manifest.mjs";
import { createSignedAssetEvidence } from "./verify-asset-evidence.mjs";
import {
  createVisionReleaseApproval,
  createVisionReleaseDescriptor,
} from "./vision-release.mjs";

const run = promisify(execFile);
function toolPath(name, environmentName) {
  return (
    process.env[environmentName] ??
    execFileSync("sh", ["-lc", `command -v ${name}`], {
      encoding: "utf8",
    }).trim()
  );
}

const UDF_EXTRACTOR_PATH = toolPath("7z", "VEM_FACTORY_TEST_UDF_EXTRACTOR");
const UDF_WRITER_PATH = toolPath("genisoimage", "VEM_FACTORY_TEST_UDF_WRITER");
const WIMLIB_PATH = toolPath("wimlib-imagex", "VEM_FACTORY_TEST_WIMLIB");
const SYNTHETIC_ISO_TOOL = UDF_WRITER_PATH;
const IMAGE_HASH = "f".repeat(64);
const BUILDER_IDENTITY =
  "github-actions://vem/vem/.github/workflows/build.yml@refs/heads/main";
const PINNED_UDF_WRITER_VERSION = "1.1.11";
const PINNED_UDF_WRITER_DIGEST = process.env.VEM_FACTORY_TEST_UDF_WRITER_DIGEST;

function toolVersion(path, args, expression, label) {
  const output = execFileSync(path, args, { encoding: "utf8" });
  const version = expression.exec(output)?.[1];
  assert.ok(version, `${label} must report a version`);
  return version;
}

function sevenZipVersion(path) {
  const version = parse7ZipBannerVersion(
    execFileSync(path, [], { encoding: "utf8" }),
  );
  assert.ok(version, "7z must report a version");
  return version;
}

describe("7-Zip banner fixture parsing", () => {
  it("accepts official and local 7-Zip banners", () => {
    assert.equal(
      parse7ZipBannerVersion(
        "7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov",
      ),
      "23.01",
    );
    assert.equal(
      parse7ZipBannerVersion(
        "7-Zip [64] 26.01 : Copyright (c) 1999-2026 Igor Pavlov",
      ),
      "26.01",
    );
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-cli-"));
  const udfExtractorHash = createHash("sha256")
    .update(await readFile(UDF_EXTRACTOR_PATH))
    .digest("hex");
  const udfExtractor = {
    identity: `tool://7z@sha256:${udfExtractorHash}`,
    digest: `sha256:${udfExtractorHash}`,
    version: `${sevenZipVersion(UDF_EXTRACTOR_PATH)
      .split(".")
      .map((part) => String(Number(part)))
      .join(".")}.0`,
  };
  const observedUdfWriterDigest = `sha256:${createHash("sha256")
    .update(await readFile(UDF_WRITER_PATH))
    .digest("hex")}`;
  assert.ok(
    PINNED_UDF_WRITER_DIGEST,
    "Factory media tests require the executing genisoimage digest",
  );
  assert.equal(
    observedUdfWriterDigest,
    PINNED_UDF_WRITER_DIGEST,
    "fixture genisoimage digest must match the pinned contract",
  );
  assert.equal(
    toolVersion(
      UDF_WRITER_PATH,
      ["--version"],
      /genisoimage\s+([0-9.]+)/i,
      "genisoimage",
    ),
    PINNED_UDF_WRITER_VERSION,
    "fixture genisoimage version must match the pinned contract",
  );
  const udfWriter = {
    identity: `tool://genisoimage@${PINNED_UDF_WRITER_DIGEST}`,
    digest: PINNED_UDF_WRITER_DIGEST,
    version: PINNED_UDF_WRITER_VERSION,
  };
  const sourceIso = join(root, "fixture-source.iso");
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
    Buffer.alloc(4096, 0x42),
  );
  await writeFile(
    join(sourceTree, "efi", "microsoft", "boot", "efisys.bin"),
    Buffer.alloc(2048, 0x55),
  );
  const wimInput = join(root, "wim-input");
  await mkdir(wimInput, { recursive: true });
  await writeFile(join(wimInput, "fixture.txt"), "factory wim fixture\n");
  execFileSync(WIMLIB_PATH, [
    "capture",
    wimInput,
    join(sourceTree, "sources", "install.wim"),
    "Professional",
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
    sourceIso,
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
    ["windows-source-iso", await readFile(sourceIso)],
    ["openssh-installer", Buffer.from("openssh\n")],
    ["wireguard-installer", Buffer.from("wireguard\n")],
    ["vem-daemon", Buffer.from("daemon\n")],
    ["vem-machine-ui", Buffer.from("machine\n")],
    ["webview2-loader", Buffer.from("webview\n")],
    ["webview2-runtime-installer", Buffer.from("webview runtime\n")],
    ["vision-release", Buffer.from("vision\n")],
    ["vision-configuration", Buffer.from('{"schemaVersion":"fixture/v1"}\n')],
    [
      "maintenance-ssh-ca-public-key",
      Buffer.from(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFactoryPublicKey vem-factory\n",
      ),
    ],
  ]);
  const evidenceStore = join(root, "evidence");
  await mkdir(join(evidenceStore, "sha256"), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const definitions = [];
  for (const [role, bytes] of bytesByRole) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const signed = createSignedAssetEvidence({
      assetDigest: `sha256:${hash}`,
      privateKey,
      sourceIdentity: `git+https://github.com/vem/fixtures@${"1".repeat(40)}#${role}`,
      builderIdentity: BUILDER_IDENTITY,
      buildId: "github-actions://vem/vem/actions/runs/42/attempts/1",
    });
    for (const evidence of signed.evidence) {
      await writeFile(
        join(evidenceStore, "sha256", evidence.digest.slice(7)),
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
        "webview2-runtime-installer":
          "MicrosoftEdgeWebView2RuntimeInstallerX64.exe",
        "vision-release": "vision-release.zip",
        "vision-configuration": "vision-config.json",
        "maintenance-ssh-ca-public-key": "maintenance-ca.pub",
      }[role],
      identity: `factory-cas://sha256/${hash}`,
      digest: `sha256:${hash}`,
      version: role === "windows-source-iso" ? "10.0.19045" : "1.0.0",
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
    identity: `oci://builder@sha256:${IMAGE_HASH}`,
    digest: `sha256:${IMAGE_HASH}`,
    version: "1.0.0",
  };
  const installImageDigest = `sha256:${createHash("sha256")
    .update(await readFile(join(sourceTree, "sources", "install.wim")))
    .digest("hex")}`;
  const wimlibDigest = `sha256:${createHash("sha256")
    .update(await readFile(WIMLIB_PATH))
    .digest("hex")}`;
  const visionAsset = definitions.find(({ role }) => role === "vision-release");
  const sha256 = (bytes) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const evidenceIdentity = (digest) =>
    `factory-evidence://${digest.replace(":", "/")}`;
  const sbomBytes = Buffer.from('{"spdxVersion":"SPDX-2.3"}');
  const provenanceBytes = Buffer.from(
    '{"predicateType":"https://slsa.dev/provenance/v1"}',
  );
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
  const descriptorBytesDigest = sha256(descriptorBytes);
  visionAsset.release = {
    descriptorIdentity: evidenceIdentity(descriptorBytesDigest),
    descriptorDigest: descriptorBytesDigest,
    attestationIdentity: evidenceIdentity(sha256(attestationBytes)),
    attestationDigest: sha256(attestationBytes),
    approvalIdentity: evidenceIdentity(sha256(approvalBytes)),
    approvalDigest: sha256(approvalBytes),
    conformanceEvidenceIdentity: evidenceIdentity(sha256(conformanceBytes)),
    conformanceEvidenceDigest: sha256(conformanceBytes),
  };
  const strip = ({ bytes, ...value }) => value;
  const manifest = createFactoryManifest({
    schemaVersion: "vem-factory-manifest/v1",
    kind: "factory-manifest",
    profile: "testbed",
    source: {
      windowsMedia: strip(definitions[0]),
      installImageIndex: 1,
      installImageEdition: "Professional",
      installImageDigest,
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
    assets: definitions.slice(1).map(strip),
    toolchain: {
      builderImage,
      udfExtractor,
      udfWriter,
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
  const manifestStore = join(root, "manifests");
  const assetStoreRoot = join(root, "assets");
  const sourceStoreRoot = join(root, "windows-source");
  await mkdir(join(manifestStore, "sha256"), { recursive: true });
  await mkdir(join(sourceStoreRoot, "sha256"), { recursive: true });
  await writeFile(
    join(manifestStore, "sha256", `${manifest.manifestId.slice(7)}.json`),
    JSON.stringify(manifest),
  );
  const visionDeliveryUnit = join(root, "vision-release-delivery-unit.json");
  const repositoryVisionTrustedRoots = join(
    root,
    "repository-vision-trusted-roots.json",
  );
  const factoryVisionTrustedRoots = join(
    root,
    "factory-vision-trusted-roots.json",
  );
  await writeFile(
    visionDeliveryUnit,
    JSON.stringify({
      documents: Object.fromEntries(
        Object.entries(documents).map(([role, bytes]) => [
          role,
          bytes.toString("base64"),
        ]),
      ),
      signatures,
    }),
  );
  const trustedRoots = Object.fromEntries(
    Object.keys(documents).map((role) => [role, [signerIdentity]]),
  );
  await writeFile(repositoryVisionTrustedRoots, JSON.stringify(trustedRoots));
  await writeFile(factoryVisionTrustedRoots, JSON.stringify(trustedRoots));
  await writeFile(
    join(
      sourceStoreRoot,
      "sha256",
      manifest.source.windowsMedia.digest.slice(7),
    ),
    definitions[0].bytes,
  );
  const store = new ContentAddressedAssetStore(assetStoreRoot);
  for (const definition of definitions.slice(1)) {
    const source = join(root, `${definition.role}.bin`);
    await writeFile(source, definition.bytes);
    await store.ensure(definition, source);
  }
  const approvalPolicy = join(root, "approval-policy.json");
  await writeFile(
    approvalPolicy,
    JSON.stringify({
      signerIdentities: [definitions[0].signature.signerIdentity],
      builderIdentities: [BUILDER_IDENTITY],
      authenticodeSignerIdentities: [],
    }),
  );
  return {
    root,
    manifest,
    manifestStore,
    assetStoreRoot,
    sourceStoreRoot,
    evidenceStore,
    approvalPolicy,
    visionDeliveryUnit,
    repositoryVisionTrustedRoots,
    factoryVisionTrustedRoots,
    visionEvidenceVerifier: "/usr/bin/true",
    builderImage,
  };
}

describe("Factory builder CLI fixture", () => {
  it("loads logical identities, verifies host policy/toolchain, and writes sanitized result", async () => {
    const data = await fixture();
    try {
      const outputDirectory = join(data.root, "output");
      const result = await run(
        process.execPath,
        [
          "scripts/factory/factory-cli.mjs",
          "--manifest-store",
          data.manifestStore,
          "--asset-store",
          data.assetStoreRoot,
          "--output-dir",
          outputDirectory,
          "--windows-source-store",
          data.sourceStoreRoot,
          "--evidence-store",
          data.evidenceStore,
          "--approval-policy",
          data.approvalPolicy,
          "--udf-extractor",
          UDF_EXTRACTOR_PATH,
          "--udf-writer",
          UDF_WRITER_PATH,
          "--wimlib",
          WIMLIB_PATH,
          "--vision-release-delivery-unit",
          data.visionDeliveryUnit,
          "--repository-vision-trusted-roots",
          data.repositoryVisionTrustedRoots,
          "--factory-vision-trusted-roots",
          data.factoryVisionTrustedRoots,
          "--vision-evidence-verifier",
          data.visionEvidenceVerifier,
          "--manifest-identity",
          data.manifest.manifestId,
          "--reproducibility",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            VEM_FACTORY_EXECUTED_BUILDER_IMAGE: data.builderImage.identity,
            VEM_FACTORY_EXPECTED_UDF_EXTRACTOR_DIGEST:
              data.manifest.toolchain.udfExtractor.digest,
            VEM_FACTORY_EXPECTED_UDF_EXTRACTOR_VERSION:
              data.manifest.toolchain.udfExtractor.version,
            VEM_FACTORY_EXPECTED_UDF_WRITER_DIGEST:
              data.manifest.toolchain.udfWriter.digest,
            VEM_FACTORY_EXPECTED_UDF_WRITER_VERSION:
              data.manifest.toolchain.udfWriter.version,
            VEM_FACTORY_EXPECTED_WIMLIB_DIGEST:
              data.manifest.toolchain.wimlib.digest,
            VEM_FACTORY_EXPECTED_WIMLIB_VERSION:
              data.manifest.toolchain.wimlib.version,
          },
        },
      );
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.manifestIdentity, data.manifest.manifestId);
      assert.match(
        parsed.isoIdentity,
        /^factory-cas:\/\/sha256\/[a-f0-9]{64}$/,
      );
      assert.equal(
        parsed.provenanceIdentity,
        `factory-evidence://${parsed.provenanceDigest.replace(":", "/")}`,
      );
      assert.equal(result.stdout.includes(data.root), false);
      const provenance = JSON.parse(
        await readFile(
          join(outputDirectory, "factory-provenance.json"),
          "utf8",
        ),
      );
      assert.equal(provenance.evidence.cache.hits, 9);
      assert.equal(provenance.evidence.sourceMedia.cached, false);
      assert.equal(provenance.evidence.policy.hostPathsIncluded, false);
      const outputResolution = await new ContentAddressedAssetStore(
        data.assetStoreRoot,
      ).resolve({
        role: "factory-iso",
        identity: parsed.isoIdentity,
        digest: parsed.isoDigest,
      });
      assert.equal(outputResolution.status, "hit");
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });
});
