import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { canonicalJson, validateFactoryManifest } from "./factory-manifest.mjs";
import {
  verifyAssetEvidence,
  verifyAuthenticodeSignature,
} from "./verify-asset-evidence.mjs";

const run = promisify(execFile);
const FIXED_EPOCH_SECONDS = 315_532_800;
const SECTOR_BYTES = 2048;
const UDF_VOLUME_SET_ID = "VEM_FACTORY_SET";

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assetReferences(manifest) {
  return [manifest.source.windowsMedia, ...manifest.assets].sort(
    (left, right) => left.role.localeCompare(right.role),
  );
}

function outputName(manifest) {
  return manifest.outputPolicy.isoFileName.replace(
    "{manifestId}",
    manifest.manifestId.slice("sha256:".length),
  );
}

async function readPinnedExecutable(path, tool) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new Error("ISO builder must not be a symlink");
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || (fileStat.mode & 0o111) === 0) {
      throw new Error("ISO builder must be an executable regular file");
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length)
      throw new Error("ISO builder read was incomplete");
    const digest = hashBytes(bytes);
    if (digest !== tool.digest) {
      throw new Error(
        `executed ISO builder digest mismatch: expected ${tool.digest}, got ${digest}`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function bootImageBytes() {
  const bytes = Buffer.alloc(2048);
  bytes.set([0xfa, 0xeb, 0xfd], 0);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;
  return bytes;
}

async function setFixedTimes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await setFixedTimes(path);
    await utimes(path, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
  }
  await utimes(root, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
}

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
  }
  return crc;
}

function writeUdfDstring(target, offset, length, value) {
  target.fill(0, offset, offset + length);
  const encoded = Buffer.from(value, "ascii");
  if (encoded.length + 2 > length) throw new Error("UDF dstring is too long");
  target[offset] = 8;
  encoded.copy(target, offset + 1);
  target[offset + length - 1] = encoded.length + 1;
}

function normalizeUdfTimestamps(target, sectorOffset) {
  const crcLength = target.readUInt16LE(sectorOffset + 10);
  const end = sectorOffset + 16 + crcLength;
  let changed = false;
  for (let offset = sectorOffset + 16; offset + 12 <= end; offset += 1) {
    const year = target.readUInt16LE(offset + 2);
    const month = target[offset + 4];
    const day = target[offset + 5];
    const hour = target[offset + 6];
    const minute = target[offset + 7];
    const second = target[offset + 8];
    if (
      year < 1970 ||
      year > 2200 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 60
    ) {
      continue;
    }
    target.fill(0, offset, offset + 12);
    target.writeUInt16LE(0x1000, offset);
    target.writeUInt16LE(1980, offset + 2);
    target[offset + 4] = 1;
    target[offset + 5] = 1;
    changed = true;
    offset += 11;
  }
  return changed;
}

function updateUdfTag(target, sectorOffset) {
  const crcLength = target.readUInt16LE(sectorOffset + 10);
  const crcStart = sectorOffset + 16;
  if (crcLength < 1 || crcStart + crcLength > sectorOffset + SECTOR_BYTES) {
    throw new Error("invalid UDF descriptor CRC length");
  }
  target.writeUInt16LE(
    crc16(target.subarray(crcStart, crcStart + crcLength)),
    sectorOffset + 8,
  );
  target[sectorOffset + 4] = 0;
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4)
      checksum = (checksum + target[sectorOffset + index]) & 0xff;
  }
  target[sectorOffset + 4] = checksum;
}

export function normalizeUdfForReproducibility(media) {
  const normalized = Buffer.from(media);
  const fixedIsoTimestamp = Buffer.concat([
    Buffer.from("1980010100000000", "ascii"),
    Buffer.from([0]),
  ]);
  for (let sector = 16; sector < 32; sector += 1) {
    const offset = sector * SECTOR_BYTES;
    if (
      [1, 2].includes(normalized[offset]) &&
      normalized.toString("ascii", offset + 1, offset + 6) === "CD001"
    ) {
      for (const timestampOffset of [813, 830, 847, 864]) {
        fixedIsoTimestamp.copy(normalized, offset + timestampOffset);
      }
    }
  }
  let primaryDescriptors = 0;
  for (
    let sector = 32;
    sector * SECTOR_BYTES < normalized.length;
    sector += 1
  ) {
    const offset = sector * SECTOR_BYTES;
    const tagIdentifier = normalized.readUInt16LE(offset);
    const descriptorVersion = normalized.readUInt16LE(offset + 2);
    const tagLocation = normalized.readUInt32LE(offset + 12);
    if (![2, 3].includes(descriptorVersion) || tagLocation !== sector) continue;
    let changed = normalizeUdfTimestamps(normalized, offset);
    if (tagIdentifier === 1) {
      writeUdfDstring(normalized, offset + 72, 128, UDF_VOLUME_SET_ID);
      primaryDescriptors += 1;
      changed = true;
    }
    if (changed) updateUdfTag(normalized, offset);
  }
  if (primaryDescriptors !== 2) {
    throw new Error(
      `expected two UDF primary volume descriptors, found ${primaryDescriptors}`,
    );
  }
  return normalized;
}

function verifyUdfTag(media, sector) {
  const offset = sector * SECTOR_BYTES;
  const expectedChecksum = media[offset + 4];
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) checksum = (checksum + media[offset + index]) & 0xff;
  }
  if (checksum !== expectedChecksum)
    throw new Error("UDF descriptor tag checksum is invalid");
  const crcLength = media.readUInt16LE(offset + 10);
  const actualCrc = crc16(media.subarray(offset + 16, offset + 16 + crcLength));
  if (actualCrc !== media.readUInt16LE(offset + 8)) {
    throw new Error("UDF descriptor CRC is invalid");
  }
}

export function inspectBootableIso(media) {
  if (!Buffer.isBuffer(media) || media.length < 64 * SECTOR_BYTES) {
    throw new Error("Factory media is too small to be ISO9660/UDF");
  }
  const pvd = 16 * SECTOR_BYTES;
  if (
    media[pvd] !== 1 ||
    media.toString("ascii", pvd + 1, pvd + 6) !== "CD001"
  ) {
    throw new Error("ISO9660 primary volume descriptor is missing");
  }
  let bootRecord;
  for (let sector = 16; sector < 32; sector += 1) {
    const offset = sector * SECTOR_BYTES;
    if (
      media[offset] === 0 &&
      media.toString("ascii", offset + 1, offset + 6) === "CD001" &&
      media.toString("ascii", offset + 7, offset + 30).trim() ===
        "EL TORITO SPECIFICATION"
    ) {
      bootRecord = offset;
      break;
    }
  }
  if (bootRecord === undefined)
    throw new Error("El Torito boot record is missing");
  const catalogSector = media.readUInt32LE(bootRecord + 71);
  const catalog = catalogSector * SECTOR_BYTES;
  let catalogChecksum = 0;
  for (let offset = 0; offset < 32; offset += 2) {
    catalogChecksum =
      (catalogChecksum + media.readUInt16LE(catalog + offset)) & 0xffff;
  }
  if (
    media[catalog] !== 1 ||
    media[catalog + 30] !== 0x55 ||
    media[catalog + 31] !== 0xaa ||
    catalogChecksum !== 0 ||
    media[catalog + 32] !== 0x88 ||
    media.readUInt32LE(catalog + 40) === 0
  ) {
    throw new Error("El Torito boot catalog is invalid or not bootable");
  }
  let udfRecognition = false;
  for (
    let sector = 16;
    sector < Math.min(512, media.length / SECTOR_BYTES);
    sector += 1
  ) {
    const identifier = media.toString(
      "ascii",
      sector * SECTOR_BYTES + 1,
      sector * SECTOR_BYTES + 6,
    );
    if (identifier === "NSR02" || identifier === "NSR03") udfRecognition = true;
  }
  if (!udfRecognition)
    throw new Error("UDF volume recognition sequence is missing");
  const udfPrimarySectors = [];
  let verifiedUdfDescriptors = 0;
  for (let sector = 32; sector * SECTOR_BYTES < media.length; sector += 1) {
    const offset = sector * SECTOR_BYTES;
    const descriptorVersion = media.readUInt16LE(offset + 2);
    if (
      [2, 3].includes(descriptorVersion) &&
      media.readUInt32LE(offset + 12) === sector
    ) {
      verifyUdfTag(media, sector);
      verifiedUdfDescriptors += 1;
      if (media.readUInt16LE(offset) !== 1) continue;
      udfPrimarySectors.push(sector);
    }
  }
  if (udfPrimarySectors.length !== 2)
    throw new Error("UDF primary descriptors are incomplete");
  if (verifiedUdfDescriptors < 8)
    throw new Error("UDF descriptor sequence is incomplete");
  return {
    iso9660: true,
    udf: true,
    elTorito: true,
    bootable: true,
    bootCatalogSector: catalogSector,
  };
}

async function executeIsoBuilder({
  builderBytes,
  stageDirectory,
  outputPath,
  workDirectory,
}) {
  const executable = join(workDirectory, "iso-builder");
  await writeFile(executable, builderBytes, { mode: 0o555 });
  await run(
    executable,
    [
      "-quiet",
      "-udf",
      "-iso-level",
      "3",
      "-V",
      "VEM_FACTORY",
      "-volset",
      UDF_VOLUME_SET_ID,
      "-A",
      "VEM_FACTORY_ISSUE10",
      "-sysid",
      "VEM",
      "-b",
      "BOOT/BOOT.IMG",
      "-c",
      "BOOT/BOOT.CAT",
      "-no-emul-boot",
      "-boot-load-size",
      "4",
      "-o",
      outputPath,
      stageDirectory,
    ],
    {
      cwd: workDirectory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: workDirectory,
        LC_ALL: "C",
        TZ: "UTC",
        SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
      },
      maxBuffer: 1024 * 1024,
    },
  );
  const normalized = normalizeUdfForReproducibility(await readFile(outputPath));
  await writeFile(outputPath, normalized, { mode: 0o444 });
  const structure = inspectBootableIso(normalized);
  return { bytes: normalized, structure };
}

export async function createRedistributableFixtureIso({
  isoBuilderPath,
  isoBuilder,
  outputPath,
}) {
  const builderBytes = await readPinnedExecutable(isoBuilderPath, isoBuilder);
  const workDirectory = await mkdtemp(join(tmpdir(), "vem-iso-fixture-"));
  try {
    const stageDirectory = join(workDirectory, "stage");
    await mkdir(join(stageDirectory, "BOOT"), { recursive: true });
    await writeFile(join(stageDirectory, "BOOT", "BOOT.IMG"), bootImageBytes());
    await writeFile(
      join(stageDirectory, "README.TXT"),
      "Redistributable VEM Issue10 bootable ISO fixture. Not Windows installation media.\n",
    );
    await setFixedTimes(stageDirectory);
    const built = await executeIsoBuilder({
      builderBytes,
      stageDirectory,
      outputPath: join(workDirectory, "fixture.iso"),
      workDirectory,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, built.bytes, { mode: 0o444 });
    return {
      digest: hashBytes(built.bytes),
      bytes: built.bytes.length,
      structure: built.structure,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function resolveAssets({
  manifest,
  store,
  sourcePaths,
  sourceStoreRoot,
  evidenceStoreRoot,
  approvalPolicy,
  authenticodeVerifierPath,
  authenticodeCaBundlePath,
}) {
  const resolved = [];
  for (const reference of assetReferences(manifest)) {
    const sourcePath =
      sourcePaths?.[reference.identity] ??
      (reference.role === "windows-source-iso" && sourceStoreRoot
        ? join(sourceStoreRoot, "sha256", reference.digest.slice(7))
        : undefined);
    const resolution =
      reference.role === "windows-source-iso"
        ? await store.verifyUncached(reference, sourcePath)
        : await store.ensure(reference, sourcePath);
    let authenticodeVerification;
    if (reference.signature.scheme === "authenticode") {
      const verifier = manifest.toolchain.authenticodeVerifier;
      if (!verifier || !authenticodeVerifierPath || !authenticodeCaBundlePath) {
        throw new Error(
          "AuthentiCode assets require a pinned verifier and trusted CA bundle",
        );
      }
      const workDirectory = await mkdtemp(
        join(tmpdir(), "vem-authenticode-input-"),
      );
      try {
        const assetPath = join(workDirectory, "signed-asset.bin");
        if (reference.role === "windows-source-iso") {
          await store.stageUncachedVerified(reference, sourcePath, assetPath);
        } else {
          await store.stageVerified(reference, assetPath);
        }
        authenticodeVerification = await verifyAuthenticodeSignature({
          asset: reference,
          assetPath,
          verifierPath: authenticodeVerifierPath,
          verifierDigest: verifier.digest,
          caBundlePath: authenticodeCaBundlePath,
          approvedSignerIdentities: approvalPolicy.authenticodeSignerIdentities,
        });
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
    const verifiedEvidence = await verifyAssetEvidence({
      asset: reference,
      evidenceStoreRoot,
      approvalPolicy,
      authenticodeVerification,
    });
    resolved.push({ reference, resolution, sourcePath, verifiedEvidence });
  }
  return resolved;
}

async function stageBuildInputs({
  manifest,
  resolvedAssets,
  store,
  stageDirectory,
}) {
  await mkdir(join(stageDirectory, "BOOT"), { recursive: true });
  await mkdir(join(stageDirectory, "VEM", "ASSETS"), { recursive: true });
  await writeFile(join(stageDirectory, "BOOT", "BOOT.IMG"), bootImageBytes());
  await writeFile(
    join(stageDirectory, "VEM", "MANIFEST.JSON"),
    Buffer.from(canonicalJson(manifest)),
  );
  for (const asset of resolvedAssets) {
    const name =
      asset.reference.role === "windows-source-iso"
        ? "WINDOWS-SOURCE.ISO"
        : `${asset.reference.role.toUpperCase()}.BIN`;
    const destination = join(stageDirectory, "VEM", "ASSETS", name);
    if (asset.reference.role === "windows-source-iso") {
      await store.stageUncachedVerified(
        asset.reference,
        asset.sourcePath,
        destination,
      );
    } else {
      await store.stageVerified(asset.reference, destination);
    }
  }
  await setFixedTimes(stageDirectory);
}

function makeProvenance(
  manifest,
  resolvedAssets,
  output,
  reproducibility,
  structure,
) {
  const hits = resolvedAssets.filter(
    ({ resolution }) => resolution.status === "hit",
  ).length;
  const misses = resolvedAssets.filter(
    ({ resolution }) => resolution.status === "miss",
  ).length;
  return {
    schemaVersion: "vem-factory-provenance/v1",
    kind: "factory-media-provenance",
    manifest: {
      identity: manifest.manifestId,
      schemaVersion: manifest.schemaVersion,
      profile: manifest.profile,
    },
    inputs: resolvedAssets.map(
      ({ reference, resolution, verifiedEvidence }) => ({
        role: reference.role,
        identity: reference.identity,
        digest: reference.digest,
        version: reference.version,
        signature: verifiedEvidence.signature,
        provenance: verifiedEvidence.provenance,
        resolution: resolution.evidence,
      }),
    ),
    toolchain: {
      builderImage: { ...manifest.toolchain.builderImage, executed: true },
      isoBuilder: { ...manifest.toolchain.isoBuilder, executed: true },
      ...(manifest.toolchain.authenticodeVerifier
        ? {
            authenticodeVerifier: {
              ...manifest.toolchain.authenticodeVerifier,
              executed: resolvedAssets.some(
                ({ reference }) =>
                  reference.signature.scheme === "authenticode",
              ),
            },
          }
        : {}),
    },
    output: {
      identity: output.identity,
      digest: output.digest,
      fileName: output.fileName,
      bytes: output.bytes,
      structure,
      assemblyMode: manifest.outputPolicy.assemblyMode,
      windowsInstallerCustomized: false,
      requiresIssue15CustomizationAssets: true,
    },
    evidence: {
      cache: { hits, misses, entries: hits + misses },
      sourceMedia: { verified: 1, cached: false },
      deterministic: {
        ordering: "role-ascending",
        timestampEpoch: FIXED_EPOCH_SECONDS,
        udfVolumeSetIdentity: UDF_VOLUME_SET_ID,
      },
      policy: {
        sourceWindowsMediaUploaded: false,
        personalizationMediaUploaded: false,
        secretsCached: false,
        privateKeysCached: false,
        hostPathsIncluded: false,
      },
    },
    reproducibility,
  };
}

export async function buildFactoryMedia({
  manifest,
  store,
  sourcePaths,
  sourceStoreRoot,
  evidenceStoreRoot,
  approvalPolicy,
  isoBuilderPath,
  authenticodeVerifierPath,
  authenticodeCaBundlePath,
  executedBuilderImage,
  outputDirectory,
  reproducibility = false,
}) {
  const validatedManifest = validateFactoryManifest(manifest);
  if (!(store instanceof ContentAddressedAssetStore)) {
    throw new TypeError(
      "buildFactoryMedia requires a ContentAddressedAssetStore",
    );
  }
  if (
    executedBuilderImage !== validatedManifest.toolchain.builderImage.identity
  ) {
    throw new Error(
      "executed builder image does not exactly match the Factory Manifest",
    );
  }
  const builderBytes = await readPinnedExecutable(
    isoBuilderPath,
    validatedManifest.toolchain.isoBuilder,
  );
  const resolvedAssets = await resolveAssets({
    manifest: validatedManifest,
    store,
    sourcePaths,
    sourceStoreRoot,
    evidenceStoreRoot,
    approvalPolicy,
    authenticodeVerifierPath,
    authenticodeCaBundlePath,
  });
  const buildCount = reproducibility ? 2 : 1;
  const builds = [];
  for (let index = 0; index < buildCount; index += 1) {
    const workDirectory = await mkdtemp(
      join(tmpdir(), `vem-factory-build-${index + 1}-`),
    );
    try {
      const stageDirectory = join(workDirectory, "stage");
      await stageBuildInputs({
        manifest: validatedManifest,
        resolvedAssets,
        store,
        stageDirectory,
      });
      builds.push(
        await executeIsoBuilder({
          builderBytes,
          stageDirectory,
          outputPath: join(workDirectory, "factory.iso"),
          workDirectory,
        }),
      );
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
  const firstDigest = hashBytes(builds[0].bytes);
  const identical = builds.every(
    (build) =>
      hashBytes(build.bytes) === firstDigest &&
      build.bytes.equals(builds[0].bytes),
  );
  if (!identical) {
    const differences = [];
    const limit = Math.min(builds[0].bytes.length, builds[1].bytes.length);
    for (let index = 0; index < limit && differences.length < 12; index += 1) {
      if (builds[0].bytes[index] !== builds[1].bytes[index])
        differences.push(index);
    }
    throw new Error(
      `reproducibility check failed: Factory ISO output differs at byte offsets ${differences.join(",")}`,
    );
  }

  await mkdir(outputDirectory, { recursive: true });
  const fileName = outputName(validatedManifest);
  const outputPath = join(outputDirectory, fileName);
  await writeFile(outputPath, builds[0].bytes, { mode: 0o444 });
  const output = {
    role: "factory-iso",
    identity: `factory-cas://${firstDigest.replace(":", "/")}`,
    digest: firstDigest,
    fileName,
    bytes: builds[0].bytes.length,
    path: outputPath,
  };
  const reproducibilityEvidence = {
    mode: reproducibility ? "required" : "disabled",
    builds: buildCount,
    independentDirectories: true,
    independentProcesses: true,
    identical,
  };
  return {
    output,
    reproducibility: reproducibilityEvidence,
    provenance: makeProvenance(
      validatedManifest,
      resolvedAssets,
      output,
      reproducibilityEvidence,
      builds[0].structure,
    ),
  };
}
