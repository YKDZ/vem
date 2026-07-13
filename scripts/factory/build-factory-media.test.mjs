import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
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
  inspectBootableIsoFile,
  inspectIsoFilesystemExtents,
  inspectIsoFilesystemViews,
  inspectWindowsSetupIso,
  hasExpected7ZipBannerVersion,
  normalizeDescriptorTimestampsFile,
  parse7ZipBannerVersion,
  rangeBackedIsoMedia,
} from "./build-factory-media.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { admitFactoryAcceptance } from "./factory-acceptance-admission.mjs";
import { canonicalJson, createFactoryManifest } from "./factory-manifest.mjs";
import { createSignedAssetEvidence } from "./verify-asset-evidence.mjs";
import {
  createVisionReleaseApproval,
  createVisionReleaseDescriptor,
} from "./vision-release.mjs";

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
const XORRISO_PATH = toolPath("xorriso", "VEM_FACTORY_TEST_XORRISO");
const SYNTHETIC_ISO_TOOL = UDF_WRITER_PATH;
const BUILDER_IMAGE_HASH = "f".repeat(64);
const EVIDENCE_BUILDER =
  "github-actions://vem/vem/.github/workflows/build.yml@refs/heads/main";
const ISO_SECTOR_BYTES = 2048;
const PINNED_UDF_WRITER_VERSION = "1.1.11";
const PINNED_UDF_WRITER_DIGEST = process.env.VEM_FACTORY_TEST_UDF_WRITER_DIGEST;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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

describe("7-Zip banner version parsing", () => {
  it("captures official and local 7-Zip banner versions strictly", () => {
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
    assert.equal(parse7ZipBannerVersion("7-Zip 23.01.2.3 (x64)"), undefined);
    for (const banner of [
      "7-Zip\n23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov",
      "7-Zip [64]\n26.01 : Copyright (c) 1999-2026 Igor Pavlov",
      "7-Zip [portable] 26.01 : Copyright (c) 1999-2026 Igor Pavlov",
      "7-Zip [64] [portable] 26.01 : Copyright (c) 1999-2026 Igor Pavlov",
      "7-Zip 23.01 (x86) : Copyright (c) 1999-2023 Igor Pavlov",
      "7-Zip 23.01 (x64)\n: Copyright (c) 1999-2023 Igor Pavlov",
      "7-Zip 23.01.2.3 (x64) : Copyright (c) 1999-2023 Igor Pavlov",
    ]) {
      assert.equal(parse7ZipBannerVersion(banner), undefined);
    }
    assert.equal(
      hasExpected7ZipBannerVersion(
        "7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov",
        "23.1.0",
      ),
      true,
    );
    assert.equal(
      hasExpected7ZipBannerVersion(
        "7-Zip [64] 26.01 : Copyright (c) 1999-2026 Igor Pavlov",
        "26.1.0",
      ),
      true,
    );
    assert.equal(
      hasExpected7ZipBannerVersion(
        "7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov",
        "23.2.0",
      ),
      false,
    );
  });
});

function isoDirectoryRecord({ sector, bytes, flags = 0, identifier }) {
  const name = Buffer.isBuffer(identifier)
    ? identifier
    : Buffer.from(identifier, "ascii");
  const length = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
  const record = Buffer.alloc(length);
  record[0] = length;
  record.writeUInt32LE(sector, 2);
  record.writeUInt32LE(bytes, 10);
  record[25] = flags;
  record[32] = name.length;
  name.copy(record, 33);
  return record;
}

function jolietIdentifier(value) {
  const bytes = Buffer.from(value, "utf16le");
  bytes.swap16();
  return bytes;
}

function writeIsoDirectory(media, sector, records) {
  let offset = sector * ISO_SECTOR_BYTES;
  for (const record of records) {
    record.copy(media, offset);
    offset += record.length;
  }
}

function rewriteUdfTag(descriptor) {
  const crcLength = descriptor.readUInt16LE(10);
  let crc = 0;
  for (const byte of descriptor.subarray(16, 16 + crcLength)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = ((crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  descriptor.writeUInt16LE(crc, 8);
  descriptor[4] = 0;
  descriptor[4] = [...descriptor.subarray(0, 16)].reduce(
    (sum, byte, index) => (index === 4 ? sum : (sum + byte) & 0xff),
    0,
  );
}

function findUdfRootDirectory(image) {
  const rootBlock = [...Array(image.length / ISO_SECTOR_BYTES).keys()]
    .map((sector) => sector * ISO_SECTOR_BYTES)
    .find((offset) => image.readUInt16LE(offset) === 256);
  assert.notEqual(
    rootBlock,
    undefined,
    "fixture has a UDF File Set Descriptor",
  );
  const rootIcbBlock = image.readUInt32LE(rootBlock + 404);
  const entryOffset = [...Array(image.length / ISO_SECTOR_BYTES).keys()]
    .map((sector) => sector * ISO_SECTOR_BYTES)
    .find(
      (offset) =>
        [261, 266].includes(image.readUInt16LE(offset)) &&
        image[offset + 27] === 4 &&
        image.readUInt32LE(offset + 12) === rootIcbBlock,
    );
  assert.notEqual(entryOffset, undefined, "fixture has a root directory ICB");
  assert.equal(
    image.readUInt16LE(entryOffset + 34) & 0x7,
    0,
    "fixture root directory uses short allocation descriptors",
  );
  const tag = image.readUInt16LE(entryOffset);
  const layout =
    tag === 261
      ? { extAttrs: 168, allocations: 172, data: 176 }
      : { extAttrs: 208, allocations: 212, data: 216 };
  const allocationStart =
    entryOffset +
    layout.data +
    image.readUInt32LE(entryOffset + layout.extAttrs);
  assert.equal(
    image.readUInt32LE(entryOffset + layout.allocations),
    8,
    "fixture root directory has one short allocation descriptor",
  );
  const directoryBytes = image.readUInt32LE(allocationStart) & 0x3fffffff;
  const directoryBlock = image.readUInt32LE(allocationStart + 4);
  const directoryOffset = [...Array(image.length / ISO_SECTOR_BYTES).keys()]
    .map((sector) => sector * ISO_SECTOR_BYTES)
    .find(
      (offset) =>
        image.readUInt16LE(offset) === 257 &&
        image.readUInt32LE(offset + 12) === directoryBlock,
    );
  assert.notEqual(
    directoryOffset,
    undefined,
    "fixture root directory is reachable",
  );
  return {
    allocationStart,
    directoryBytes,
    directoryOffset,
    entryOffset,
    layout,
  };
}

function firstChildFileIdentifier(directory) {
  for (let offset = 0; offset < directory.length; ) {
    if (directory[offset] === 0) {
      offset = (Math.floor(offset / 4) + 1) * 4;
      continue;
    }
    assert.equal(
      directory.readUInt16LE(offset),
      257,
      "fixture directory has File Identifier Descriptors",
    );
    const length =
      (38 + directory.readUInt16LE(offset + 36) + directory[offset + 19] + 3) &
      ~3;
    if ((directory[offset + 18] & 0x8) === 0) return offset;
    offset += length;
  }
  assert.fail("fixture root directory has a child File Identifier Descriptor");
}

function relocateEmbeddedDirectoryFileIdentifiers(directory, logicalBlock) {
  for (let offset = 0; offset < directory.length; ) {
    if (directory[offset] === 0) {
      offset = (Math.floor(offset / 4) + 1) * 4;
      continue;
    }
    assert.equal(
      directory.readUInt16LE(offset),
      257,
      "fixture directory has File Identifier Descriptors",
    );
    const length =
      (38 + directory.readUInt16LE(offset + 36) + directory[offset + 19] + 3) &
      ~3;
    directory.writeUInt32LE(logicalBlock, offset + 12);
    rewriteUdfTag(directory.subarray(offset, offset + length));
    offset += length;
  }
}

function sharedExtentIso({ cycle = false, malformedMultiExtent = false } = {}) {
  const media = Buffer.alloc(64 * ISO_SECTOR_BYTES);
  const writeDescriptor = (sector, type, rootSector, joliet) => {
    const offset = sector * ISO_SECTOR_BYTES;
    media[offset] = type;
    media.write("CD001", offset + 1, "ascii");
    media[offset + 6] = 1;
    if (joliet) media.write("%/E", offset + 88, "ascii");
    isoDirectoryRecord({
      sector: rootSector,
      bytes: ISO_SECTOR_BYTES,
      flags: 2,
      identifier: Buffer.from([0]),
    }).copy(media, offset + 156);
  };
  writeDescriptor(16, 1, 20, false);
  writeDescriptor(17, 2, 22, true);
  media[18 * ISO_SECTOR_BYTES] = 255;
  media.write("CD001", 18 * ISO_SECTOR_BYTES + 1, "ascii");

  const writeSharedTree = (rootSector, sharedSector, encode) => {
    writeIsoDirectory(media, rootSector, [
      isoDirectoryRecord({
        sector: sharedSector,
        bytes: ISO_SECTOR_BYTES,
        flags: 2,
        identifier: encode("A"),
      }),
      isoDirectoryRecord({
        sector: sharedSector,
        bytes: ISO_SECTOR_BYTES,
        flags: 2,
        identifier: encode("B"),
      }),
    ]);
    writeIsoDirectory(
      media,
      sharedSector,
      cycle
        ? [
            isoDirectoryRecord({
              sector: sharedSector,
              bytes: ISO_SECTOR_BYTES,
              flags: 2,
              identifier: encode("LOOP"),
            }),
          ]
        : [
            isoDirectoryRecord({
              sector: 30,
              bytes: 0xfffffff0,
              flags: 0x80,
              identifier: encode("INSTALL.WIM;1"),
            }),
            isoDirectoryRecord({
              sector: 31,
              bytes: 0x30,
              flags: 0,
              identifier: encode(
                malformedMultiExtent ? "OTHER.WIM;1" : "INSTALL.WIM;1",
              ),
            }),
          ],
    );
  };
  writeSharedTree(20, 21, (value) => Buffer.from(value, "ascii"));
  writeSharedTree(22, 23, jolietIdentifier);
  return media;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-media-"));
  const udfExtractorDigest = `sha256:${createHash("sha256")
    .update(await readFile(UDF_EXTRACTOR_PATH))
    .digest("hex")}`;
  const udfExtractor = {
    identity: `tool://7z@${udfExtractorDigest}`,
    digest: udfExtractorDigest,
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
  await writeFile(
    join(sourceTree, "sources", "adversarial-udf-timestamp.bin"),
    Buffer.from([
      0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0,
      0xe8, 0x07, 12, 31, 23, 59, 59, 0, 0, 0, 0, 0,
    ]),
  );
  await writeFile(
    join(sourceTree, "UDF-ONLY-MARKER.TXT"),
    "UDF-only factory source marker\n",
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
    "-hide",
    "UDF-ONLY-MARKER.TXT",
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
      assert.match(
        baseline.assets.find((asset) => asset.role === "openssh-installer")
          .fileName,
        /\.(?:msi|exe)$/i,
      );
      assert.match(
        baseline.assets.find((asset) => asset.role === "wireguard-installer")
          .fileName,
        /\.(?:msi|exe)$/i,
      );
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
      assert.match(bootstrap, /prepare-factory-runtime\.ps1/);
      assert.match(bootstrap, /verify-factory-runtime\.ps1/);
      assert.doesNotMatch(bootstrap, /provision-vision-factory-release\.ps1/);
      assert.doesNotMatch(bootstrap, /install-vision-release\.ps1/);
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
        udfExtractorPath: UDF_EXTRACTOR_PATH,
        udfWriterPath: UDF_WRITER_PATH,
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

  it("replays a source marker through canonical ISO9660, Joliet, and UDF views", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const sourceViews = inspectIsoFilesystemViews(await readFile(sourcePath));
      assert.ok(sourceViews.iso9660.includes("setup.exe"));
      assert.ok(sourceViews.joliet.includes("setup.exe"));
      assert.ok(sourceViews.joliet.includes("udf-only-marker.txt"));
      const sourceListing = execFileSync(
        UDF_EXTRACTOR_PATH,
        ["l", "-slt", sourcePath],
        {
          encoding: "utf8",
        },
      );
      assert.match(sourceListing, /Path = UDF-ONLY-MARKER\.TXT/);
      const sourceIsoView = execFileSync(
        XORRISO_PATH,
        ["-indev", sourcePath, "-ls", "/"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      assert.doesNotMatch(sourceIsoView, /UDF-ONLY-MARKER\.TXT/);
      const sourceJolietView = execFileSync(
        "isoinfo",
        ["-i", sourcePath, "-J", "-f"],
        { encoding: "utf8" },
      );
      assert.match(sourceJolietView, /UDF-ONLY-MARKER\.TXT/);

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
        udfExtractorPath: UDF_EXTRACTOR_PATH,
        udfWriterPath: UDF_WRITER_PATH,
        wimlibPath: WIMLIB_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "output"),
        reproducibility: false,
      });
      const outputListing = execFileSync(
        UDF_EXTRACTOR_PATH,
        ["l", "-slt", result.output.path],
        {
          encoding: "utf8",
        },
      );
      assert.match(outputListing, /Path = UDF-ONLY-MARKER\.TXT/);
      const outputIsoView = execFileSync(
        XORRISO_PATH,
        ["-indev", result.output.path, "-ls", "/"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      assert.doesNotMatch(outputIsoView, /UDF-ONLY-MARKER\.TXT/);
      const outputJolietView = execFileSync(
        "isoinfo",
        ["-i", result.output.path, "-J", "-f"],
        { encoding: "utf8" },
      );
      assert.match(outputJolietView, /UDF-ONLY-MARKER\.TXT/);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("retains shared ISO9660 and Joliet directory extents for each logical path and aggregates level-3 file segments", () => {
    const media = sharedExtentIso();
    assert.deepEqual(inspectIsoFilesystemViews(media), {
      iso9660: ["a/install.wim", "b/install.wim"],
      joliet: ["a/install.wim", "b/install.wim"],
    });
    for (const joliet of [false, true]) {
      const files = inspectIsoFilesystemExtents(media, { joliet });
      assert.equal(files.length, 2);
      for (const file of files) {
        assert.equal(file.path.toLowerCase().endsWith("/install.wim"), true);
        assert.equal(file.segments.length, 2);
        assert.equal(file.bytes, 0x100000020);
      }
    }
  });

  it("rejects ISO9660 directory cycles and malformed level-3 multi-extent ordering", () => {
    assert.throws(
      () => inspectIsoFilesystemViews(sharedExtentIso({ cycle: true })),
      /directory hierarchy contains a cycle/,
    );
    assert.throws(
      () =>
        inspectIsoFilesystemViews(
          sharedExtentIso({ malformedMultiExtent: true }),
        ),
      /multi-extent ordering/,
    );
  });

  it("normalizes a sparse large ISO through bounded file ranges", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const sparse = join(data.root, "sparse-large.iso");
      await cp(sourcePath, sparse);
      await truncate(sparse, 512 * 1024 * 1024);
      const before = process.memoryUsage().rss;
      await normalizeDescriptorTimestampsFile(sparse);
      const growth = process.memoryUsage().rss - before;
      assert.ok(
        growth < 64 * 1024 * 1024,
        `range normalization grew RSS by ${growth}`,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects an out-of-bounds range write before dirtying any cached page", async () => {
    const data = await fixture();
    try {
      const path = join(data.root, "range-preflight.bin");
      await writeFile(path, Buffer.from([1, 2, 3, 4]));
      const { media, close } = rangeBackedIsoMedia(path, { writable: true });
      try {
        assert.throws(
          () => media.writeRange(Buffer.from([9, 9]), 3),
          /outside the media/,
        );
      } finally {
        close();
      }
      assert.deepEqual(await readFile(path), Buffer.from([1, 2, 3, 4]));
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("normalizes the ECMA-167 PVD recording time without changing its implementation identifier", async () => {
    const data = await fixture();
    const implementationIdentifier = Buffer.from("PVD-IMPL-ID-14", "ascii");
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const media = join(data.root, "pvd-recording-time.iso");
      await cp(sourcePath, media);
      const handle = await open(media, "r+");
      try {
        const image = await readFile(media);
        let descriptorOffset;
        for (let sector = 0; sector < image.length / 2048; sector += 1) {
          const offset = sector * 2048;
          if (image.readUInt16LE(offset) === 1) {
            descriptorOffset = offset;
            break;
          }
        }
        assert.notEqual(descriptorOffset, undefined, "fixture has a UDF PVD");
        await handle.write(
          implementationIdentifier,
          0,
          implementationIdentifier.length,
          descriptorOffset + 388,
        );
        const descriptor = Buffer.alloc(2048);
        await handle.read(descriptor, 0, descriptor.length, descriptorOffset);
        const crcLength = descriptor.readUInt16LE(10);
        let crc = 0;
        for (const byte of descriptor.subarray(16, 16 + crcLength)) {
          crc ^= byte << 8;
          for (let bit = 0; bit < 8; bit += 1)
            crc =
              ((crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
        }
        descriptor.writeUInt16LE(crc, 8);
        descriptor[4] = 0;
        descriptor[4] = [...descriptor.subarray(0, 16)].reduce(
          (sum, byte, index) => (index === 4 ? sum : (sum + byte) & 0xff),
          0,
        );
        await handle.write(descriptor, 0, descriptor.length, descriptorOffset);
      } finally {
        await handle.close();
      }
      await normalizeDescriptorTimestampsFile(media);
      const normalized = await readFile(media);
      const pvd = [...Array(normalized.length / 2048).keys()]
        .map((sector) => sector * 2048)
        .find((offset) => normalized.readUInt16LE(offset) === 1);
      assert.ok(pvd !== undefined);
      assert.deepEqual(
        normalized.subarray(
          pvd + 388,
          pvd + 388 + implementationIdentifier.length,
        ),
        implementationIdentifier,
      );
      assert.deepEqual(
        normalized.subarray(pvd + 376, pvd + 376 + 12),
        Buffer.alloc(12),
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects malformed reachable UDF descriptor CRC lengths and tag locations", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      for (const [name, offset, value, expected] of [
        [
          "crc-length",
          256 * 2048 + 10,
          0xffff,
          /CRC length exceeds its sector/,
        ],
        ["tag-location", 256 * 2048 + 12, 0xff, /tag location does not match/],
      ]) {
        const malformed = join(data.root, `${name}.iso`);
        await cp(sourcePath, malformed);
        const handle = await open(malformed, "r+");
        try {
          const tag = Buffer.alloc(16);
          await handle.read(tag, 0, tag.length, 256 * 2048);
          if (name === "crc-length") tag.writeUInt16LE(value, 10);
          else tag.writeUInt32LE(value, 12);
          tag[4] = 0;
          tag[4] = [...tag].reduce(
            (sum, byte, index) => (index === 4 ? sum : (sum + byte) & 0xff),
            0,
          );
          await handle.write(tag, 0, tag.length, 256 * 2048);
        } finally {
          await handle.close();
        }
        await assert.rejects(
          normalizeDescriptorTimestampsFile(malformed),
          expected,
        );
      }
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("uses ICB Tag Flags at +34 for an embedded root directory and traverses its children", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const embedded = Buffer.from(await readFile(sourcePath));
      const root = findUdfRootDirectory(embedded);
      const directory = Buffer.from(
        embedded.subarray(
          root.directoryOffset,
          root.directoryOffset + root.directoryBytes,
        ),
      );
      assert.ok(
        root.entryOffset + root.layout.data + directory.length <=
          root.entryOffset + ISO_SECTOR_BYTES,
        "fixture root directory fits into a File Entry embedded allocation",
      );

      const rootLogicalBlock = embedded.readUInt32LE(root.entryOffset + 12);
      relocateEmbeddedDirectoryFileIdentifiers(directory, rootLogicalBlock);
      directory.copy(embedded, root.entryOffset + root.layout.data);
      // +32 is in the parent ICB location. A misleading value there must not
      // select the allocation format; only ICB Tag Flags at +34 may do that.
      embedded.writeUInt16LE(0xffff, root.entryOffset + 32);
      embedded.writeUInt16LE(3, root.entryOffset + 34);
      embedded.writeUInt32LE(
        directory.length,
        root.entryOffset + root.layout.allocations,
      );
      rewriteUdfTag(
        embedded.subarray(
          root.entryOffset,
          root.entryOffset + ISO_SECTOR_BYTES,
        ),
      );

      assert.doesNotThrow(() => inspectBootableIso(embedded));

      const child = firstChildFileIdentifier(directory);
      directory.writeUInt32LE(0xffffffff, child + 24);
      rewriteUdfTag(directory.subarray(child));
      directory.copy(embedded, root.entryOffset + root.layout.data);
      rewriteUdfTag(
        embedded.subarray(
          root.entryOffset,
          root.entryOffset + ISO_SECTOR_BYTES,
        ),
      );
      assert.throws(
        () => inspectBootableIso(embedded),
        /UDF ICB is outside its declared partition/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("reads UDF allocation type from ICB Tag Flags and rejects unsupported long and extended descriptors", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const image = await readFile(sourcePath);
      const rootFileEntry = [...Array(image.length / ISO_SECTOR_BYTES).keys()]
        .map((sector) => sector * ISO_SECTOR_BYTES)
        .find(
          (offset) =>
            [261, 266].includes(image.readUInt16LE(offset)) &&
            image[offset + 27] === 4 &&
            (image.readUInt16LE(offset + 34) & 0x7) === 0,
        );
      assert.notEqual(
        rootFileEntry,
        undefined,
        "fixture has a short_ad root ICB",
      );
      for (const [name, flags, expected] of [
        ["wrong-parent-icb-bytes", 0, null],
        [
          "long-ad",
          1,
          /only short_ad and embedded allocation descriptors are supported/,
        ],
        [
          "extended-ad",
          2,
          /only short_ad and embedded allocation descriptors are supported/,
        ],
      ]) {
        const malformed = join(data.root, `${name}.iso`);
        await cp(sourcePath, malformed);
        const handle = await open(malformed, "r+");
        try {
          const descriptor = Buffer.alloc(ISO_SECTOR_BYTES);
          await handle.read(descriptor, 0, descriptor.length, rootFileEntry);
          descriptor.writeUInt16LE(3, 32);
          descriptor.writeUInt16LE(flags, 34);
          const crcLength = descriptor.readUInt16LE(10);
          let crc = 0;
          for (const byte of descriptor.subarray(16, 16 + crcLength)) {
            crc ^= byte << 8;
            for (let bit = 0; bit < 8; bit += 1)
              crc =
                ((crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1) &
                0xffff;
          }
          descriptor.writeUInt16LE(crc, 8);
          descriptor[4] = [...descriptor.subarray(0, 16)].reduce(
            (sum, byte, index) => (index === 4 ? sum : (sum + byte) & 0xff),
            0,
          );
          await handle.write(descriptor, 0, descriptor.length, rootFileEntry);
        } finally {
          await handle.close();
        }
        if (expected) {
          await assert.rejects(
            normalizeDescriptorTimestampsFile(malformed),
            expected,
          );
        } else {
          await normalizeDescriptorTimestampsFile(malformed);
        }
      }
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a UEFI platform id masquerading as the El Torito default BIOS entry", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const media = await readFile(sourcePath);
      let bootRecord;
      for (let sector = 16; sector < 32; sector += 1) {
        const offset = sector * 2048;
        if (
          media[offset] === 0 &&
          media.subarray(offset + 1, offset + 6).toString("ascii") ===
            "CD001" &&
          media
            .subarray(offset + 7, offset + 30)
            .toString("ascii")
            .trim() === "EL TORITO SPECIFICATION"
        ) {
          bootRecord = offset;
          break;
        }
      }
      assert.ok(bootRecord !== undefined);
      const catalog = media.readUInt32LE(bootRecord + 71) * 2048;
      media[catalog + 1] = 0xef;
      assert.throws(
        () => inspectBootableIso(media),
        /boot catalog is invalid or not bootable/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("inspects only anchor-reachable UDF descriptors and ignores descriptor-like payload bytes", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const { media, close } = rangeBackedIsoMedia(sourcePath);
      try {
        assert.deepEqual(inspectBootableIso(media).udf, true);
        assert.ok(
          media.readCount < Math.floor(media.length / 2048 / 4),
          `inspection read ${media.readCount} pages from ${media.length / 2048} sectors`,
        );
      } finally {
        close();
      }
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it(
    "parses ISO9660 and Joliet install-image extents from a supplied real Windows ISO",
    { skip: !process.env.VEM_FACTORY_REAL_WINDOWS_ISO },
    async () => {
      const realIso = process.env.VEM_FACTORY_REAL_WINDOWS_ISO;
      const before = process.memoryUsage().rss;
      const structure = await inspectBootableIsoFile(realIso);
      const { media, close } = rangeBackedIsoMedia(realIso);
      let iso9660;
      let joliet;
      try {
        iso9660 = inspectIsoFilesystemExtents(media);
        joliet = inspectIsoFilesystemExtents(media, { joliet: true });
      } finally {
        close();
      }
      const growth = process.memoryUsage().rss - before;
      assert.equal(structure.iso9660, true);
      assert.equal(structure.udf, true);
      const installImage = (entries, label) => {
        const matches = entries.filter(({ path }) =>
          ["sources/install.wim", "sources/install.esd"].includes(
            path.toLocaleLowerCase("en-US"),
          ),
        );
        assert.equal(
          matches.length,
          1,
          `${label} view locates one install image`,
        );
        const entry = matches[0];
        assert.ok(
          entry.bytes > 0,
          `${label} install image has a positive size`,
        );
        assert.equal(
          entry.bytes,
          entry.segments.reduce((total, segment) => total + segment.bytes, 0),
          `${label} segment sizes equal the install image size`,
        );
        for (const segment of entry.segments) {
          assert.ok(segment.bytes > 0, `${label} extent has a positive size`);
          assert.ok(
            segment.sector >= 0,
            `${label} extent has a non-negative sector`,
          );
          assert.ok(
            (segment.sector + Math.ceil(segment.bytes / ISO_SECTOR_BYTES)) *
              ISO_SECTOR_BYTES <=
              media.length,
            `${label} extent remains within the ISO media`,
          );
        }
        if (entry.bytes > 4 * 1024 ** 3) {
          assert.ok(
            entry.segments.length > 1,
            `${label} install image above 4 GiB uses ISO9660 multi-extent records`,
          );
          for (let index = 1; index < entry.segments.length; index += 1) {
            const previous = entry.segments[index - 1];
            const current = entry.segments[index];
            assert.equal(
              current.sector,
              previous.sector + Math.ceil(previous.bytes / ISO_SECTOR_BYTES),
              `${label} install-image multi-extent segments are contiguous`,
            );
          }
        } else if (media.length < 4 * 1024 ** 3) {
          assert.equal(
            entry.segments.length,
            1,
            `${label} install image is a single extent because the supplied media is below 4 GiB`,
          );
        }
        return entry;
      };
      const isoInstallImage = installImage(iso9660, "ISO9660");
      const jolietInstallImage = installImage(joliet, "Joliet");
      assert.equal(
        jolietInstallImage.path.toLocaleLowerCase("en-US"),
        isoInstallImage.path.toLocaleLowerCase("en-US"),
        "ISO9660 and Joliet select the same install image path",
      );
      assert.equal(
        jolietInstallImage.bytes,
        isoInstallImage.bytes,
        "ISO9660 and Joliet report the same install image size",
      );
      assert.ok(
        growth < 96 * 1024 * 1024,
        `real ISO inspection grew RSS by ${growth}`,
      );
    },
  );

  it("rejects hostile extractor output before following, hashing, timestamping, or overlaying it", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const sentinel = join(data.root, "outside-sentinel.bin");
      await writeFile(sentinel, "sentinel must remain untouched\n");
      const before = await stat(sentinel);
      const hazards = [
        {
          name: "symlink",
          body: `ln -s ${JSON.stringify(sentinel)} "$output/payload"`,
          expected: /symlink/,
        },
        {
          name: "special-file",
          body: 'mkfifo "$output/payload"',
          expected: /non-regular/,
        },
        {
          name: "case-collision",
          body: ': > "$output/A"\n: > "$output/a"',
          expected: /case-colliding/,
        },
        {
          name: "eacces-directory",
          body: 'mkdir "$output/locked"\nchmod 000 "$output/locked"',
          expected: process.getuid?.() === 0 ? /Windows source ISO/ : /EACCES/,
        },
      ];
      for (const hazard of hazards) {
        const extractor = join(data.root, `hostile-${hazard.name}-extractor`);
        await writeFile(
          extractor,
          `#!/bin/sh\nset -eu\nif [ "$1" = l ]; then printf 'Path = fixture.iso\\nType = Udf\\n----------\\n'; exit 0; fi\nfor argument in "$@"; do case "$argument" in -o*) output="${"${argument#-o}"}" ;; esac; done\n: "${"${output:?missing extraction output}"}"\nmkdir -p "$output"\n${hazard.body}\n`,
          { mode: 0o755 },
        );
        const bytes = await readFile(extractor);
        await assert.rejects(
          inspectWindowsSetupIso({
            isoPath: sourcePath,
            expectedInstallImage: {
              index: data.manifest.source.installImageIndex,
              edition: data.manifest.source.installImageEdition,
              digest: data.manifest.source.installImageDigest,
            },
            udfExtractorPath: extractor,
            udfExtractor: {
              identity: `tool://hostile@${sha256(bytes)}`,
              digest: sha256(bytes),
              version: "1.0.0",
            },
            wimlibPath: WIMLIB_PATH,
            wimlib: data.manifest.toolchain.wimlib,
          }),
          hazard.expected,
          hazard.name,
        );
        const after = await stat(sentinel);
        assert.equal(
          await readFile(sentinel, "utf8"),
          "sentinel must remain untouched\n",
        );
        assert.equal(
          after.mtimeMs,
          before.mtimeMs,
          `${hazard.name} modified sentinel mtime`,
        );
      }
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("requires the extractor to select exactly one authoritative UDF view before extraction", async () => {
    const data = await fixture();
    try {
      const extractor = join(data.root, "non-udf-view-extractor");
      await writeFile(
        extractor,
        "#!/bin/sh\nif [ \"$1\" = l ]; then printf 'Path = fixture.iso\\nType = Iso\\n----------\\n'; exit 0; fi\nexit 99\n",
        { mode: 0o755 },
      );
      const bytes = await readFile(extractor);
      await assert.rejects(
        inspectWindowsSetupIso({
          isoPath: data.sourcePaths[data.manifest.source.windowsMedia.identity],
          expectedInstallImage: {
            index: data.manifest.source.installImageIndex,
            edition: data.manifest.source.installImageEdition,
            digest: data.manifest.source.installImageDigest,
          },
          udfExtractorPath: extractor,
          udfExtractor: {
            identity: `tool://fixture@${sha256(bytes)}`,
            digest: sha256(bytes),
            version: "1.0.0",
          },
          wimlibPath: WIMLIB_PATH,
          wimlib: data.manifest.toolchain.wimlib,
        }),
        /authoritative Type = Udf view/,
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
        udfExtractorPath: UDF_EXTRACTOR_PATH,
        udfWriterPath: UDF_WRITER_PATH,
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
      assert.deepEqual(
        Object.entries(result.provenance.toolchain)
          .filter(([, tool]) => tool.executed)
          .map(([name]) => name)
          .sort(),
        ["builderImage", "udfExtractor", "udfWriter", "wimlib"],
      );
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
        udfExtractorPath: UDF_EXTRACTOR_PATH,
        udfWriterPath: UDF_WRITER_PATH,
        wimlibPath: WIMLIB_PATH,
      });
      assert.equal(admitted.provenanceDigest, sha256(provenanceBytes));
      assert.deepEqual(
        result.provenance.effectiveInputs.map(({ role }) => role).sort(),
        expectedFactoryEffectiveInputRoles(data.manifest),
      );
      const mutatedVerifier = Buffer.concat([
        await readFile(data.visionEvidenceVerifierPath),
        Buffer.from("factory-effective-input-mutation\n"),
      ]);
      // The builder makes verified inputs immutable. Replace the file through
      // its writable fixture directory so this adversarial mutation works for
      // the non-root CI user as well as root.
      await rm(data.visionEvidenceVerifierPath);
      await writeFile(data.visionEvidenceVerifierPath, mutatedVerifier, {
        mode: 0o755,
      });
      await chmod(data.visionEvidenceVerifierPath, 0o755);
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
        udfExtractorPath: UDF_EXTRACTOR_PATH,
        udfWriterPath: UDF_WRITER_PATH,
        wimlibPath: WIMLIB_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "mutated-output"),
        reproducibility: false,
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

  it("produces one byte-identical serviced ISO across ten independent builds", async () => {
    const data = await fixture();
    try {
      const outputs = [];
      for (let index = 0; index < 10; index += 1) {
        const result = await buildFactoryMedia({
          manifest: data.manifest,
          store: new ContentAddressedAssetStore(
            join(data.root, `cas-${index}`),
          ),
          sourcePaths: data.sourcePaths,
          evidenceStoreRoot: data.evidenceStoreRoot,
          approvalPolicy: data.approvalPolicy,
          visionReleaseDeliveryUnit: data.visionReleaseDeliveryUnit,
          repositoryVisionTrustedRoots: data.repositoryVisionTrustedRoots,
          factoryVisionTrustedRoots: data.factoryVisionTrustedRoots,
          visionEvidenceVerifierPath: data.visionEvidenceVerifierPath,
          udfExtractorPath: UDF_EXTRACTOR_PATH,
          udfWriterPath: UDF_WRITER_PATH,
          wimlibPath: WIMLIB_PATH,
          executedBuilderImage: data.builderImage.identity,
          outputDirectory: join(data.root, `output-${index}`),
          reproducibility: false,
        });
        outputs.push(result.output);
      }
      const hashes = outputs.map(({ digest }) => digest);
      const first = outputs[0];
      const different = outputs.find(({ digest }) => digest !== first.digest);
      let differences = [];
      let differenceBytes = [];
      if (different) {
        const [left, right] = await Promise.all([
          readFile(first.path),
          readFile(different.path),
        ]);
        for (
          let index = 0;
          index < left.length && differences.length < 16;
          index += 1
        ) {
          if (left[index] !== right[index]) {
            differences.push(index);
            differenceBytes.push(
              `${index}:${left[index].toString(16)}>${right[index].toString(16)}:${left.subarray(index - 12, index + 12).toString("hex")}`,
            );
          }
        }
      }
      assert.equal(
        new Set(hashes).size,
        1,
        `non-deterministic ISO hashes: ${hashes.join(", ")}; offsets: ${differences.join(",")}; bytes: ${differenceBytes.join(",")}`,
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
          udfExtractorPath: UDF_EXTRACTOR_PATH,
          udfWriterPath: UDF_WRITER_PATH,
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
          udfExtractorPath: fakeBuilder,
          udfWriterPath: UDF_WRITER_PATH,
          executedBuilderImage: data.builderImage.identity,
        }),
        /UDF extractor digest mismatch/i,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });
});
