import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expectedFactoryEffectiveInputRoles,
  currentFactoryEffectiveRepositoryInputs,
  inspectBootableIsoFile,
  inspectWindowsSetupIso,
  verifyPinnedFactoryTool,
} from "./build-factory-media.mjs";
import { canonicalJson, validateFactoryManifest } from "./factory-manifest.mjs";
import { validateFactoryEvidencePayload } from "./sanitize-build-evidence.mjs";

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readRegular(path, label) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error(`${label} must be a regular host-owned store file`);
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (bytesRead === 0)
        throw new Error(`${label} changed while it was being read`);
      position += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function snapshotAndHashRegular(path, label, snapshotPath) {
  const before = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let snapshot;
  try {
    const stat = await before.stat();
    if (!stat.isFile())
      throw new Error(`${label} must be a regular host-owned store file`);
    snapshot = await open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o400,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await before.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0)
        throw new Error(`${label} changed while it was being read`);
      hash.update(buffer.subarray(0, bytesRead));
      await snapshot.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    const after = await before.stat();
    if (
      after.size !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return { bytes: stat.size, digest: `sha256:${hash.digest("hex")}` };
  } finally {
    await snapshot?.close();
    await before.close();
  }
}

function parse(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export async function admitFactoryAcceptance({
  manifestPath,
  provenancePath,
  outputIsoPath,
  manifestIdentity,
  provenanceDigest,
  outputIdentity,
  outputDigest,
  udfExtractorPath,
  udfWriterPath,
  wimlibPath,
}) {
  const [manifestBytes, provenanceBytes] = await Promise.all([
    readRegular(manifestPath, "Factory Manifest"),
    readRegular(provenancePath, "Factory provenance"),
  ]);
  if (digest(provenanceBytes) !== provenanceDigest)
    throw new Error(
      "host-owned Factory provenance bytes do not match the requested digest",
    );
  const manifest = validateFactoryManifest(
    parse(manifestBytes, "Factory Manifest"),
  );
  if (manifest.manifestId !== manifestIdentity)
    throw new Error(
      "host-owned Factory Manifest canonical identity does not match the requested identity",
    );
  const provenance = parse(provenanceBytes, "Factory provenance");
  validateFactoryEvidencePayload("factory-provenance.json", provenance);
  if (
    provenance.manifest?.identity !== manifest.manifestId ||
    provenance.manifest?.schemaVersion !== manifest.schemaVersion
  )
    throw new Error(
      "Factory provenance does not bind the supplied Factory Manifest",
    );
  if (
    provenance.output?.assemblyMode !== "windows-serviced-iso" ||
    provenance.output?.windowsInstallerCustomized !== true
  )
    throw new Error(
      "Factory provenance does not describe a customized Windows serviced ISO",
    );
  if (!udfExtractorPath || !udfWriterPath || !wimlibPath)
    throw new Error(
      "Factory acceptance requires manifest-pinned UDF extractor, writer, and wimlib paths",
    );
  const inspectionDirectory = await mkdtemp(
    join(tmpdir(), "vem-factory-admission-"),
  );
  let windowsSetup;
  try {
    await Promise.all([
      verifyPinnedFactoryTool({
        path: udfExtractorPath,
        tool: manifest.toolchain.udfExtractor,
        label: "UDF extractor",
        args: [],
        versionPattern: new RegExp(
          `7-zip[^\\r\\n]*${(() => {
            const [major, minor, patch] =
              manifest.toolchain.udfExtractor.version.split(".");
            return `${major}\\.${minor.padStart(2, "0")}${patch === "0" ? "" : `\\.${patch}`}`;
          })()}`,
          "i",
        ),
      }),
      verifyPinnedFactoryTool({
        path: udfWriterPath,
        tool: manifest.toolchain.udfWriter,
        label: "UDF writer",
        args: ["--version"],
        versionPattern: new RegExp(
          `genisoimage\\s+${manifest.toolchain.udfWriter.version.replaceAll(".", "\\.")}`,
          "i",
        ),
      }),
      verifyPinnedFactoryTool({
        path: wimlibPath,
        tool: manifest.toolchain.wimlib,
        label: "wimlib",
        args: ["--version"],
        versionPattern: new RegExp(
          `wimlib-imagex\\s+${manifest.toolchain.wimlib.version.replaceAll(".", "\\.")}`,
          "i",
        ),
      }),
    ]);
    const isoSnapshot = join(inspectionDirectory, "factory.iso");
    const iso = await snapshotAndHashRegular(
      outputIsoPath,
      "Factory ISO",
      isoSnapshot,
    );
    if (
      iso.digest !== outputDigest ||
      outputIdentity !== `factory-cas://${outputDigest.replace(":", "/")}`
    ) {
      throw new Error(
        "host-owned Factory ISO bytes do not match the requested identity and digest",
      );
    }
    if (
      provenance.output?.identity !== outputIdentity ||
      provenance.output?.digest !== outputDigest ||
      provenance.output?.bytes !== iso.bytes
    ) {
      throw new Error(
        "Factory provenance output does not bind the host-owned ISO",
      );
    }
    const structure = await inspectBootableIsoFile(isoSnapshot);
    if (
      canonicalJson(structure) !==
      canonicalJson(
        (({ windowsSetup, ...outerStructure }) => outerStructure)(
          provenance.output.structure ?? {},
        ),
      )
    ) {
      throw new Error("Factory ISO structure does not match its provenance");
    }
    windowsSetup = await inspectWindowsSetupIso({
      isoPath: isoSnapshot,
      expectedInstallImage: {
        index: manifest.source.installImageIndex,
        edition: manifest.source.installImageEdition,
        digest: manifest.source.installImageDigest,
      },
      udfExtractorPath,
      udfExtractor: manifest.toolchain.udfExtractor,
      wimlibPath,
      wimlib: manifest.toolchain.wimlib,
    });
  } finally {
    await rm(inspectionDirectory, { recursive: true, force: true });
  }
  if (
    canonicalJson(windowsSetup) !==
    canonicalJson(provenance.output.structure?.windowsSetup)
  )
    throw new Error(
      "Factory ISO Windows Setup structure does not match its provenance",
    );
  if (
    !Array.isArray(provenance.effectiveInputs) ||
    provenance.effectiveInputs.length === 0
  )
    throw new Error("Factory provenance has no effective inputs");
  const seen = new Set();
  for (const input of provenance.effectiveInputs) {
    if (
      !input ||
      typeof input.role !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(input.digest ?? "") ||
      seen.has(input.role)
    )
      throw new Error("Factory provenance effective inputs are malformed");
    seen.add(input.role);
  }
  const expectedRoles = expectedFactoryEffectiveInputRoles(manifest);
  if (
    seen.size !== expectedRoles.length ||
    expectedRoles.some((role) => !seen.has(role))
  )
    throw new Error(
      "Factory provenance effective inputs are incomplete for the admitted build",
    );
  const exactManifestInputs = new Map([
    ["manifest:factory-manifest", digest(Buffer.from(canonicalJson(manifest)))],
    ...[manifest.source.windowsMedia, ...manifest.assets].map((asset) => [
      `asset:${asset.role}`,
      asset.digest,
    ]),
    ["tool:builder-image", manifest.toolchain.builderImage.digest],
    ["tool:udf-extractor", manifest.toolchain.udfExtractor.digest],
    ["tool:udf-writer", manifest.toolchain.udfWriter.digest],
    ["tool:wimlib", manifest.toolchain.wimlib.digest],
  ]);
  for (const [role, expectedDigest] of exactManifestInputs) {
    const actual = provenance.effectiveInputs.find(
      (input) => input.role === role,
    );
    if (!actual || actual.digest !== expectedDigest) {
      throw new Error(
        `Factory provenance effective input does not match the admitted manifest: ${role}`,
      );
    }
  }
  const currentRepositoryInputs =
    await currentFactoryEffectiveRepositoryInputs();
  for (const { role, digest: expectedDigest } of currentRepositoryInputs) {
    const actual = provenance.effectiveInputs.find(
      (input) => input.role === role,
    );
    if (!actual || actual.digest !== expectedDigest) {
      throw new Error(
        `Factory provenance effective input does not match the current trusted file: ${role}`,
      );
    }
  }
  const embeddedEffectiveInputs = windowsSetup.factoryEffectiveInputs;
  if (!embeddedEffectiveInputs) {
    throw new Error("Factory ISO is missing embedded effective inputs");
  }
  if (
    embeddedEffectiveInputs.schemaVersion !==
      "vem-factory-effective-inputs/v1" ||
    canonicalJson(embeddedEffectiveInputs.inputs) !==
      canonicalJson(provenance.effectiveInputs)
  ) {
    throw new Error(
      "embedded Factory effective inputs do not exactly match provenance",
    );
  }
  return {
    manifestIdentity: manifest.manifestId,
    provenanceDigest,
    outputIdentity,
    outputDigest,
    effectiveInputsDigest: digest(
      Buffer.from(canonicalJson(provenance.effectiveInputs)),
    ),
  };
}
