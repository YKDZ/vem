import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  expectedFactoryEffectiveInputRoles,
  inspectBootableIso,
  inspectWindowsSetupIso,
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
  isoBuilderPath,
  wimlibPath,
}) {
  const [manifestBytes, provenanceBytes, isoBytes] = await Promise.all([
    readRegular(manifestPath, "Factory Manifest"),
    readRegular(provenancePath, "Factory provenance"),
    readRegular(outputIsoPath, "Factory ISO"),
  ]);
  if (digest(provenanceBytes) !== provenanceDigest)
    throw new Error(
      "host-owned Factory provenance bytes do not match the requested digest",
    );
  if (
    digest(isoBytes) !== outputDigest ||
    outputIdentity !== `factory-cas://${outputDigest.replace(":", "/")}`
  )
    throw new Error(
      "host-owned Factory ISO bytes do not match the requested identity and digest",
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
  if (
    provenance.output?.identity !== outputIdentity ||
    provenance.output?.digest !== outputDigest ||
    provenance.output?.bytes !== isoBytes.length
  )
    throw new Error(
      "Factory provenance output does not bind the host-owned ISO",
    );
  const structure = inspectBootableIso(isoBytes);
  if (
    canonicalJson(structure) !==
    canonicalJson(
      (({ windowsSetup, ...outerStructure }) => outerStructure)(
        provenance.output.structure ?? {},
      ),
    )
  )
    throw new Error("Factory ISO structure does not match its provenance");
  if (!isoBuilderPath || !wimlibPath)
    throw new Error(
      "Factory acceptance requires manifest-pinned xorriso and wimlib paths",
    );
  const inspectionDirectory = await mkdtemp(
    join(tmpdir(), "vem-factory-admission-"),
  );
  let windowsSetup;
  try {
    const isoSnapshot = join(inspectionDirectory, "factory.iso");
    await writeFile(isoSnapshot, isoBytes, { mode: 0o444 });
    windowsSetup = await inspectWindowsSetupIso({
      isoPath: isoSnapshot,
      expectedInstallImage: {
        index: manifest.source.installImageIndex,
        edition: manifest.source.installImageEdition,
        digest: manifest.source.installImageDigest,
      },
      isoBuilderPath,
      isoBuilder: manifest.toolchain.isoBuilder,
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
