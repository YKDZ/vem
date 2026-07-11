#!/usr/bin/env node

import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_UPLOAD_FILE_BYTES = 1024 * 1024;
const UPLOAD_FILES = new Map([
  [
    "factory-provenance.json",
    [
      "schemaVersion",
      "kind",
      "manifest",
      "inputs",
      "effectiveInputs",
      "toolchain",
      "output",
      "evidence",
      "reproducibility",
    ],
  ],
  [
    "factory-build-result.json",
    [
      "schemaVersion",
      "kind",
      "manifestIdentity",
      "isoIdentity",
      "isoDigest",
      "isoFileName",
      "provenanceFileName",
      "provenanceIdentity",
      "provenanceDigest",
      "reproducibility",
    ],
  ],
]);
const POLICY_FLAGS = [
  "sourceWindowsMediaUploaded",
  "personalizationMediaUploaded",
  "secretsCached",
  "privateKeysCached",
  "hostPathsIncluded",
];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function decodedVariants(value) {
  const variants = [value];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const decoded = decodeURIComponent(variants.at(-1));
      if (decoded === variants.at(-1)) break;
      variants.push(decoded);
    } catch {
      break;
    }
  }
  return variants;
}

function validateString(value, label) {
  for (const inspected of decodedVariants(value)) {
    if (/file:\/\//i.test(inspected))
      throw new Error(`${label} contains a file URI`);
    if (
      /(?:^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*)/.test(
        inspected,
      )
    ) {
      throw new Error(`${label} contains an absolute host path`);
    }
    if (
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|token|authorization)\s*[:=]|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\b(?:gh[opsu]|github_pat|sk)-[A-Za-z0-9_-]{16,}/i.test(
        inspected,
      )
    ) {
      throw new Error(`${label} contains secret-like content`);
    }
  }
}

function validateRecursively(value, label) {
  if (typeof value === "string") {
    validateString(value, label);
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateRecursively(entry, `${label}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${label} contains a non-JSON value`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      key !== "hostPathsIncluded" &&
      /(?:^|_)(?:path|directory|private.?key|password|passwd|secret|token|credential)$/i.test(
        key,
      )
    ) {
      throw new Error(`${label}.${key} is a path or secret-like field`);
    }
    validateRecursively(entry, `${label}.${key}`);
  }
}

export function validateFactoryEvidencePayload(fileName, payload) {
  const topLevelKeys = UPLOAD_FILES.get(fileName);
  if (!topLevelKeys)
    throw new Error(`unexpected Factory evidence file: ${fileName}`);
  exactKeys(payload, topLevelKeys, fileName);
  if (fileName === "factory-provenance.json") {
    if (
      payload.schemaVersion !== "vem-factory-provenance/v1" ||
      payload.kind !== "factory-media-provenance"
    ) {
      throw new Error("Factory provenance contract is invalid");
    }
    exactKeys(
      payload.evidence.policy,
      POLICY_FLAGS,
      "factory provenance policy",
    );
    for (const flag of POLICY_FLAGS) {
      if (payload.evidence.policy[flag] !== false) {
        throw new Error(
          `Factory provenance policy flag ${flag} must be derived false`,
        );
      }
    }
  } else if (
    payload.schemaVersion !== "vem-factory-build-result/v1" ||
    payload.kind !== "factory-build-result"
  ) {
    throw new Error("Factory build result contract is invalid");
  } else {
    if (
      payload.isoIdentity !==
        `factory-cas://${payload.isoDigest?.replace?.(":", "/")}` ||
      payload.provenanceIdentity !==
        `factory-evidence://${payload.provenanceDigest?.replace?.(":", "/")}` ||
      payload.provenanceFileName !== "factory-provenance.json"
    ) {
      throw new Error(
        "Factory build result identities do not match their digests",
      );
    }
  }
  validateRecursively(payload, fileName);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_UPLOAD_FILE_BYTES)
    throw new Error(`${fileName} exceeds upload size limit`);
  return structuredClone(payload);
}

async function readBoundedRegularJson(path, fileName) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new Error(`${fileName} must not be a symlink`);
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile())
      throw new Error(`${fileName} must be a regular file`);
    if (fileStat.size < 2 || fileStat.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`${fileName} violates the upload size limit`);
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length)
      throw new Error(`${fileName} read was incomplete`);
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function validateFactoryEvidenceUploadDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== UPLOAD_FILES.size) {
    throw new Error(
      "Factory evidence upload directory does not match the exact allowlist",
    );
  }
  for (const entry of entries) {
    if (!UPLOAD_FILES.has(entry.name)) {
      throw new Error(
        `unexpected file outside Factory evidence allowlist: ${entry.name}`,
      );
    }
    if (!entry.isFile())
      throw new Error(`${entry.name} must be a regular file`);
    const payload = await readBoundedRegularJson(
      join(directory, entry.name),
      entry.name,
    );
    validateFactoryEvidencePayload(entry.name, payload);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const directoryIndex = process.argv.indexOf("--directory");
  if (directoryIndex < 0 || !process.argv[directoryIndex + 1]) {
    console.error("--directory is required");
    process.exitCode = 1;
  } else {
    validateFactoryEvidenceUploadDirectory(
      process.argv[directoryIndex + 1],
    ).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
