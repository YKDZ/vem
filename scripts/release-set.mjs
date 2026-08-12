import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBackendReleaseSet } from "./backend-deployment-validation.mjs";

const COMPONENT_EVIDENCE_SCHEMA = "vem.release-set.component-evidence.v1";
const RELEASE_SET_SCHEMA = "vem.release-set.v1";
const FULL_SOURCE_COMMIT_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const MIGRATION_TARGET_RE = /^20[0-9]{12}_[a-z0-9_]+$/;
const VISION_V2_BUNDLE_FILES = [
  "__init__.py",
  "fixtures/client-invalid.json",
  "fixtures/client-valid.json",
  "fixtures/server-invalid.json",
  "fixtures/server-valid.json",
  "python/__init__.py",
  "python/vision_v2_models.py",
  "vision-v2.client.schema.json",
  "vision-v2.server.schema.json",
];

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortCanonical(value))}\n`;
}

function canonicalJsonValue(value) {
  return JSON.stringify(sortCanonical(value));
}

function assertExactObject(value, expectedKeys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function assertDigest(value, label) {
  if (!SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertCommit(value, label) {
  if (!FULL_SOURCE_COMMIT_RE.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit`);
  }
}

function assertDigestObject(value, keys, label) {
  assertExactObject(value, keys, label);
  for (const key of keys) assertDigest(value[key], `${label}.${key}`);
}

function validateComponentEvidence(evidence, repoRoot) {
  assertExactObject(
    evidence,
    [
      "adminContracts",
      "ai",
      "backend",
      "database",
      "precutover",
      "schemaVersion",
      "vem",
      "vision",
      "visionV2Bundle",
      "windowsRuntime",
    ],
    "component evidence",
  );
  if (evidence.schemaVersion !== COMPONENT_EVIDENCE_SCHEMA) {
    throw new Error(
      `component evidence schemaVersion must be ${COMPONENT_EVIDENCE_SCHEMA}`,
    );
  }

  assertExactObject(evidence.vem, ["sourceCommit"], "component evidence.vem");
  assertCommit(
    evidence.vem.sourceCommit,
    "component evidence.vem.sourceCommit",
  );

  assertExactObject(
    evidence.backend,
    ["adminUi", "serviceApi"],
    "component evidence.backend",
  );
  validateBackendReleaseSet({
    adminUi: evidence.backend.adminUi,
    serviceApi: evidence.backend.serviceApi,
    vemSourceCommit: evidence.vem.sourceCommit,
  });
  for (const [key, label] of [
    ["serviceApi", "Service API"],
    ["adminUi", "Admin UI"],
  ]) {
    assertExactObject(
      evidence.backend[key],
      ["image", "provenanceSha256", "sourceCommit"],
      `component evidence.backend.${key}`,
    );
    assertDigest(evidence.backend[key].provenanceSha256, `${label} provenance`);
  }

  assertExactObject(
    evidence.windowsRuntime,
    ["archiveSha256", "descriptorSha256", "sourceCommit"],
    "component evidence.windowsRuntime",
  );
  assertDigest(
    evidence.windowsRuntime.archiveSha256,
    "Windows runtime archive",
  );
  assertDigest(
    evidence.windowsRuntime.descriptorSha256,
    "Windows runtime descriptor",
  );
  if (evidence.windowsRuntime.sourceCommit !== evidence.vem.sourceCommit) {
    throw new Error("Windows runtime must use the VEM source commit");
  }

  assertExactObject(
    evidence.vision,
    [
      "attestationBundleSha256",
      "candidateSubjectSha256",
      "embeddedManifestSha256",
      "sourceCommit",
      "trustedBuilderEvidenceSha256",
    ],
    "component evidence.vision",
  );
  assertCommit(evidence.vision.sourceCommit, "Vision source commit");
  for (const key of [
    "attestationBundleSha256",
    "candidateSubjectSha256",
    "embeddedManifestSha256",
    "trustedBuilderEvidenceSha256",
  ]) {
    assertDigest(evidence.vision[key], `Vision ${key}`);
  }

  assertDigestObject(
    evidence.visionV2Bundle,
    ["bundleSha256"],
    "component evidence.visionV2Bundle",
  );

  assertExactObject(
    evidence.ai,
    [
      "modelDescriptorSha256",
      "modelPackArchive",
      "requirementsLockSha256",
      "runtimeDescriptorSha256",
    ],
    "component evidence.ai",
  );
  for (const key of [
    "modelDescriptorSha256",
    "requirementsLockSha256",
    "runtimeDescriptorSha256",
  ]) {
    assertDigest(evidence.ai[key], `AI ${key}`);
  }
  assertExactObject(
    evidence.ai.modelPackArchive,
    ["byteSize", "sha256"],
    "component evidence.ai.modelPackArchive",
  );
  if (
    !Number.isSafeInteger(evidence.ai.modelPackArchive.byteSize) ||
    evidence.ai.modelPackArchive.byteSize <= 0
  ) {
    throw new Error(
      "AI model-pack archive byteSize must be a positive integer",
    );
  }
  assertDigest(evidence.ai.modelPackArchive.sha256, "AI model-pack archive");

  assertExactObject(
    evidence.database,
    ["migrationChainSha256", "migrationCount", "migrationTarget"],
    "component evidence.database",
  );
  if (!MIGRATION_TARGET_RE.test(evidence.database.migrationTarget)) {
    throw new Error("database migrationTarget is invalid");
  }
  if (
    !Number.isSafeInteger(evidence.database.migrationCount) ||
    evidence.database.migrationCount <= 0
  ) {
    throw new Error("database migrationCount must be a positive integer");
  }
  assertDigest(
    evidence.database.migrationChainSha256,
    "database migration chain",
  );

  assertDigestObject(
    evidence.adminContracts,
    ["evidenceSha256"],
    "component evidence.adminContracts",
  );

  assertExactObject(
    evidence.precutover,
    ["database", "managedMedia"],
    "component evidence.precutover",
  );
  assertExactObject(
    evidence.precutover.database,
    ["backup", "receiptSha256", "source"],
    "component evidence.precutover.database",
  );
  assertDigest(
    evidence.precutover.database.receiptSha256,
    "precutover database receipt",
  );
  assertExactObject(
    evidence.precutover.database.backup,
    ["byteSize", "sha256"],
    "component evidence.precutover.database.backup",
  );
  if (
    !Number.isSafeInteger(evidence.precutover.database.backup.byteSize) ||
    evidence.precutover.database.backup.byteSize <= 0
  ) {
    throw new Error("precutover database backup byteSize is invalid");
  }
  assertDigest(
    evidence.precutover.database.backup.sha256,
    "precutover database backup",
  );
  assertExactObject(
    evidence.precutover.database.source,
    ["databaseName", "migrationChainSha256", "systemIdentifier"],
    "component evidence.precutover.database.source",
  );
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(
      evidence.precutover.database.source.databaseName,
    ) ||
    !/^[0-9]+$/.test(evidence.precutover.database.source.systemIdentifier)
  ) {
    throw new Error("precutover database source identity is invalid");
  }
  assertDigest(
    evidence.precutover.database.source.migrationChainSha256,
    "precutover database migration chain",
  );
  if (
    evidence.precutover.database.source.migrationChainSha256 !==
    evidence.database.migrationChainSha256
  ) {
    throw new Error("precutover database migration chain is inconsistent");
  }
  assertExactObject(
    evidence.precutover.managedMedia,
    ["assetCount", "assetsSetSha256", "generation", "receiptSha256"],
    "component evidence.precutover.managedMedia",
  );
  if (
    !Number.isSafeInteger(evidence.precutover.managedMedia.assetCount) ||
    evidence.precutover.managedMedia.assetCount < 0 ||
    typeof evidence.precutover.managedMedia.generation !== "string" ||
    evidence.precutover.managedMedia.generation.length === 0 ||
    evidence.precutover.managedMedia.generation.length > 128
  ) {
    throw new Error("precutover managed-media identity is invalid");
  }
  assertDigest(
    evidence.precutover.managedMedia.assetsSetSha256,
    "precutover managed-media asset set",
  );
  assertDigest(
    evidence.precutover.managedMedia.receiptSha256,
    "precutover managed-media receipt",
  );

  const repository = readReleaseRepositoryFacts(repoRoot);
  if (
    evidence.visionV2Bundle.bundleSha256 !==
    repository.visionV2Bundle.bundleSha256
  ) {
    throw new Error(
      "Vision V2 bundle digest does not match the generated VEM bundle",
    );
  }
  if (canonicalJson(evidence.database) !== canonicalJson(repository.database)) {
    throw new Error(
      "database migration identity does not match the VEM migration chain",
    );
  }
}

export function readReleaseRepositoryFacts(repoRoot) {
  const root = resolve(repoRoot);
  const bundleRoot = join(root, "packages/shared/generated/vision-v2");
  const bundleManifestRaw = readFileSync(
    join(bundleRoot, "manifest.json"),
    "utf8",
  );
  const bundleManifest = JSON.parse(bundleManifestRaw);
  if (canonicalJson(bundleManifest) !== bundleManifestRaw) {
    throw new Error("generated Vision V2 manifest must use canonical JSON");
  }
  assertExactObject(
    bundleManifest,
    ["bundleDigest", "bundleVersion", "files", "protocol", "schemaVersion"],
    "generated Vision V2 manifest",
  );
  if (
    bundleManifest.schemaVersion !== "vem-vision-v2-contract-bundle/v1" ||
    bundleManifest.protocol !== "vem.vision.v2" ||
    bundleManifest.bundleVersion !== "1"
  ) {
    throw new Error("generated Vision V2 manifest metadata is invalid");
  }
  assertExactObject(
    bundleManifest.files,
    VISION_V2_BUNDLE_FILES,
    "generated Vision V2 manifest files",
  );
  const actualMembers = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), relative);
      else actualMembers.push(relative);
    }
  };
  visit(bundleRoot);
  const expectedMembers = [...VISION_V2_BUNDLE_FILES, "manifest.json"].sort();
  if (
    JSON.stringify(actualMembers.sort()) !== JSON.stringify(expectedMembers)
  ) {
    throw new Error("generated Vision V2 bundle has an unexpected file set");
  }
  for (const relative of VISION_V2_BUNDLE_FILES) {
    const path = join(bundleRoot, ...relative.split("/"));
    if (!lstatSync(path).isFile()) {
      throw new Error(
        `generated Vision V2 member is not a regular file: ${relative}`,
      );
    }
    const contents = readFileSync(path);
    if (
      !Number.isSafeInteger(contents.byteLength) ||
      contents.byteLength <= 0
    ) {
      throw new Error(`generated Vision V2 file size is invalid: ${relative}`);
    }
    const expectedDigest = bundleManifest.files[relative];
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
      throw new Error(
        `generated Vision V2 file digest is invalid: ${relative}`,
      );
    }
    if (sha256(contents) !== `sha256:${expectedDigest}`) {
      throw new Error(`generated Vision V2 file digest mismatch: ${relative}`);
    }
  }
  const bundleMetadata = {
    bundleVersion: bundleManifest.bundleVersion,
    files: bundleManifest.files,
    protocol: bundleManifest.protocol,
    schemaVersion: bundleManifest.schemaVersion,
  };
  if (
    !/^[a-f0-9]{64}$/.test(bundleManifest.bundleDigest) ||
    sha256(canonicalJsonValue(bundleMetadata)) !==
      `sha256:${bundleManifest.bundleDigest}`
  ) {
    throw new Error("generated Vision V2 bundle has an invalid digest");
  }

  const migrationsRoot = join(root, "packages/db/drizzle");
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && MIGRATION_TARGET_RE.test(entry.name),
    )
    .map((entry) => ({
      migrationSha256: sha256(
        readFileSync(join(migrationsRoot, entry.name, "migration.sql")),
      ),
      name: entry.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (migrations.length === 0) {
    throw new Error("VEM migration chain is empty");
  }

  return {
    database: {
      migrationChainSha256: sha256(canonicalJson(migrations)),
      migrationCount: migrations.length,
      migrationTarget: migrations.at(-1).name,
    },
    visionV2Bundle: {
      bundleSha256: `sha256:${bundleManifest.bundleDigest}`,
    },
  };
}

export function generateReleaseSet({ evidence, repoRoot }) {
  validateComponentEvidence(evidence, repoRoot);
  return canonicalJson({
    ...structuredClone(evidence),
    schemaVersion: RELEASE_SET_SCHEMA,
  });
}

export function verifyReleaseSet({
  componentEvidence,
  expectedManifestSha256,
  manifestText,
  repoRoot,
}) {
  if (!SHA256_RE.test(expectedManifestSha256)) {
    throw new Error("external expected manifest SHA-256 is required");
  }
  if (sha256(manifestText) !== expectedManifestSha256) {
    throw new Error("release-set manifest digest mismatch");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("release-set manifest must be valid JSON");
  }
  if (canonicalJson(manifest) !== manifestText) {
    throw new Error("release-set manifest must use exact canonical JSON");
  }
  if (manifest.schemaVersion !== RELEASE_SET_SCHEMA) {
    throw new Error(`release-set schemaVersion must be ${RELEASE_SET_SCHEMA}`);
  }

  const expectedText = generateReleaseSet({
    evidence: componentEvidence,
    repoRoot,
  });
  if (expectedText !== manifestText) {
    throw new Error(
      "release-set manifest does not match trusted component evidence",
    );
  }
  return manifest;
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (command === "verify") {
    throw new Error(
      "production verification requires release-set-approval.mjs verify",
    );
  }
  if (command !== "generate") {
    throw new Error("usage: release-set.mjs generate [options]");
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!option?.startsWith("--") || value === undefined) {
      throw new Error(`invalid CLI option: ${option ?? "<missing>"}`);
    }
    const key = option.slice(2);
    if (Object.hasOwn(values, key))
      throw new Error(`duplicate option: ${option}`);
    values[key] = value;
  }
  const allowed = ["evidence", "output", "repo-root"];
  for (const key of Object.keys(values)) {
    if (!allowed.includes(key)) throw new Error(`unknown option: --${key}`);
  }
  for (const key of allowed) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  return { command, values };
}

function readJson(path, label, { requireCanonical = false } = {}) {
  let raw;
  let parsed;
  try {
    raw = readFileSync(path, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be readable valid JSON`);
  }
  if (requireCanonical && canonicalJson(parsed) !== raw) {
    throw new Error(`${label} must use canonical JSON`);
  }
  return parsed;
}

function writeAtomic(path, value) {
  const temporary = join(dirname(path), `.${process.pid}.release-set.tmp`);
  writeFileSync(temporary, value, { flag: "wx" });
  renameSync(temporary, path);
}

function main(argv) {
  const { command, values } = parseArguments(argv);
  const evidence = readJson(values.evidence, "component evidence", {
    requireCanonical: true,
  });
  if (command === "generate") {
    writeAtomic(
      values.output,
      generateReleaseSet({ evidence, repoRoot: values["repo-root"] }),
    );
    process.stdout.write("release-set generated\n");
    return;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
