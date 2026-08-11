import { createHash } from "node:crypto";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MIGRATION_RE = /^20[0-9]{12}_[a-z0-9_]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_RECEIPT_SCHEMA = "vem.precutover.database-backup.v1";
const MEDIA_RECEIPT_SCHEMA = "vem.precutover.managed-media.v1";
const PENDING_TRUST = "pending_release_set_approval";
const PINNED_POSTGRES_IMAGE =
  "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";

export function sha256(value) {
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

export function canonicalJson(value) {
  return `${JSON.stringify(sortCanonical(value))}\n`;
}

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function digest(value, label) {
  if (!DIGEST_RE.test(value)) throw new Error(`${label} digest is invalid`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${label} timestamp is invalid`);
  }
}

function parseCanonical(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (canonicalJson(value) !== raw) {
    throw new Error(`${label} must use exact canonical JSON`);
  }
  return value;
}

function validateMigration(value, label) {
  exact(value, ["chainSha256", "count", "target"], label);
  digest(value.chainSha256, `${label}.chainSha256`);
  positiveInteger(value.count, `${label}.count`);
  if (!MIGRATION_RE.test(value.target)) {
    throw new Error(`${label}.target is invalid`);
  }
}

function validateCatalogData(value, label) {
  exact(
    value,
    [
      "associationCount",
      "garmentCount",
      "mediaAssetCount",
      "productCount",
      "sha256",
      "variantCount",
    ],
    label,
  );
  for (const key of [
    "associationCount",
    "garmentCount",
    "mediaAssetCount",
    "productCount",
    "variantCount",
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${label}.${key} is invalid`);
    }
  }
  digest(value.sha256, `${label}.sha256`);
}

function validateLegacyResidue(value, label) {
  exact(
    value,
    ["columns", "constraints", "indexes", "purposeRows", "storageReferences"],
    label,
  );
  if (Object.values(value).some((count) => count !== 0)) {
    throw new Error(`${label} is not empty`);
  }
}

export function validateDatabaseBackupReceiptText(raw) {
  const receipt = parseCanonical(raw, "database backup receipt");
  exact(
    receipt,
    [
      "backup",
      "restoreProof",
      "schemaVersion",
      "source",
      "toolchain",
      "trustStatus",
    ],
    "database backup receipt",
  );
  if (
    receipt.schemaVersion !== DATABASE_RECEIPT_SCHEMA ||
    receipt.trustStatus !== PENDING_TRUST
  ) {
    throw new Error(
      "database backup receipt schema or trust status is invalid",
    );
  }
  exact(receipt.backup, ["byteSize", "format", "sha256"], "database backup");
  positiveInteger(receipt.backup.byteSize, "database backup.byteSize");
  digest(receipt.backup.sha256, "database backup.sha256");
  if (receipt.backup.format !== "postgresql-custom") {
    throw new Error("database backup format is invalid");
  }
  exact(
    receipt.source,
    [
      "catalogData",
      "currentLsn",
      "databaseName",
      "migration",
      "snapshotId",
      "snapshotTime",
      "systemIdentifier",
    ],
    "database backup source",
  );
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(receipt.source.databaseName) ||
    !/^[0-9]+$/.test(receipt.source.systemIdentifier) ||
    !/^[0-9A-F]+\/[0-9A-F]+$/.test(receipt.source.currentLsn) ||
    !/^[A-Fa-f0-9-]{3,128}$/.test(receipt.source.snapshotId)
  ) {
    throw new Error("database backup source identity is invalid");
  }
  timestamp(receipt.source.snapshotTime, "database source snapshot");
  validateMigration(receipt.source.migration, "database source migration");
  validateCatalogData(receipt.source.catalogData, "database source catalog");
  exact(
    receipt.restoreProof,
    [
      "catalogData",
      "constraintsSha256",
      "databaseName",
      "legacyResidue",
      "migration",
      "verifiedAt",
    ],
    "database restore proof",
  );
  if (
    !/^vem_precutover_restore_[0-9]+_[a-f0-9]{12}$/.test(
      receipt.restoreProof.databaseName,
    )
  ) {
    throw new Error("database restore proof identity is invalid");
  }
  timestamp(receipt.restoreProof.verifiedAt, "database restore proof");
  digest(receipt.restoreProof.constraintsSha256, "database constraints");
  validateMigration(
    receipt.restoreProof.migration,
    "database restore migration",
  );
  validateCatalogData(
    receipt.restoreProof.catalogData,
    "database restore catalog",
  );
  validateLegacyResidue(
    receipt.restoreProof.legacyResidue,
    "database legacy residue",
  );
  if (
    canonicalJson(receipt.source.migration) !==
      canonicalJson(receipt.restoreProof.migration) ||
    canonicalJson(receipt.source.catalogData) !==
      canonicalJson(receipt.restoreProof.catalogData)
  ) {
    throw new Error("database source and restore facts differ");
  }
  exact(
    receipt.toolchain,
    [
      "docker",
      "image",
      "imageId",
      "pgDump",
      "pgRestore",
      "psql",
      "serverVersion",
    ],
    "database backup toolchain",
  );
  exact(
    receipt.toolchain.docker,
    ["byteSize", "path", "sha256", "version"],
    "database Docker tool",
  );
  positiveInteger(receipt.toolchain.docker.byteSize, "Docker byteSize");
  digest(receipt.toolchain.docker.sha256, "Docker binary");
  if (
    !receipt.toolchain.docker.path.startsWith("/") ||
    typeof receipt.toolchain.docker.version !== "string" ||
    receipt.toolchain.docker.version.length === 0 ||
    receipt.toolchain.image !== PINNED_POSTGRES_IMAGE ||
    !DIGEST_RE.test(receipt.toolchain.imageId) ||
    !/^16[0-9]{4}$/.test(receipt.toolchain.serverVersion)
  ) {
    throw new Error("database backup toolchain identity is invalid");
  }
  for (const [key, path] of [
    ["pgDump", "/usr/bin/pg_dump"],
    ["pgRestore", "/usr/bin/pg_restore"],
    ["psql", "/usr/bin/psql"],
  ]) {
    exact(receipt.toolchain[key], ["path", "version"], `database ${key}`);
    if (
      receipt.toolchain[key].path !== path ||
      !/^16\.[0-9]+$/.test(receipt.toolchain[key].version)
    ) {
      throw new Error(`database ${key} identity is invalid`);
    }
  }
  return receipt;
}

export function validateManagedMediaReceiptText(raw) {
  if (/(?:authorization|bearer|[?&](?:grant|token)=|"token")/i.test(raw)) {
    throw new Error(
      "managed-media receipt contains a raw credential or URL grant",
    );
  }
  const receipt = parseCanonical(raw, "managed-media receipt");
  exact(
    receipt,
    [
      "assets",
      "generation",
      "observedAt",
      "origin",
      "planogramVersion",
      "schemaVersion",
      "trustStatus",
    ],
    "managed-media receipt",
  );
  if (
    receipt.schemaVersion !== MEDIA_RECEIPT_SCHEMA ||
    receipt.trustStatus !== PENDING_TRUST ||
    typeof receipt.generation !== "string" ||
    receipt.generation.length === 0 ||
    receipt.generation.length > 128 ||
    typeof receipt.planogramVersion !== "string" ||
    receipt.planogramVersion.length === 0
  ) {
    throw new Error("managed-media receipt identity is invalid");
  }
  timestamp(receipt.observedAt, "managed-media observation");
  const origin = new URL(receipt.origin);
  if (
    origin.origin !== receipt.origin ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  ) {
    throw new Error("managed-media receipt origin is invalid");
  }
  if (!Array.isArray(receipt.assets) || receipt.assets.length > 256) {
    throw new Error("managed-media receipt assets are invalid");
  }
  let previousId = "";
  for (const [index, asset] of receipt.assets.entries()) {
    exact(
      asset,
      [
        "assetRevision",
        "byteSize",
        "catalogRevision",
        "contentType",
        "digest",
        "grantSha256",
        "id",
        "loopbackPath",
        "purpose",
        "reference",
      ],
      `managed-media asset ${index}`,
    );
    if (
      !UUID_RE.test(asset.id) ||
      asset.id <= previousId ||
      !["image/png", "image/jpeg", "image/webp"].includes(asset.contentType) ||
      !["product_display_image", "try_on_garment"].includes(asset.purpose) ||
      typeof asset.catalogRevision !== "string" ||
      asset.catalogRevision.length === 0 ||
      !asset.reference.startsWith("/api/media-assets/")
    ) {
      throw new Error(`managed-media asset ${index} identity is invalid`);
    }
    previousId = asset.id;
    positiveInteger(asset.byteSize, `managed-media asset ${index}.byteSize`);
    digest(asset.digest, `managed-media asset ${index}.digest`);
    digest(asset.grantSha256, `managed-media asset ${index}.grantSha256`);
    if (asset.loopbackPath !== `/media/${asset.digest}`) {
      throw new Error(
        `managed-media asset ${index} loopback identity is invalid`,
      );
    }
    if (
      asset.purpose === "try_on_garment" &&
      (asset.contentType !== "image/png" ||
        typeof asset.assetRevision !== "string" ||
        asset.assetRevision.length === 0)
    ) {
      throw new Error(`managed-media garment ${index} identity is invalid`);
    }
    if (
      asset.assetRevision !== null &&
      (typeof asset.assetRevision !== "string" ||
        asset.assetRevision.length === 0)
    ) {
      throw new Error(`managed-media asset ${index} revision is invalid`);
    }
  }
  return receipt;
}

export function derivePrecutoverEvidence(databaseRaw, mediaRaw) {
  const database = validateDatabaseBackupReceiptText(databaseRaw);
  return {
    database: {
      backup: {
        byteSize: database.backup.byteSize,
        sha256: database.backup.sha256,
      },
      receiptSha256: sha256(databaseRaw),
      source: {
        databaseName: database.source.databaseName,
        migrationChainSha256: database.source.migration.chainSha256,
        systemIdentifier: database.source.systemIdentifier,
      },
    },
    managedMedia: deriveManagedMediaEvidence(mediaRaw),
  };
}

export function deriveManagedMediaEvidence(mediaRaw) {
  const stable = deriveStableManagedMediaProof(mediaRaw);
  return {
    assetCount: stable.assetCount,
    assetsSetSha256: stable.assetsSetSha256,
    generation: stable.generation,
    receiptSha256: sha256(mediaRaw),
  };
}

export function deriveStableManagedMediaProof(mediaRaw) {
  const managedMedia = validateManagedMediaReceiptText(mediaRaw);
  return {
    assetCount: managedMedia.assets.length,
    assetsSetSha256: sha256(canonicalJson(managedMedia.assets)),
    generation: managedMedia.generation,
    planogramVersion: managedMedia.planogramVersion,
  };
}
