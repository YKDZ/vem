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
  factoryAutounattendXml,
  factoryProfileImplementationScript,
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
  replaySourceVisibleFilesAbsentFromUdf,
  writeSourceReplayBytes,
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
const EL_TORITO_VIRTUAL_SECTOR_BYTES = 512;
const PINNED_UDF_WRITER_VERSION = "1.1.11";
const PINNED_UDF_WRITER_DIGEST = process.env.VEM_FACTORY_TEST_UDF_WRITER_DIGEST;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

function decodeWimXmlForTest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])))
    return bytes.subarray(2).toString("utf16le");
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8");
}

function expectedFirstWimImage(path) {
  const xml = decodeWimXmlForTest(
    execFileSync(WIMLIB_PATH, ["info", path, "1", "--xml"]),
  );
  const images = [...xml.matchAll(/<IMAGE\b([^>]*)>([\s\S]*?)<\/IMAGE>/gi)]
    .filter(([, attributes]) => /\bINDEX\s*=\s*"1"/i.test(attributes))
    .map(([, , image]) => image);
  assert.equal(images.length, 1, "real install image has exactly one IMAGE 1");
  const edition =
    /<EDITIONID>([\s\S]*?)<\/EDITIONID>/i.exec(images[0])?.[1].trim() ??
    /<NAME>([\s\S]*?)<\/NAME>/i.exec(images[0])?.[1].trim();
  assert.ok(edition, "real install IMAGE 1 has EDITIONID or NAME");
  return { index: 1, edition };
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

function iso9660EmptyExtensionFixture() {
  const media = Buffer.alloc(40 * ISO_SECTOR_BYTES);
  const descriptor = 16 * ISO_SECTOR_BYTES;
  media[descriptor] = 1;
  media.write("CD001", descriptor + 1, "ascii");
  media[descriptor + 6] = 1;
  isoDirectoryRecord({
    sector: 20,
    bytes: ISO_SECTOR_BYTES,
    flags: 2,
    identifier: Buffer.from([0]),
  }).copy(media, descriptor + 156);
  const terminator = 17 * ISO_SECTOR_BYTES;
  media[terminator] = 255;
  media.write("CD001", terminator + 1, "ascii");
  writeIsoDirectory(media, 20, [
    isoDirectoryRecord({
      sector: 30,
      bytes: 1,
      identifier: "README.;1",
    }),
    isoDirectoryRecord({
      sector: 31,
      bytes: 1,
      identifier: "NOTICE.TXT;1",
    }),
  ]);
  return media;
}

async function fixture({
  sourceHasJoliet = true,
  sourceIsoHiddenPaths = [],
  sourceBootCatalogHidden = false,
  sourceIso9660Collision = false,
  sourceIsoVisibleReadme = false,
  sourceOverlayReplacement = false,
  uefiBootBytes = 2048,
} = {}) {
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
  await mkdir(join(sourceTree, "other"), { recursive: true });
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
    Buffer.alloc(uefiBootBytes, 0x55),
  );
  await writeFile(
    join(sourceTree, "sources", "adversarial_udf_timestamp.bin"),
    Buffer.from([
      0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0,
      0xe8, 0x07, 12, 31, 23, 59, 59, 0, 0, 0, 0, 0,
    ]),
  );
  await writeFile(
    join(sourceTree, "UDF-ONLY-MARKER.TXT"),
    "UDF-only factory source marker\n",
  );
  if (sourceIsoVisibleReadme) {
    await writeFile(
      join(sourceTree, "README.TXT"),
      "ISO-visible README replay fixture\n",
    );
  }
  if (sourceOverlayReplacement) {
    await writeFile(
      join(sourceTree, "Autounattend.xml"),
      "source unattended replacement fixture\n",
    );
  }
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
  await writeFile(join(sourceTree, "other", "boot.wim"), "other boot wim\n");
  if (sourceIso9660Collision) {
    await writeFile(join(sourceTree, "A_B.TXT"), "visible ISO9660 collision\n");
    await writeFile(join(sourceTree, "A-B.TXT"), "hidden ISO9660 collision\n");
  }
  execFileSync(SYNTHETIC_ISO_TOOL, [
    "-udf",
    ...(sourceHasJoliet ? ["-J"] : []),
    "-R",
    "-iso-level",
    "3",
    "-hide",
    join(sourceTree, "UDF-ONLY-MARKER.TXT"),
    ...sourceIsoHiddenPaths.flatMap((path) => [
      "-hide",
      join(sourceTree, path),
    ]),
    ...(sourceBootCatalogHidden
      ? ["-hide", join(sourceTree, "boot.catalog")]
      : []),
    "-o",
    sourceIsoPath,
    "-b",
    "boot/etfsboot.com",
    "-c",
    "boot.catalog",
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
    approvalIdentity: evidenceIdentity(sha256(approvalBytes)),
    approvalDigest: sha256(approvalBytes),
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
    sourceTree,
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

async function writeHiddenElToritoFixture(
  data,
  {
    biosPayload,
    uefiPayload,
    biosImageSector,
    uefiImageSector,
    biosLoadSectors,
    uefiLoadSectors,
    includeHiddenPayloads = true,
  } = {},
) {
  const sourcePath =
    data.sourcePaths[data.manifest.source.windowsMedia.identity];
  const source = await readFile(sourcePath);
  assert.equal(source.length % ISO_SECTOR_BYTES, 0);
  const boot = inspectBootableIso(source);
  assert.equal(boot.bootEntries.length, 2);
  const bios =
    biosPayload ??
    (await readFile(join(data.sourceTree, "boot", "etfsboot.com")));
  const uefi =
    uefiPayload ??
    (await readFile(
      join(data.sourceTree, "efi", "microsoft", "boot", "efisys.bin"),
    ));
  assert.equal(bios.length % EL_TORITO_VIRTUAL_SECTOR_BYTES, 0);
  assert.equal(uefi.length % EL_TORITO_VIRTUAL_SECTOR_BYTES, 0);

  const sourceSectors = source.length / ISO_SECTOR_BYTES;
  const firstHiddenSector = sourceSectors + 1;
  const hiddenBiosSector = biosImageSector ?? firstHiddenSector;
  const hiddenUefiSector =
    uefiImageSector ??
    hiddenBiosSector + Math.ceil(bios.length / ISO_SECTOR_BYTES);
  const requiredSectors = includeHiddenPayloads
    ? Math.max(
        sourceSectors + 257,
        hiddenBiosSector + Math.ceil(bios.length / ISO_SECTOR_BYTES),
        hiddenUefiSector + Math.ceil(uefi.length / ISO_SECTOR_BYTES),
      )
    : sourceSectors;
  const media = Buffer.alloc(requiredSectors * ISO_SECTOR_BYTES);
  source.copy(media);
  if (includeHiddenPayloads && hiddenBiosSector >= firstHiddenSector)
    bios.copy(media, hiddenBiosSector * ISO_SECTOR_BYTES);
  if (includeHiddenPayloads && hiddenUefiSector >= firstHiddenSector)
    uefi.copy(media, hiddenUefiSector * ISO_SECTOR_BYTES);
  if (includeHiddenPayloads) {
    const sourceLastSector = sourceSectors - 1;
    const sourceTrailingAnchor = sourceLastSector - 256;
    const trailingAnchor = requiredSectors - 1;
    const secondaryAnchor = trailingAnchor - 256;
    source.copy(
      media,
      secondaryAnchor * ISO_SECTOR_BYTES,
      sourceTrailingAnchor * ISO_SECTOR_BYTES,
      (sourceTrailingAnchor + 1) * ISO_SECTOR_BYTES,
    );
    source.copy(
      media,
      trailingAnchor * ISO_SECTOR_BYTES,
      sourceLastSector * ISO_SECTOR_BYTES,
      (sourceLastSector + 1) * ISO_SECTOR_BYTES,
    );
    for (const sector of [secondaryAnchor, trailingAnchor]) {
      const descriptor = media.subarray(
        sector * ISO_SECTOR_BYTES,
        (sector + 1) * ISO_SECTOR_BYTES,
      );
      descriptor.writeUInt32LE(sector, 12);
      rewriteUdfTag(descriptor);
    }
  }

  const catalog = boot.bootCatalogSector * ISO_SECTOR_BYTES;
  media.writeUInt16LE(
    biosLoadSectors ?? bios.length / EL_TORITO_VIRTUAL_SECTOR_BYTES,
    catalog + 38,
  );
  media.writeUInt32LE(hiddenBiosSector, catalog + 40);
  media.writeUInt16LE(
    uefiLoadSectors ?? uefi.length / EL_TORITO_VIRTUAL_SECTOR_BYTES,
    catalog + 64 + 32 + 6,
  );
  media.writeUInt32LE(hiddenUefiSector, catalog + 64 + 32 + 8);

  const path = join(data.root, "hidden-el-torito.iso");
  await writeFile(path, media);
  return path;
}

function inspectFixtureWindowsSetup(data, isoPath) {
  return inspectWindowsSetupIso({
    isoPath,
    expectedInstallImage: {
      index: data.manifest.source.installImageIndex,
      edition: data.manifest.source.installImageEdition,
      digest: data.manifest.source.installImageDigest,
    },
    udfExtractorPath: UDF_EXTRACTOR_PATH,
    udfExtractor: data.manifest.toolchain.udfExtractor,
    wimlibPath: WIMLIB_PATH,
    wimlib: data.manifest.toolchain.wimlib,
  });
}

async function writeVisibleElToritoCatalogFixture(
  data,
  { biosImagePath = "boot/etfsboot.com", biosLoadSectors } = {},
) {
  const sourcePath =
    data.sourcePaths[data.manifest.source.windowsMedia.identity];
  const media = Buffer.from(await readFile(sourcePath));
  const boot = inspectBootableIso(media);
  const image = inspectIsoFilesystemExtents(media).find(
    (entry) => entry.path.toLocaleLowerCase("en-US") === biosImagePath,
  );
  assert.ok(image, `fixture ISO9660 image exists: ${biosImagePath}`);
  const catalog = boot.bootCatalogSector * ISO_SECTOR_BYTES;
  media.writeUInt32LE(image.sector, catalog + 40);
  if (biosLoadSectors !== undefined)
    media.writeUInt16LE(biosLoadSectors, catalog + 38);
  const path = join(data.root, "visible-el-torito-catalog.iso");
  await writeFile(path, media);
  return path;
}

describe("real deterministic Factory ISO builder", () => {
  it("emits schema-valid disk layouts for the selected BIOS or UEFI target", () => {
    const uefi = factoryAutounattendXml("testbed", 4, "uefi", "Professional");
    assert.match(uefi, /<Type>EFI<\/Type><Size>260<\/Size>/);
    assert.match(uefi, /<Type>MSR<\/Type><Size>16<\/Size>/);
    assert.match(
      uefi,
      /<ModifyPartition[^>]*>.*<PartitionID>4<\/PartitionID>.*<TypeID>DE94BBA4-06D1-4D40-A16A-BFD50179D6AC<\/TypeID>.*<\/ModifyPartition>/,
    );
    assert.doesNotMatch(
      uefi,
      /<CreatePartition[^>]*>.*<TypeID>.*<\/CreatePartition>/,
    );
    assert.match(
      uefi,
      /<InstallTo><DiskID>0<\/DiskID><PartitionID>3<\/PartitionID>/,
    );

    const bios = factoryAutounattendXml("testbed", 4, "bios", "Professional");
    assert.match(bios, /<Active>true<\/Active>/);
    assert.match(
      bios,
      /<ModifyPartition[^>]*>.*<PartitionID>3<\/PartitionID>.*<TypeID>0x27<\/TypeID>.*<\/ModifyPartition>/,
    );
    assert.doesNotMatch(
      bios,
      /<CreatePartition[^>]*>.*<TypeID>.*<\/CreatePartition>/,
    );
    assert.match(
      bios,
      /<InstallTo><DiskID>0<\/DiskID><PartitionID>2<\/PartitionID>/,
    );
    assert.doesNotMatch(bios, /<Type>EFI<\/Type>|<Type>MSR<\/Type>|DE94BBA4/);
    assert.match(
      bios,
      /<ProductKey><Key>W269N-WFGWX-YVC9B-4J6C9-T83GX<\/Key><WillShowUI>OnError<\/WillShowUI><\/ProductKey>/,
    );
    assert.match(
      bios,
      /<settings pass="windowsPE">\s*<component name="Microsoft-Windows-International-Core-WinPE"[^>]*>\s*<SetupUILanguage><UILanguage>zh-CN<\/UILanguage><\/SetupUILanguage>\s*<InputLocale>zh-CN<\/InputLocale>\s*<SystemLocale>zh-CN<\/SystemLocale>\s*<UILanguage>zh-CN<\/UILanguage>\s*<UserLocale>zh-CN<\/UserLocale>\s*<\/component>/,
    );
    assert.match(bios, /<settings pass="specialize">/);
    assert.match(bios, /prepare-oobe-bootstrap\.ps1/);
    assert.match(bios, /<settings pass="oobeSystem">/);
    assert.match(
      bios,
      /<component name="Microsoft-Windows-International-Core"[^>]*>[\s\S]*?<InputLocale>zh-CN<\/InputLocale>[\s\S]*?<SystemLocale>zh-CN<\/SystemLocale>[\s\S]*?<UILanguage>zh-CN<\/UILanguage>[\s\S]*?<UserLocale>zh-CN<\/UserLocale>/,
    );
    for (const setting of [
      "HideEULAPage",
      "HideLocalAccountScreen",
      "HideOnlineAccountScreens",
      "HideWirelessSetupInOOBE",
    ]) {
      assert.match(bios, new RegExp(`<${setting}>true</${setting}>`));
    }
    assert.match(bios, /<UserAccounts>[\s\S]*?<Name>VEMOobeBootstrap<\/Name>/);
    assert.match(bios, /<Group>Users<\/Group>/);
    assert.doesNotMatch(bios, /SkipMachineOOBE|SkipUserOOBE/);
    assert.doesNotMatch(bios, /<AutoLogon>|<FirstLogonCommands>/);
    assert.doesNotMatch(bios, /YKDZ/);

    const production = factoryAutounattendXml(
      "production",
      4,
      "bios",
      "Professional",
    );
    assert.doesNotMatch(production, /<Name>Admin<\/Name>/);
    assert.doesNotMatch(production, /<Username>Admin<\/Username>/);
    assert.doesNotMatch(production, /YKDZ/);
    assert.match(production, /<Name>VEMOobeBootstrap<\/Name>/);
    assert.throws(
      () => factoryAutounattendXml("testbed", 4, "bios", "Enterprise"),
      /unsupported Factory Windows image edition/,
    );
    assert.throws(
      () => factoryAutounattendXml("testbed", 4, "bios", "toString"),
      /unsupported Factory Windows image edition/,
    );
  });

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

  it("selects the requested Windows IMAGE from wimlib XML containing every image", async () => {
    const data = await fixture();
    const fakeWimlib = join(data.root, "fake-wimlib-imagex");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WIM>
  <IMAGE INDEX="1"><NAME>Windows Home</NAME></IMAGE>
  <IMAGE INDEX="2"><EDITIONID>Core</EDITIONID></IMAGE>
  <IMAGE INDEX="3"><NAME>Windows Education</NAME></IMAGE>
  <IMAGE INDEX="4"><EDITIONID>Professional</EDITIONID><NAME>Windows Pro</NAME></IMAGE>
  <IMAGE INDEX="5"><NAME>Windows Enterprise</NAME></IMAGE>
  <IMAGE INDEX="6"><NAME>Windows Pro Education</NAME></IMAGE>
</WIM>`;
    await writeFile(fakeWimlib, `#!/bin/sh\ncat <<'XML'\n${xml}\nXML\n`, {
      mode: 0o755,
    });
    const wimlibBytes = await readFile(fakeWimlib);
    try {
      const inspect = (expectedInstallImage) =>
        inspectWindowsSetupIso({
          isoPath: data.sourcePaths[data.manifest.source.windowsMedia.identity],
          expectedInstallImage,
          udfExtractorPath: UDF_EXTRACTOR_PATH,
          udfExtractor: data.manifest.toolchain.udfExtractor,
          wimlibPath: fakeWimlib,
          wimlib: {
            identity: `tool://fixture@${sha256(wimlibBytes)}`,
            digest: sha256(wimlibBytes),
            version: "1.14.4",
          },
        });
      const result = await inspect({
        index: 4,
        edition: "Professional",
        digest: data.manifest.source.installImageDigest,
      });
      assert.equal(result.selectedImage.index, 4);
      assert.equal(result.selectedImage.edition, "Professional");
      await assert.rejects(
        inspect({
          index: 7,
          edition: "Professional",
          digest: data.manifest.source.installImageDigest,
        }),
        /selected Windows image index 7 does not exist/,
      );
      await assert.rejects(
        inspect({
          index: 4,
          edition: "Enterprise",
          digest: data.manifest.source.installImageDigest,
        }),
        /selected Windows image edition mismatch: expected Enterprise, got Professional/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("binds hidden El Torito images using BIOS 8x512 and UEFI 1x512 catalog load sizes", async () => {
    const data = await fixture({ uefiBootBytes: 4096 });
    try {
      assert.equal(
        (await stat(join(data.sourceTree, "boot", "etfsboot.com"))).size,
        8 * EL_TORITO_VIRTUAL_SECTOR_BYTES,
      );
      assert.equal(
        (
          await stat(
            join(data.sourceTree, "efi", "microsoft", "boot", "efisys.bin"),
          )
        ).size,
        8 * EL_TORITO_VIRTUAL_SECTOR_BYTES,
      );
      const inspect = await inspectFixtureWindowsSetup(
        data,
        await writeHiddenElToritoFixture(data, { uefiLoadSectors: 1 }),
      );
      assert.deepEqual(
        inspect.bootCatalog.map(({ platform, isoEntry, loadSize }) => ({
          platform,
          isoEntry,
          loadSize,
        })),
        [
          {
            platform: "BIOS",
            isoEntry: "boot/etfsboot.com",
            loadSize: 8,
          },
          {
            platform: "UEFI",
            isoEntry: "efi/microsoft/boot/efisys.bin",
            loadSize: 1,
          },
        ],
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a visible El Torito extent that is not the platform canonical boot file", async () => {
    const data = await fixture();
    try {
      await assert.rejects(
        inspectFixtureWindowsSetup(
          data,
          await writeVisibleElToritoCatalogFixture(data, {
            biosImagePath: "other/boot.wim",
          }),
        ),
        /El Torito catalog image LBA .* maps to noncanonical ISO9660 file other\/boot\.wim/i,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a visible El Torito image whose catalog load size exceeds its canonical file", async () => {
    const data = await fixture();
    try {
      await assert.rejects(
        inspectFixtureWindowsSetup(
          data,
          await writeVisibleElToritoCatalogFixture(data, {
            biosLoadSectors: 9,
          }),
        ),
        /El Torito catalog image LBA .* does not match extracted boot\/etfsboot\.com/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a hidden El Torito image whose complete canonical boot file differs", async () => {
    const data = await fixture();
    try {
      const bios = Buffer.from(
        await readFile(join(data.sourceTree, "boot", "etfsboot.com")),
      );
      bios[bios.length - 1] ^= 0xff;
      await assert.rejects(
        inspectFixtureWindowsSetup(
          data,
          await writeHiddenElToritoFixture(data, { biosPayload: bios }),
        ),
        /El Torito catalog image LBA .* does not match extracted boot\/etfsboot\.com/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a hidden UEFI El Torito image changed beyond its catalog load size", async () => {
    const data = await fixture({ uefiBootBytes: 4096 });
    try {
      const uefi = Buffer.from(
        await readFile(
          join(data.sourceTree, "efi", "microsoft", "boot", "efisys.bin"),
        ),
      );
      uefi[EL_TORITO_VIRTUAL_SECTOR_BYTES] ^= 0xff;
      await assert.rejects(
        inspectFixtureWindowsSetup(
          data,
          await writeHiddenElToritoFixture(data, {
            uefiPayload: uefi,
            uefiLoadSectors: 1,
          }),
        ),
        /El Torito catalog image LBA .* does not match extracted efi\/microsoft\/boot\/efisys\.bin/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a hidden El Torito image that extends beyond the ISO boundary", async () => {
    const data = await fixture();
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const sourceSectors = (await stat(sourcePath)).size / ISO_SECTOR_BYTES;
      await assert.rejects(
        inspectFixtureWindowsSetup(
          data,
          await writeHiddenElToritoFixture(data, {
            biosImageSector: sourceSectors,
            uefiImageSector: sourceSectors,
            includeHiddenPayloads: false,
          }),
        ),
        /El Torito catalog image LBA .* does not match extracted boot\/etfsboot\.com/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a hidden El Torito image whose catalog load size exceeds its canonical file", async () => {
    const data = await fixture();
    try {
      await assert.rejects(
        inspectFixtureWindowsSetup(
          data,
          await writeHiddenElToritoFixture(data, { biosLoadSectors: 9 }),
        ),
        /El Torito catalog image LBA .* does not match extracted boot\/etfsboot\.com/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a hidden El Torito image from the other platform's canonical path", async () => {
    const data = await fixture();
    try {
      const uefi = await readFile(
        join(data.sourceTree, "efi", "microsoft", "boot", "efisys.bin"),
      );
      await assert.rejects(
        inspectFixtureWindowsSetup(
          data,
          await writeHiddenElToritoFixture(data, { biosPayload: uefi }),
        ),
        /El Torito catalog image LBA .* does not match extracted boot\/etfsboot\.com/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
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
        "specialize SYSTEM Factory bootstrap with kiosk-logon cleanup",
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
      assert.doesNotMatch(unattended, /private.?key|credential/i);
      assert.deepEqual(
        [...unattended.matchAll(/<Password><Value>([^<]+)<\/Value>/g)].map(
          (match) => match[1],
        ),
        ["VEM-Factory-OOBE-v1!"],
        "Factory unattended media may embed only the disposable OOBE bootstrap password",
      );
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
      const baselineScript = await readFile(
        join(
          directory,
          "sources",
          "$OEM$",
          "$1",
          "VEM",
          "Factory",
          "install-factory-baseline.ps1",
        ),
        "utf8",
      );
      assert.match(baselineScript, /New-LocalUser[^\n]+accounts\.maintenance/);
      assert.match(baselineScript, /S-1-5-32-544/);
      assert.match(
        baselineScript,
        /Add-LocalGroupMember[^\n]+accounts\.maintenance/,
      );
      assert.match(
        baselineScript,
        /if \(-not \(Test-Path -LiteralPath \$windowsUpdatePolicyPath -PathType Container\)\) \{[\s\S]+New-Item -Path \$windowsUpdatePolicyPath[\s\S]+\}[\s\S]+Set-ItemProperty -Path \$windowsUpdatePolicyPath -Name NoAutoUpdate/,
      );
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
          "DeploymentBatch",
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
      assert.match(
        bootstrap,
        /\$LASTEXITCODE -ne 0[\s\S]+Factory runtime verifier failed/,
      );
      assert.doesNotMatch(bootstrap, /provision-vision-factory-release\.ps1/);
      assert.doesNotMatch(bootstrap, /install-vision-release\.ps1/);
      assert.match(unattended, /RunSynchronous/);
      assert.match(unattended, /prepare-oobe-bootstrap\.ps1/);
      assert.doesNotMatch(unattended, /VemFactoryBootstrap/);
      assert.doesNotMatch(bootstrap, /ingest-host-personalization\.ps1/);
      assert.match(bootstrap, /Write-Status 'succeeded'/);
      assert.match(
        bootstrap,
        /catch \{[\s\S]+AutoAdminLogon[\s\S]+ForceAutoLogon[\s\S]+DefaultPassword[\s\S]+AutoLogonCount/,
      );
      assert.doesNotMatch(bootstrap, /Restart-Computer|FirstLogonCommands/);
      const prepareOobe = await readFile(
        join(
          directory,
          "sources",
          "$OEM$",
          "$1",
          "VEM",
          "Factory",
          "prepare-oobe-bootstrap.ps1",
        ),
        "utf8",
      );
      assert.match(prepareOobe, /ingest-host-personalization\.ps1/);
      assert.match(prepareOobe, /one-time-personalization\.json/);
      assert.match(prepareOobe, /credentials\.bootstrap/);
      assert.match(prepareOobe, /-cne 'YKDZ'/);
      assert.doesNotMatch(prepareOobe, /oobe-unattend\.xml/);
      assert.doesNotMatch(prepareOobe, /<unattend|UnattendFile|Panther/i);
      assert.doesNotMatch(prepareOobe, /<AutoLogon>|<UserAccounts>/);
      assert.doesNotMatch(
        prepareOobe,
        /<FirstLogonCommands>|RequiresUserInput/,
      );
      assert.ok(prepareOobe.includes("^[\\x20-\\x7E]+$"));
      assert.match(prepareOobe, /bootstrap-factory-runtime\.ps1/);
      assert.match(prepareOobe, /VEMFactoryOobeCleanup/);
      assert.match(prepareOobe, /oobe-bootstrap-status\.json/);
      assert.match(prepareOobe, /'ingest-personalization'/);
      assert.match(prepareOobe, /'suppress-oobe-privacy'/);
      assert.match(prepareOobe, /DisablePrivacyExperience/);
      assert.match(prepareOobe, /PrivacyConsentStatus/);
      assert.match(
        prepareOobe,
        /Test-Path -LiteralPath \$oobeStatePath -PathType Container/,
      );
      assert.doesNotMatch(
        prepareOobe,
        /\$oobeStatePath\s*=.*\n\s*New-Item -Path \$oobeStatePath/,
      );
      assert.match(prepareOobe, /'bootstrap-runtime'/);
      assert.match(prepareOobe, /Write-BootstrapStatus 'failed'/);
      assert.doesNotMatch(
        prepareOobe,
        /Exception\.Message|ScriptStackTrace|FullyQualifiedErrorId|errorId/,
      );
      assert.match(prepareOobe, /New-ScheduledTaskTrigger -AtStartup/);
      assert.match(
        prepareOobe,
        /Write-BootstrapStatus 'succeeded' 'complete'[\s\S]+Start-ScheduledTask -TaskName 'VEMFactoryOobeCleanup'/,
      );
      assert.match(
        prepareOobe,
        /catch \{[\s\S]+Remove-Item[^\n]+\$personalizationPath/,
      );
      assert.match(
        prepareOobe,
        /catch \{[\s\S]+AutoAdminLogon[\s\S]+ForceAutoLogon[\s\S]+DefaultPassword[\s\S]+AutoLogonCount/,
      );
      assert.match(
        prepareOobe,
        /Unregister-ScheduledTask[^\n]+VEMFactoryOobeCleanup/,
      );
      const completeOobe = await readFile(
        join(
          directory,
          "sources",
          "$OEM$",
          "$1",
          "VEM",
          "Factory",
          "complete-oobe-bootstrap.ps1",
        ),
        "utf8",
      );
      assert.match(completeOobe, /Remove-ItemProperty[^\n]+AutoLogonCount/);
      assert.match(
        completeOobe,
        /DefaultUserName -Value 'VEMKiosk'[\s\S]+DefaultDomainName -Value \$env:COMPUTERNAME/,
      );
      assert.match(completeOobe, /Write-CleanupStatus 'autologon-restored'/);
      assert.match(completeOobe, /Remove-LocalUser[^\n]+VEMOobeBootstrap/);
      assert.match(completeOobe, /AddMinutes\(30\)/);
      assert.match(completeOobe, /OOBEInProgress/);
      assert.match(completeOobe, /SystemSetupInProgress/);
      assert.match(completeOobe, /Get-LocalUser -Name 'VEMOobeBootstrap'/);
      assert.match(completeOobe, /vem-factory-oobe-cleanup-status\/v1/);
      assert.match(
        completeOobe,
        /Write-CleanupStatus 'ready'[\s\S]+Write-CleanupStatus 'autologon-restored'[\s\S]+Remove-LocalUser[\s\S]+Write-CleanupStatus 'account-removed'/,
      );
      assert.match(completeOobe, /Write-CleanupStatus 'media-ejected'/);
      assert.match(completeOobe, /Write-CleanupStatus 'complete'/);
      assert.match(
        completeOobe,
        /if \(-not \$oobeComplete\) \{ throw 'VEM Factory OOBE did not complete before cleanup deadline' \}[\s\S]+Remove-LocalUser/,
      );
      assert.doesNotMatch(completeOobe, /UnattendFile|Panther/i);
      assert.match(completeOobe, /VEM_PERSONALIZATION/);
      assert.match(completeOobe, /InvokeVerb\('Eject'\)/);
      assert.match(completeOobe, /attempt -lt 30/);
      assert.match(
        completeOobe,
        /medium remains mounted after cleanup retries/,
      );
      assert.match(completeOobe, /Unregister-ScheduledTask/);
      assert.match(
        completeOobe,
        /throw 'VEM Factory OOBE cleanup task remains registered'/,
      );
      const ingestScript = join(
        directory,
        "sources",
        "$OEM$",
        "$1",
        "VEM",
        "Factory",
        "ingest-host-personalization.ps1",
      );
      const ingest = await readFile(ingestScript, "utf8");
      assert.match(ingest, /VEM_PERSONALIZATION/);
      assert.match(ingest, /\[IO\.DriveInfo\]::GetDrives\(\)/);
      assert.match(ingest, /\[IO\.DriveType\]::CDRom/);
      assert.match(ingest, /Copy-Item -LiteralPath \$sourcePath/);
      assert.doesNotMatch(ingest, /Get-Volume|Get-Partition|Get-Disk/);
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

  it("specializes production runtime scripts without embedding the testbed account literal", async () => {
    const source = 'Get-LocalUser -Name "YKDZ"; "reject YKDZ"';
    const production = factoryProfileImplementationScript(
      source,
      "production",
    ).toString("utf8");
    assert.doesNotMatch(production, /YKDZ/);
    assert.match(production, /YK\$\(\[char\]68\)Z/);
    assert.equal(
      factoryProfileImplementationScript(source, "testbed").toString("utf8"),
      source,
    );
    for (const name of [
      "prepare-factory-runtime.ps1",
      "setup-scheduled-tasks.ps1",
      "verify-factory-runtime.ps1",
    ]) {
      const specialized = factoryProfileImplementationScript(
        await readFile(new URL(`../windows/${name}`, import.meta.url)),
        "production",
      ).toString("utf8");
      assert.doesNotMatch(specialized, /YKDZ/);
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

  it("passes -allow-limited-size to the serviced ISO writer for Windows install.wim rebuilds", async () => {
    const data = await fixture();
    try {
      const writerLogPath = join(data.root, "writer-args.json");
      const fakeWriterPath = join(data.root, "recording-udf-writer");
      await writeFile(
        fakeWriterPath,
        `#!${process.execPath}
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const realWriter = ${JSON.stringify(UDF_WRITER_PATH)};
const logPath = ${JSON.stringify(writerLogPath)};
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("genisoimage ${PINNED_UDF_WRITER_VERSION}\\n");
  process.exit(0);
}

writeFileSync(logPath, JSON.stringify(args));
const stageDirectory = args.at(-1);
const installImagePath = join(stageDirectory, "sources", "install.wim");
const hasInstallImage = statSync(installImagePath).isFile();
if (hasInstallImage && !args.includes("-allow-limited-size")) {
  process.stderr.write(
    "missing -allow-limited-size for Windows install.wim limited-size contract\\n",
  );
  process.exit(91);
}

const result = spawnSync(realWriter, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 0);
`,
        { mode: 0o755 },
      );
      const fakeWriterBytes = await readFile(fakeWriterPath);
      const manifest = createFactoryManifest({
        ...data.manifest,
        toolchain: {
          ...data.manifest.toolchain,
          udfWriter: {
            identity: `tool://genisoimage-test@${sha256(fakeWriterBytes)}`,
            digest: sha256(fakeWriterBytes),
            version: PINNED_UDF_WRITER_VERSION,
          },
        },
      });

      await buildFactoryMedia({
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
        udfWriterPath: fakeWriterPath,
        wimlibPath: WIMLIB_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "output"),
        reproducibility: false,
      });

      const writerArgs = JSON.parse(await readFile(writerLogPath, "utf8"));
      const isoLevelIndex = writerArgs.indexOf("-iso-level");
      assert.notEqual(isoLevelIndex, -1);
      assert.equal(writerArgs[isoLevelIndex + 1], "3");
      assert.equal(writerArgs[isoLevelIndex + 2], "-allow-limited-size");
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("replays an ISO9660 and Joliet README missing from the UDF extraction without duplicating an overlay replacement", async () => {
    const data = await fixture({
      sourceIsoVisibleReadme: true,
      sourceOverlayReplacement: true,
    });
    const extractor = join(data.root, "extractor-without-source-readme");
    const sourceDigest = data.manifest.source.windowsMedia.digest.slice(7);
    try {
      await writeFile(
        extractor,
        `#!${process.execPath}
const { createHash } = require("node:crypto");
const { readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(UDF_EXTRACTOR_PATH)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
if (args[0] === "x") {
  const output = args.find((arg) => arg.startsWith("-o"))?.slice(2);
  const input = args.at(-1);
  const digest = createHash("sha256").update(readFileSync(input)).digest("hex");
  if (digest === ${JSON.stringify(sourceDigest)}) rmSync(join(output, "README.TXT"), { force: true });
}
`,
        { mode: 0o755 },
      );
      const extractorBytes = await readFile(extractor);
      const manifest = createFactoryManifest({
        ...data.manifest,
        toolchain: {
          ...data.manifest.toolchain,
          udfExtractor: {
            identity: `tool://fixture@${sha256(extractorBytes)}`,
            digest: sha256(extractorBytes),
            version: data.manifest.toolchain.udfExtractor.version,
          },
        },
      });
      const sourcePath =
        data.sourcePaths[manifest.source.windowsMedia.identity];
      const sourceViews = inspectIsoFilesystemViews(await readFile(sourcePath));
      assert.equal(sourceViews.iso9660.includes("readme.txt"), true);
      assert.equal(sourceViews.joliet.includes("readme.txt"), true);

      const sourceUdf = join(data.root, "source-udf-without-readme");
      execFileSync(extractor, [
        "x",
        "-y",
        "-tUdf",
        `-o${sourceUdf}`,
        sourcePath,
      ]);
      await assert.rejects(stat(join(sourceUdf, "README.TXT")), /ENOENT/);

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
        udfExtractorPath: extractor,
        udfWriterPath: UDF_WRITER_PATH,
        wimlibPath: WIMLIB_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "output"),
        reproducibility: false,
      });
      const outputViews = inspectIsoFilesystemViews(
        await readFile(result.output.path),
      );
      assert.equal(outputViews.iso9660.includes("readme.txt"), true);
      assert.equal(outputViews.joliet.includes("readme.txt"), true);
      assert.equal(
        outputViews.iso9660.filter((path) => path === "readme.txt").length,
        1,
      );
      assert.equal(
        outputViews.iso9660.filter((path) => path === "autounattend.xml")
          .length,
        1,
      );

      const outputUdf = join(data.root, "output-udf");
      execFileSync(UDF_EXTRACTOR_PATH, [
        "x",
        "-y",
        "-tUdf",
        `-o${outputUdf}`,
        result.output.path,
      ]);
      assert.equal(
        await readFile(join(outputUdf, "README.TXT"), "utf8"),
        "ISO-visible README replay fixture\n",
      );
      assert.match(
        await readFile(join(outputUdf, "Autounattend.xml"), "utf8"),
        /<unattend xmlns="urn:schemas-microsoft-com:unattend">/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("accepts the generated El Torito catalog when source and output UDF views omit its placeholder", async () => {
    const data = await fixture();
    const extractor = join(data.root, "extractor-without-boot-catalog");
    try {
      await writeFile(
        extractor,
        `#!${process.execPath}
const { rmSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(UDF_EXTRACTOR_PATH)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
if (args[0] === "x") {
  const output = args.find((arg) => arg.startsWith("-o"))?.slice(2);
  rmSync(join(output, "boot.catalog"), { force: true });
}
`,
        { mode: 0o755 },
      );
      const extractorBytes = await readFile(extractor);
      const manifest = createFactoryManifest({
        ...data.manifest,
        toolchain: {
          ...data.manifest.toolchain,
          udfExtractor: {
            identity: `tool://fixture@${sha256(extractorBytes)}`,
            digest: sha256(extractorBytes),
            version: data.manifest.toolchain.udfExtractor.version,
          },
        },
      });
      const sourcePath =
        data.sourcePaths[manifest.source.windowsMedia.identity];
      const sourceUdf = join(data.root, "source-udf-without-boot-catalog");
      execFileSync(extractor, [
        "x",
        "-y",
        "-tUdf",
        `-o${sourceUdf}`,
        sourcePath,
      ]);
      await assert.rejects(stat(join(sourceUdf, "boot.catalog")), /ENOENT/);

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
        udfExtractorPath: extractor,
        udfWriterPath: UDF_WRITER_PATH,
        wimlibPath: WIMLIB_PATH,
        executedBuilderImage: data.builderImage.identity,
        outputDirectory: join(data.root, "output"),
        reproducibility: false,
      });
      const outputUdf = join(data.root, "output-udf-without-boot-catalog");
      execFileSync(extractor, [
        "x",
        "-y",
        "-tUdf",
        `-o${outputUdf}`,
        result.output.path,
      ]);
      await assert.rejects(stat(join(outputUdf, "boot.catalog")), /ENOENT/);
      assert.deepEqual(
        (await inspectBootableIsoFile(result.output.path)).bootEntries.map(
          ({ platform, loadSegment, loadSize }) => ({
            platform,
            loadSegment,
            loadSize,
          }),
        ),
        [
          { platform: "BIOS", loadSegment: "0x0000", loadSize: 8 },
          { platform: "UEFI", loadSegment: "0x0000", loadSize: 4 },
        ],
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting ISO9660 and Joliet content for one missing canonical UDF path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-factory-visible-conflict-"));
    try {
      const sourceIsoPath = join(root, "source.iso");
      const sourceTreeRoot = join(root, "udf");
      await writeFile(
        sourceIsoPath,
        Buffer.concat([
          Buffer.from("iso"),
          Buffer.alloc(2045),
          Buffer.from("udf"),
        ]),
      );
      await mkdir(sourceTreeRoot);
      await assert.rejects(
        replaySourceVisibleFilesAbsentFromUdf({
          sourceTree: { root: sourceTreeRoot, entries: new Map() },
          sourceIsoPath,
          views: [
            {
              label: "ISO9660",
              extents: new Map([
                [
                  "readme.txt",
                  {
                    path: "README.TXT",
                    bytes: 3,
                    sector: 0,
                    segments: [{ sector: 0, bytes: 3 }],
                  },
                ],
              ]),
            },
            {
              label: "Joliet",
              extents: new Map([
                [
                  "readme.txt",
                  {
                    path: "README.TXT",
                    bytes: 3,
                    sector: 1,
                    segments: [{ sector: 1, bytes: 3 }],
                  },
                ],
              ]),
            },
          ],
        }),
        /ISO9660 and Joliet visible source content conflicts at canonical path readme\.txt/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes every source extent byte when the destination accepts partial writes", async () => {
    const hash = createHash("sha256");
    const writes = [];
    const bytes = Buffer.from("partial-write-source-extent");
    const output = {
      async write(buffer, offset, length, position) {
        const bytesWritten = Math.min(3, length);
        writes.push({
          bytes: Buffer.from(buffer.subarray(offset, offset + bytesWritten)),
          position,
        });
        return { bytesWritten };
      },
    };
    assert.equal(
      await writeSourceReplayBytes({ output, bytes, position: 17, hash }),
      bytes.length,
    );
    assert.deepEqual(
      writes.map(({ bytes: chunk, position }) => ({
        bytes: chunk.toString("utf8"),
        position,
      })),
      [
        { bytes: "par", position: 17 },
        { bytes: "tia", position: 20 },
        { bytes: "l-w", position: 23 },
        { bytes: "rit", position: 26 },
        { bytes: "e-s", position: 29 },
        { bytes: "our", position: 32 },
        { bytes: "ce-", position: 35 },
        { bytes: "ext", position: 38 },
        { bytes: "ent", position: 41 },
      ],
    );
    assert.equal(`sha256:${hash.digest("hex")}`, sha256(bytes));
  });

  it("rejects a missing ISO9660 file whose canonical path is a UDF directory", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "vem-factory-visible-directory-"),
    );
    try {
      const sourceTreeRoot = join(root, "udf");
      await mkdir(join(sourceTreeRoot, "README.TXT"), { recursive: true });
      await assert.rejects(
        replaySourceVisibleFilesAbsentFromUdf({
          sourceTree: {
            root: sourceTreeRoot,
            entries: new Map([
              [
                "readme.txt",
                {
                  path: "README.TXT",
                  type: "directory",
                },
              ],
            ]),
          },
          sourceIsoPath: join(root, "unused.iso"),
          views: [
            {
              label: "ISO9660",
              extents: new Map([
                [
                  "readme.txt",
                  {
                    path: "README.TXT",
                    bytes: 1,
                    sector: 0,
                    segments: [{ sector: 0, bytes: 1 }],
                  },
                ],
              ]),
            },
          ],
        }),
        /ISO9660 visible source file conflicts with UDF directory: README\.TXT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a visible ISO9660 extent that differs from its existing UDF file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-factory-visible-drift-"));
    try {
      const sourceIsoPath = join(root, "source.iso");
      const sourceTreeRoot = join(root, "udf");
      const readme = join(sourceTreeRoot, "README.TXT");
      await mkdir(sourceTreeRoot);
      await writeFile(sourceIsoPath, Buffer.from("source\0"));
      await writeFile(readme, "udf\0\0\0");
      await assert.rejects(
        replaySourceVisibleFilesAbsentFromUdf({
          sourceTree: {
            root: sourceTreeRoot,
            entries: new Map([
              [
                "readme.txt",
                { path: "README.TXT", absolute: readme, type: "file" },
              ],
            ]),
          },
          sourceIsoPath,
          views: [
            {
              label: "ISO9660",
              extents: new Map([
                [
                  "readme.txt",
                  {
                    path: "README.TXT",
                    bytes: 6,
                    sector: 0,
                    segments: [{ sector: 0, bytes: 6 }],
                  },
                ],
              ]),
            },
          ],
        }),
        /ISO9660 visible source file does not match UDF file: README\.TXT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects source-only ISO9660 replay before writing beyond file, byte, or depth limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-factory-replay-limits-"));
    try {
      const sourceTree = { root, entries: new Map() };
      const entry = (path, bytes = 0) => ({
        path,
        bytes,
        sector: 0,
        segments: [{ sector: 0, bytes }],
      });
      const cases = [
        [
          "file",
          new Map(
            Array.from({ length: 4097 }, (_, index) => [
              `file-${index}.txt`,
              entry(`file-${index}.txt`),
            ]),
          ),
          /source-only ISO9660 replay exceeds file limit/,
        ],
        [
          "bytes",
          new Map([["large.bin", entry("large.bin", 16 * 1024 ** 3 + 1)]]),
          /source-only ISO9660 replay exceeds byte limit/,
        ],
        [
          "depth",
          new Map([
            ["deep.txt", entry(`${Array(65).fill("deep").join("/")}/file.txt`)],
          ]),
          /source-only ISO9660 replay exceeds path depth limit/,
        ],
      ];
      for (const [, extents, expected] of cases) {
        await assert.rejects(
          replaySourceVisibleFilesAbsentFromUdf({
            sourceTree,
            sourceIsoPath: join(root, "unused.iso"),
            views: [{ label: "ISO9660", extents }],
          }),
          expected,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses existing UDF directory casing for nested ISO9660-only replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-factory-replay-casing-"));
    try {
      const sourceTreeRoot = join(root, "udf");
      const sourceIsoPath = join(root, "source.iso");
      await mkdir(join(sourceTreeRoot, "Sources", "Nested"), {
        recursive: true,
      });
      await writeFile(sourceIsoPath, "README");
      const replayed = await replaySourceVisibleFilesAbsentFromUdf({
        sourceTree: { root: sourceTreeRoot, entries: new Map() },
        sourceIsoPath,
        views: [
          {
            label: "ISO9660",
            extents: new Map([
              [
                "sources/nested/readme.txt",
                {
                  path: "SOURCES/NESTED/README.TXT",
                  bytes: 6,
                  sector: 0,
                  segments: [{ sector: 0, bytes: 6 }],
                },
              ],
            ]),
          },
        ],
      });
      assert.ok(replayed.entries.has("sources/nested/readme.txt"));
      assert.equal(
        await readFile(
          join(sourceTreeRoot, "Sources", "Nested", "README.TXT"),
          "utf8",
        ),
        "README",
      );
      await assert.rejects(stat(join(sourceTreeRoot, "SOURCES")), /ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an ISO9660-only path when an existing UDF segment is a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-factory-replay-file-"));
    try {
      const sourceTreeRoot = join(root, "udf");
      const sourceIsoPath = join(root, "source.iso");
      await mkdir(sourceTreeRoot);
      await writeFile(join(sourceTreeRoot, "Sources"), "not a directory");
      await writeFile(sourceIsoPath, "README");
      await assert.rejects(
        replaySourceVisibleFilesAbsentFromUdf({
          sourceTree: { root: sourceTreeRoot, entries: new Map() },
          sourceIsoPath,
          views: [
            {
              label: "ISO9660",
              extents: new Map([
                [
                  "sources/readme.txt",
                  {
                    path: "SOURCES/README.TXT",
                    bytes: 6,
                    sector: 0,
                    segments: [{ sector: 0, bytes: 6 }],
                  },
                ],
              ]),
            },
          ],
        }),
        /ISO9660 visible source path conflicts with UDF file: SOURCES\/README\.TXT/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays a source marker through canonical ISO9660, Joliet, and explicit UDF views", async () => {
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
        ["l", "-slt", "-tUdf", sourcePath],
        {
          encoding: "utf8",
        },
      );
      assert.match(sourceListing, /Type = Udf/);
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
        ["l", "-slt", "-tUdf", result.output.path],
        {
          encoding: "utf8",
        },
      );
      assert.match(outputListing, /Type = Udf/);
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

  it("preserves hidden ISO9660 paths with absolute patterns without hiding another basename", async () => {
    const data = await fixture({
      sourceHasJoliet: false,
      sourceIsoHiddenPaths: ["sources/boot.wim"],
      sourceBootCatalogHidden: true,
    });
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const sourceViews = inspectIsoFilesystemViews(await readFile(sourcePath));
      assert.equal(sourceViews.joliet.length, 0);
      assert.equal(sourceViews.iso9660.includes("sources/boot.wim"), false);
      assert.equal(sourceViews.iso9660.includes("other/boot.wim"), true);
      assert.equal(sourceViews.iso9660.includes("boot.catalog"), false);

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
      const outputViews = inspectIsoFilesystemViews(
        await readFile(result.output.path),
      );
      assert.equal(outputViews.joliet.length, 0);
      assert.equal(outputViews.iso9660.includes("sources/boot.wim"), false);
      assert.equal(outputViews.iso9660.includes("other/boot.wim"), true);
      assert.equal(outputViews.iso9660.includes("boot.catalog"), false);
      const outputListing = execFileSync(
        UDF_EXTRACTOR_PATH,
        ["l", "-slt", "-tUdf", result.output.path],
        { encoding: "utf8" },
      );
      assert.match(outputListing, /Path = sources\/boot\.wim/i);
      assert.match(outputListing, /Path = boot\.catalog/i);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a writer that drifts source ISO9660 visibility", async () => {
    const data = await fixture({
      sourceHasJoliet: false,
      sourceIsoHiddenPaths: ["A-B.TXT"],
      sourceIso9660Collision: true,
    });
    const writer = join(data.root, "writer-without-hide");
    try {
      await writeFile(
        writer,
        `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = [];
for (let index = 2; index < process.argv.length; index += 1) {
  if (["-hide", "-hide-joliet"].includes(process.argv[index])) {
    index += 1;
    continue;
  }
  args.push(process.argv[index]);
}
const result = spawnSync(${JSON.stringify(UDF_WRITER_PATH)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
        { mode: 0o755 },
      );
      const writerBytes = await readFile(writer);
      const manifest = createFactoryManifest({
        ...data.manifest,
        toolchain: {
          ...data.manifest.toolchain,
          udfWriter: {
            identity: `tool://fixture@${sha256(writerBytes)}`,
            digest: sha256(writerBytes),
            version: PINNED_UDF_WRITER_VERSION,
          },
        },
      });
      await assert.rejects(
        buildFactoryMedia({
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
          udfWriterPath: writer,
          wimlibPath: WIMLIB_PATH,
          executedBuilderImage: data.builderImage.identity,
          outputDirectory: join(data.root, "output"),
          reproducibility: false,
        }),
        /serviced ISO ISO9660 visibility file count mismatch:/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("preserves an exact A_B ISO9660 source path while hiding colliding A-B", async () => {
    const data = await fixture({
      sourceHasJoliet: false,
      sourceIsoHiddenPaths: ["A-B.TXT"],
      sourceIso9660Collision: true,
    });
    try {
      const sourcePath =
        data.sourcePaths[data.manifest.source.windowsMedia.identity];
      const sourceViews = inspectIsoFilesystemViews(await readFile(sourcePath));
      assert.equal(sourceViews.iso9660.includes("a_b.txt"), true);
      assert.equal(sourceViews.iso9660.includes("a_b000.txt"), false);

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
      const outputViews = inspectIsoFilesystemViews(
        await readFile(result.output.path),
      );
      assert.equal(outputViews.iso9660.includes("a_b.txt"), true);
      assert.equal(outputViews.iso9660.includes("a_b000.txt"), false);
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

  it("normalizes ISO9660 empty extensions after removing the version only", () => {
    assert.deepEqual(
      inspectIsoFilesystemExtents(iso9660EmptyExtensionFixture()).map(
        ({ path }) => path,
      ),
      ["README", "NOTICE.TXT"],
    );
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
    "validates the known real Windows ISO UDF Windows Setup tree and hidden El Torito images",
    { skip: !process.env.VEM_FACTORY_REAL_WINDOWS_ISO },
    async () => {
      const realIso = process.env.VEM_FACTORY_REAL_WINDOWS_ISO;
      const before = process.memoryUsage().rss;
      const structure = await inspectBootableIsoFile(realIso);
      const { media, close } = rangeBackedIsoMedia(realIso);
      let filesystemViews;
      try {
        filesystemViews = inspectIsoFilesystemViews(media);
      } finally {
        close();
      }
      const growth = process.memoryUsage().rss - before;
      assert.equal(structure.iso9660, true);
      assert.equal(structure.udf, true);
      assert.deepEqual(filesystemViews.iso9660, ["readme.txt"]);
      assert.deepEqual(filesystemViews.joliet, []);
      assert.ok(
        growth < 96 * 1024 * 1024,
        `real ISO inspection grew RSS by ${growth}`,
      );

      const probe = await mkdtemp(join(tmpdir(), "vem-real-windows-setup-"));
      try {
        execFileSync(UDF_EXTRACTOR_PATH, [
          "x",
          "-y",
          "-tUdf",
          `-o${probe}`,
          realIso,
          "sources/install.wim",
          "sources/install.esd",
        ]);
        let installImagePath;
        for (const candidate of [
          "sources/install.wim",
          "sources/install.esd",
        ]) {
          try {
            await stat(join(probe, candidate));
            installImagePath = join(probe, candidate);
            break;
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        assert.ok(installImagePath, "UDF view contains an install image");
        const expectedInstallImage = {
          ...expectedFirstWimImage(installImagePath),
          digest: await sha256File(installImagePath),
        };
        const udfExtractorBytes = await readFile(UDF_EXTRACTOR_PATH);
        const wimlibBytes = await readFile(WIMLIB_PATH);
        const setup = await inspectWindowsSetupIso({
          isoPath: realIso,
          expectedInstallImage,
          udfExtractorPath: UDF_EXTRACTOR_PATH,
          udfExtractor: {
            identity: `tool://7z@${sha256(udfExtractorBytes)}`,
            digest: sha256(udfExtractorBytes),
            version: `${sevenZipVersion(UDF_EXTRACTOR_PATH)
              .split(".")
              .map((part) => String(Number(part)))
              .join(".")}.0`,
          },
          wimlibPath: WIMLIB_PATH,
          wimlib: {
            identity: `tool://wimlib-imagex@${sha256(wimlibBytes)}`,
            digest: sha256(wimlibBytes),
            version: toolVersion(
              WIMLIB_PATH,
              ["--version"],
              /wimlib-imagex\s+([0-9.]+)/i,
              "wimlib-imagex",
            ),
          },
        });
        assert.ok(
          ["sources/install.wim", "sources/install.esd"].includes(
            setup.installImage.toLocaleLowerCase("en-US"),
          ),
          "Windows Setup inspector found the UDF install image",
        );
        assert.deepEqual(
          setup.bootCatalog.map(({ platform, isoEntry }) => ({
            platform,
            isoEntry: isoEntry.toLocaleLowerCase("en-US"),
          })),
          [
            { platform: "BIOS", isoEntry: "boot/etfsboot.com" },
            {
              platform: "UEFI",
              isoEntry: "efi/microsoft/boot/efisys.bin",
            },
          ],
          "Windows Setup inspector binds hidden El Torito images to canonical UDF files",
        );
      } finally {
        await rm(probe, { recursive: true, force: true });
      }
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

  it("passes the UDF archive type switch to extractor listing and extraction", async () => {
    const data = await fixture();
    try {
      const extractor = join(data.root, "udf-view-extractor");
      await writeFile(
        extractor,
        `#!/bin/sh
set -eu
case " $* " in
  *" -tUdf "*) ;;
  *) printf '%s\\n' 'missing required UDF archive type switch' >&2; exit 90 ;;
esac
exec ${JSON.stringify(UDF_EXTRACTOR_PATH)} "$@"
`,
        { mode: 0o755 },
      );
      const bytes = await readFile(extractor);
      await inspectWindowsSetupIso({
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
      });
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
