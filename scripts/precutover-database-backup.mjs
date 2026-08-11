#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const RECEIPT_SCHEMA = "vem.precutover.database-backup.v1";
const PINNED_POSTGRES_IMAGE =
  "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const DATABASE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const EXPECTED_CONSTRAINTS = Object.freeze([
  ["media_assets", "media_assets_pkey", "p", "PRIMARY KEY (id)"],
  [
    "media_assets",
    "media_assets_purpose_allowed",
    "c",
    "CHECK (((purpose)::text = ANY (ARRAY[('product_display_image'::character varying)::text, ('try_on_garment'::character varying)::text])))",
  ],
  [
    "product_variants",
    "product_variants_cost_cents_non_negative",
    "c",
    "CHECK (((cost_cents IS NULL) OR (cost_cents >= 0)))",
  ],
  ["product_variants", "product_variants_pkey", "p", "PRIMARY KEY (id)"],
  [
    "product_variants",
    "product_variants_price_cents_non_negative",
    "c",
    "CHECK ((price_cents >= 0))",
  ],
  [
    "product_variants",
    "product_variants_product_id_products_id_fkey",
    "f",
    "FOREIGN KEY (product_id) REFERENCES products(id)",
  ],
  [
    "product_variants",
    "product_variants_target_gender_enum",
    "c",
    "CHECK (((target_gender IS NULL) OR ((target_gender)::text = ANY (ARRAY[('male'::character varying)::text, ('female'::character varying)::text]))))",
  ],
  [
    "product_variants",
    "product_variants_try_on_garment_product_id_fkey",
    "f",
    "FOREIGN KEY (try_on_garment_id, product_id) REFERENCES try_on_garments(id, product_id)",
  ],
  [
    "try_on_garments",
    "try_on_garments_id_product_id_unique",
    "u",
    "UNIQUE (id, product_id)",
  ],
  ["try_on_garments", "try_on_garments_pkey", "p", "PRIMARY KEY (id)"],
  [
    "try_on_garments",
    "try_on_garments_product_id_products_id_fkey",
    "f",
    "FOREIGN KEY (product_id) REFERENCES products(id)",
  ],
  [
    "try_on_garments",
    "try_on_garments_source_media_asset_id_media_assets_id_fkey",
    "f",
    "FOREIGN KEY (source_media_asset_id) REFERENCES media_assets(id)",
  ],
  [
    "try_on_garments",
    "try_on_garments_template_supported",
    "c",
    "CHECK (((template)::text = ANY (ARRAY[('tshirt_short_sleeve'::character varying)::text, ('tshirt_long_sleeve'::character varying)::text])))",
  ],
]);
const EQUIVALENT_RESTORED_CONSTRAINT_DEFINITIONS = Object.freeze({
  media_assets_purpose_allowed:
    "CHECK (((purpose)::text = ANY ((ARRAY['product_display_image'::character varying, 'try_on_garment'::character varying])::text[])))",
  product_variants_target_gender_enum:
    "CHECK (((target_gender IS NULL) OR ((target_gender)::text = ANY ((ARRAY['male'::character varying, 'female'::character varying])::text[]))))",
  try_on_garments_template_supported:
    "CHECK (((template)::text = ANY ((ARRAY['tshirt_short_sleeve'::character varying, 'tshirt_long_sleeve'::character varying])::text[])))",
});

function fail(message) {
  throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    fail(`${label} has invalid keys`);
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["create", "verify"]).has(command)) {
    fail("usage: precutover-database-backup.mjs <create|verify> ...");
  }
  const allowed = new Set([
    "docker-binary",
    "container",
    "source-database",
    "source-user",
    "expected-database-name",
    "repo-root",
    "backup",
    "receipt",
  ]);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      fail("invalid CLI arguments");
    const rawKey = flag.slice(2);
    if (!allowed.has(rawKey)) fail(`unknown or duplicate argument: ${flag}`);
    const key = rawKey.replace(/-([a-z])/g, (_match, character) =>
      character.toUpperCase(),
    );
    if (key in values) fail(`unknown or duplicate argument: ${flag}`);
    values[key] = value;
  }
  for (const [key, flag] of [
    ["dockerBinary", "docker-binary"],
    ["container", "container"],
    ["sourceUser", "source-user"],
    ["repoRoot", "repo-root"],
    ["backup", "backup"],
    ["receipt", "receipt"],
  ]) {
    if (!values[key]) fail(`--${flag} is required`);
  }
  if (command === "create") {
    for (const [key, flag] of [
      ["sourceDatabase", "source-database"],
      ["expectedDatabaseName", "expected-database-name"],
    ]) {
      if (!values[key]) fail(`--${flag} is required`);
    }
    if (values.sourceDatabase !== values.expectedDatabaseName) {
      fail(
        "source database identity does not match the external expected database name",
      );
    }
  }
  for (const key of ["dockerBinary", "repoRoot", "backup", "receipt"]) {
    if (!isAbsolute(values[key]))
      fail(
        `--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} must be absolute`,
      );
  }
  for (const key of ["sourceDatabase", "expectedDatabaseName", "sourceUser"]) {
    if (values[key] !== undefined && !DATABASE_RE.test(values[key]))
      fail(`${key} is invalid`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(values.container))
    fail("container identity is invalid");
  return { command, ...values };
}

function verifyAbsoluteExecutable(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (stat.mode & 0o111) === 0
  ) {
    fail("docker binary must be an absolute real regular executable");
  }
}

function run(binary, args, { input, maximum = MAX_COMMAND_OUTPUT } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    const collect = (chunks, kind) => (chunk) => {
      if (kind === "stdout") stdoutSize += chunk.byteLength;
      else stderrSize += chunk.byteLength;
      if (stdoutSize > maximum || stderrSize > maximum) {
        child.kill("SIGKILL");
        reject(new Error("command output exceeded its bound"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout, "stdout"));
    child.stderr.on("data", collect(stderr, "stderr"));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (status !== 0) {
        reject(
          new Error(
            `command failed (${status ?? signal}): ${stderrText.trim()}`,
          ),
        );
      } else {
        resolveResult(stdoutText.trim());
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function validateContainer(options) {
  verifyAbsoluteExecutable(options.dockerBinary);
  const inspected = JSON.parse(
    await run(options.dockerBinary, ["inspect", options.container]),
  );
  if (!Array.isArray(inspected) || inspected.length !== 1)
    fail("PostgreSQL container identity is ambiguous");
  const container = inspected[0];
  if (!container.State?.Running || typeof container.Id !== "string")
    fail("PostgreSQL container is not running");
  const image = JSON.parse(
    await run(options.dockerBinary, ["image", "inspect", container.Image]),
  );
  if (
    !Array.isArray(image) ||
    image.length !== 1 ||
    !image[0].RepoDigests?.includes(PINNED_POSTGRES_IMAGE)
  ) {
    fail("PostgreSQL container does not use the pinned PG16 image");
  }
  if (!container.Config?.Env?.includes("PG_MAJOR=16"))
    fail("PostgreSQL container is not PG16");
  const execPrefix = ["exec", "--user", "postgres", container.Id];
  const versions = [];
  for (const tool of ["pg_dump", "pg_restore", "psql"]) {
    const version = await run(options.dockerBinary, [
      ...execPrefix,
      `/usr/bin/${tool}`,
      "--version",
    ]);
    const match =
      /^p(?:g_dump|g_restore|sql) \(PostgreSQL\) (16\.\d+)(?:\s|$)/.exec(
        version,
      );
    if (!match) fail(`${tool} is not the fixed absolute PG16 tool`);
    versions.push(match[1]);
  }
  if (new Set(versions).size !== 1)
    fail("PostgreSQL tool versions do not match");
  const serverVersion = await psql(
    options,
    container.Id,
    "postgres",
    "SHOW server_version_num",
  );
  if (!/^16\d{4}$/.test(serverVersion))
    fail("PostgreSQL server is not version 16");
  return { containerId: container.Id, postgresVersion: versions[0] };
}

async function psql(options, containerId, database, sql) {
  return await run(options.dockerBinary, [
    "exec",
    "--user",
    "postgres",
    containerId,
    "/usr/bin/psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-AtX",
    "--dbname",
    database,
    "--username",
    options.sourceUser,
    "--command",
    sql,
  ]);
}

function migrationFacts(repoRoot) {
  const migrationsRoot = join(realpathSync(repoRoot), "packages/db/drizzle");
  const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && /^20\d{12}_[a-z0-9_]+$/.test(entry.name),
    )
    .map((entry) => ({
      migrationSha256: sha256(
        readFileSync(join(migrationsRoot, entry.name, "migration.sql")),
      ),
      name: entry.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (migrations.length === 0) fail("migration chain is empty");
  return {
    hashes: migrations.map(({ migrationSha256 }) =>
      migrationSha256.slice("sha256:".length),
    ),
    receipt: {
      chainSha256: sha256(canonicalJson(migrations)),
      count: migrations.length,
      target: migrations.at(-1).name,
    },
  };
}

const DATABASE_FACTS_SQL = String.raw`
SELECT json_build_object(
  'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
  'databaseName',current_database(),
  'currentLsn',pg_current_wal_lsn()::text,
  'snapshotTime',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'migrationHashes',(SELECT coalesce(json_agg(hash ORDER BY created_at,id),'[]'::json) FROM drizzle."__drizzle_migrations"),
  'constraints',(SELECT coalesce(json_agg(json_build_array(c.relname,con.conname,con.contype,pg_get_constraintdef(con.oid)) ORDER BY c.relname,con.conname),'[]'::json)
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('media_assets','product_variants','try_on_garments')),
  'legacyResidue',json_build_object(
    'columns',(SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND column_name ILIKE '%silhouette%'),
    'indexes',(SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND (indexname ILIKE '%silhouette%' OR indexdef ILIKE '%silhouette%')),
    'constraints',(SELECT count(*)::int FROM pg_constraint WHERE conname ILIKE '%silhouette%' OR pg_get_constraintdef(oid) ILIKE '%silhouette%'),
    'purposeRows',(SELECT count(*)::int FROM media_assets WHERE purpose='try_on_silhouette'),
    'storageReferences',(SELECT count(*)::int FROM media_assets WHERE storage_key ILIKE '%silhouette%' OR coalesce(public_url,'') ILIKE '%silhouette%')),
  'tryOnRows',(SELECT coalesce(json_agg(row_to_json(facts) ORDER BY facts."garmentId",facts."variantId"),'[]'::json) FROM (
    SELECT g.id::text AS "garmentId",g.product_id::text AS "productId",g.source_media_asset_id::text AS "sourceMediaAssetId",
      g.template::text AS template,g.status::text AS status,coalesce(v.id::text,'') AS "variantId"
    FROM try_on_garments g LEFT JOIN product_variants v ON v.try_on_garment_id=g.id
    ORDER BY g.id,v.id) facts)
)`;

async function databaseFacts(
  options,
  containerId,
  database,
  expectedMigration,
) {
  let raw;
  try {
    raw = JSON.parse(
      await psql(options, containerId, database, DATABASE_FACTS_SQL),
    );
  } catch (error) {
    fail(`database migration or schema proof failed: ${error.message}`);
  }
  if (raw.databaseName !== database)
    fail("database identity mismatch during proof");
  if (
    !/^[0-9]+$/.test(raw.systemIdentifier) ||
    !/^[0-9A-F]+\/[0-9A-F]+$/.test(raw.currentLsn)
  ) {
    fail("database physical identity is invalid");
  }
  if (
    !Array.isArray(raw.migrationHashes) ||
    JSON.stringify(raw.migrationHashes) !==
      JSON.stringify(expectedMigration.hashes)
  ) {
    fail("database migration chain does not match the repository");
  }
  if (
    !Array.isArray(raw.constraints) ||
    raw.constraints.length !== EXPECTED_CONSTRAINTS.length
  ) {
    fail("database final constraints do not match the hard-cutover schema");
  }
  for (let index = 0; index < EXPECTED_CONSTRAINTS.length; index += 1) {
    const actual = raw.constraints[index];
    const expected = EXPECTED_CONSTRAINTS[index];
    const alternate = EQUIVALENT_RESTORED_CONSTRAINT_DEFINITIONS[expected[1]];
    if (
      !Array.isArray(actual) ||
      JSON.stringify(actual.slice(0, 3)) !==
        JSON.stringify(expected.slice(0, 3)) ||
      (actual[3] !== expected[3] && actual[3] !== alternate)
    ) {
      fail("database final constraints do not match the hard-cutover schema");
    }
  }
  const legacyResidue = raw.legacyResidue;
  exactKeys(
    legacyResidue,
    ["columns", "indexes", "constraints", "purposeRows", "storageReferences"],
    "legacy residue",
  );
  if (Object.values(legacyResidue).some((value) => value !== 0))
    fail("database contains legacy try-on residue");
  if (!Array.isArray(raw.tryOnRows)) fail("try-on data proof is invalid");
  const garmentCount = new Set(raw.tryOnRows.map((row) => row.garmentId)).size;
  const associationCount = raw.tryOnRows.filter(
    (row) => row.variantId !== "",
  ).length;
  return {
    databaseName: raw.databaseName,
    systemIdentifier: raw.systemIdentifier,
    currentLsn: raw.currentLsn,
    snapshotTime: raw.snapshotTime,
    migration: expectedMigration.receipt,
    constraints: EXPECTED_CONSTRAINTS,
    constraintsSha256: sha256(canonicalJson(EXPECTED_CONSTRAINTS)),
    legacyResidue,
    tryOnData: {
      associationCount,
      garmentCount,
      sha256: sha256(canonicalJson(raw.tryOnRows)),
    },
  };
}

async function streamDump(options, containerId, database, staging) {
  const child = spawn(
    options.dockerBinary,
    [
      "exec",
      "--user",
      "postgres",
      containerId,
      "/usr/bin/pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--serializable-deferrable",
      "--dbname",
      database,
      "--username",
      options.sourceUser,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const digest = createHash("sha256");
  let byteSize = 0;
  const stderr = [];
  let stderrSize = 0;
  child.stderr.on("data", (chunk) => {
    stderrSize += chunk.byteLength;
    if (stderrSize <= MAX_COMMAND_OUTPUT) stderr.push(Buffer.from(chunk));
    else child.kill("SIGKILL");
  });
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      byteSize += chunk.byteLength;
      if (byteSize > MAX_BACKUP_BYTES)
        callback(new Error("database backup exceeds its size bound"));
      else {
        digest.update(chunk);
        callback(null, chunk);
      }
    },
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status !== 0)
        reject(
          new Error(
            `pg_dump failed (${status ?? signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      else resolveExit();
    });
  });
  try {
    const streamed = pipeline(
      child.stdout,
      meter,
      createWriteStream(staging, { flags: "wx", mode: 0o600 }),
    ).catch((error) => {
      child.kill("SIGKILL");
      throw error;
    });
    const results = await Promise.allSettled([streamed, exited]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  const header = Buffer.alloc(5);
  const descriptor = openSync(staging, "r");
  try {
    readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (byteSize < 5 || !header.equals(Buffer.from("PGDMP"))) {
    fail("pg_dump did not produce a PostgreSQL custom backup");
  }
  return {
    byteSize,
    format: "postgresql-custom",
    sha256: `sha256:${digest.digest("hex")}`,
  };
}

async function fileFacts(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_BACKUP_BYTES
  ) {
    fail("backup file is invalid");
  }
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    byteSize += chunk.byteLength;
    digest.update(chunk);
  }
  return {
    byteSize,
    format: "postgresql-custom",
    sha256: `sha256:${digest.digest("hex")}`,
  };
}

async function restoreBackup(options, containerId, backup, migration) {
  const database = `vem_precutover_restore_${process.pid}_${randomBytes(6).toString("hex")}`;
  let created = false;
  let facts;
  let primaryError;
  try {
    await psql(
      options,
      containerId,
      "postgres",
      `CREATE DATABASE "${database}"`,
    );
    created = true;
    const child = spawn(
      options.dockerBinary,
      [
        "exec",
        "--interactive",
        "--user",
        "postgres",
        containerId,
        "/usr/bin/pg_restore",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        database,
        "--username",
        options.sourceUser,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const stderr = [];
    let stderrSize = 0;
    child.stderr.on("data", (chunk) => {
      stderrSize += chunk.byteLength;
      if (stderrSize <= MAX_COMMAND_OUTPUT) stderr.push(Buffer.from(chunk));
      else child.kill("SIGKILL");
    });
    const exited = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => {
        if (status !== 0)
          reject(
            new Error(
              `pg_restore failed (${status ?? signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
          );
        else resolveExit();
      });
    });
    const streamed = pipeline(createReadStream(backup), child.stdin).catch(
      (error) => {
        child.kill("SIGKILL");
        throw error;
      },
    );
    const restoreResults = await Promise.allSettled([streamed, exited]);
    const restoreFailure = restoreResults.find(
      (result) => result.status === "rejected",
    );
    if (restoreFailure) throw restoreFailure.reason;
    facts = await databaseFacts(options, containerId, database, migration);
  } catch (error) {
    primaryError = error;
  } finally {
    if (created) {
      try {
        await psql(
          options,
          containerId,
          "postgres",
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid()`,
        );
        await psql(
          options,
          containerId,
          "postgres",
          `DROP DATABASE "${database}"`,
        );
      } catch (cleanupError) {
        if (!primaryError)
          primaryError = new Error(
            `restore database cleanup failed: ${cleanupError.message}`,
          );
      }
    }
  }
  if (primaryError) throw primaryError;
  return {
    ...facts,
    databaseName: database,
    verifiedAt: new Date().toISOString(),
  };
}

function writeAtomic(path, contents) {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    fail("output parent is unsafe");
  const staging = join(
    parent,
    `.precutover-db-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(staging, contents, { flag: "wx", mode: 0o600 });
    linkSync(staging, path);
    rmSync(staging);
  } finally {
    rmSync(staging, { force: true });
  }
}

function validateReceipt(raw) {
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    fail("database backup receipt is invalid JSON");
  }
  if (canonicalJson(receipt) !== raw)
    fail("database backup receipt is not canonical");
  exactKeys(
    receipt,
    ["backup", "restoreProof", "schemaVersion", "source", "toolchain"],
    "database backup receipt",
  );
  if (receipt.schemaVersion !== RECEIPT_SCHEMA)
    fail("database backup receipt schema is invalid");
  exactKeys(receipt.backup, ["byteSize", "format", "sha256"], "backup facts");
  if (
    !Number.isSafeInteger(receipt.backup.byteSize) ||
    receipt.backup.byteSize <= 0 ||
    !DIGEST_RE.test(receipt.backup.sha256) ||
    receipt.backup.format !== "postgresql-custom"
  ) {
    fail("database backup receipt facts are invalid");
  }
  exactKeys(
    receipt.toolchain,
    ["image", "postgresVersion"],
    "database backup toolchain",
  );
  if (
    receipt.toolchain.image !== PINNED_POSTGRES_IMAGE ||
    !/^16\.\d+$/.test(receipt.toolchain.postgresVersion)
  ) {
    fail("database backup receipt toolchain is invalid");
  }
  exactKeys(
    receipt.source,
    [
      "currentLsn",
      "databaseName",
      "migration",
      "snapshotTime",
      "systemIdentifier",
      "tryOnData",
    ],
    "database backup source",
  );
  if (
    !DATABASE_RE.test(receipt.source.databaseName) ||
    !/^[0-9]+$/.test(receipt.source.systemIdentifier) ||
    !/^[0-9A-F]+\/[0-9A-F]+$/.test(receipt.source.currentLsn) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      receipt.source.snapshotTime,
    )
  ) {
    fail("database backup source identity is invalid");
  }
  exactKeys(
    receipt.restoreProof,
    [
      "constraintsSha256",
      "databaseName",
      "legacyResidue",
      "migration",
      "tryOnData",
      "verifiedAt",
    ],
    "database restore proof",
  );
  if (
    !/^vem_precutover_restore_[0-9]+_[a-f0-9]{12}$/.test(
      receipt.restoreProof.databaseName,
    ) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      receipt.restoreProof.verifiedAt,
    )
  ) {
    fail("database restore proof identity is invalid");
  }
  for (const [label, migration] of [
    ["source migration", receipt.source.migration],
    ["restore migration", receipt.restoreProof.migration],
  ]) {
    exactKeys(migration, ["chainSha256", "count", "target"], label);
    if (
      !DIGEST_RE.test(migration.chainSha256) ||
      !Number.isSafeInteger(migration.count) ||
      migration.count <= 0 ||
      !/^20\d{12}_[a-z0-9_]+$/.test(migration.target)
    ) {
      fail(`${label} is invalid`);
    }
  }
  for (const [label, data] of [
    ["source try-on data", receipt.source.tryOnData],
    ["restore try-on data", receipt.restoreProof.tryOnData],
  ]) {
    exactKeys(data, ["associationCount", "garmentCount", "sha256"], label);
    if (
      !Number.isSafeInteger(data.associationCount) ||
      data.associationCount < 0 ||
      !Number.isSafeInteger(data.garmentCount) ||
      data.garmentCount < 0 ||
      !DIGEST_RE.test(data.sha256)
    ) {
      fail(`${label} is invalid`);
    }
  }
  exactKeys(
    receipt.restoreProof.legacyResidue,
    ["columns", "constraints", "indexes", "purposeRows", "storageReferences"],
    "restore legacy residue",
  );
  if (
    Object.values(receipt.restoreProof.legacyResidue).some(
      (value) => value !== 0,
    )
  ) {
    fail("database backup receipt contains legacy residue");
  }
  if (!DIGEST_RE.test(receipt.restoreProof.constraintsSha256))
    fail("database restore constraints digest is invalid");
  if (
    canonicalJson(receipt.source.migration) !==
      canonicalJson(receipt.restoreProof.migration) ||
    canonicalJson(receipt.source.tryOnData) !==
      canonicalJson(receipt.restoreProof.tryOnData)
  ) {
    fail("database source and restore receipt facts differ");
  }
  return receipt;
}

async function createReceipt(options, container) {
  if (options.sourceDatabase !== options.expectedDatabaseName)
    fail("source database identity mismatch");
  const migration = migrationFacts(options.repoRoot);
  const source = await databaseFacts(
    options,
    container.containerId,
    options.sourceDatabase,
    migration,
  );
  if (source.databaseName !== options.expectedDatabaseName)
    fail("source database identity mismatch");
  const backupParent = dirname(options.backup);
  const parentStat = lstatSync(backupParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    fail("backup parent is unsafe");
  const staging = join(
    backupParent,
    `.precutover-dump-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let backupPublished = false;
  let receiptPublished = false;
  try {
    const backup = await streamDump(
      options,
      container.containerId,
      options.sourceDatabase,
      staging,
    );
    const restoreProof = await restoreBackup(
      options,
      container.containerId,
      staging,
      migration,
    );
    if (
      restoreProof.migration.chainSha256 !== source.migration.chainSha256 ||
      restoreProof.tryOnData.sha256 !== source.tryOnData.sha256 ||
      restoreProof.constraintsSha256 !== source.constraintsSha256
    ) {
      fail("restored database does not match source database facts");
    }
    linkSync(staging, options.backup);
    backupPublished = true;
    rmSync(staging);
    const receipt = {
      backup,
      restoreProof: {
        constraintsSha256: restoreProof.constraintsSha256,
        databaseName: restoreProof.databaseName,
        legacyResidue: restoreProof.legacyResidue,
        migration: restoreProof.migration,
        tryOnData: restoreProof.tryOnData,
        verifiedAt: restoreProof.verifiedAt,
      },
      schemaVersion: RECEIPT_SCHEMA,
      source: {
        currentLsn: source.currentLsn,
        databaseName: source.databaseName,
        migration: source.migration,
        snapshotTime: source.snapshotTime,
        systemIdentifier: source.systemIdentifier,
        tryOnData: source.tryOnData,
      },
      toolchain: {
        image: PINNED_POSTGRES_IMAGE,
        postgresVersion: container.postgresVersion,
      },
    };
    writeAtomic(options.receipt, canonicalJson(receipt));
    receiptPublished = true;
  } finally {
    rmSync(staging, { force: true });
    if (backupPublished && !receiptPublished)
      rmSync(options.backup, { force: true });
  }
}

async function verifyReceipt(options, container) {
  const raw = readFileSync(options.receipt, "utf8");
  const receipt = validateReceipt(raw);
  if (receipt.toolchain.postgresVersion !== container.postgresVersion) {
    fail("database backup tool version does not match its receipt");
  }
  const backup = await fileFacts(options.backup);
  if (canonicalJson(backup) !== canonicalJson(receipt.backup))
    fail("backup size or SHA-256 does not match its receipt");
  const migration = migrationFacts(options.repoRoot);
  const restore = await restoreBackup(
    options,
    container.containerId,
    options.backup,
    migration,
  );
  if (
    canonicalJson(restore.migration) !==
      canonicalJson(receipt.source.migration) ||
    restore.tryOnData.sha256 !== receipt.source.tryOnData.sha256 ||
    restore.constraintsSha256 !== receipt.restoreProof.constraintsSha256 ||
    Object.values(restore.legacyResidue).some((value) => value !== 0)
  ) {
    fail("restored backup does not match its receipt proof");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const container = await validateContainer(options);
  if (options.command === "create") await createReceipt(options, container);
  else await verifyReceipt(options, container);
  process.stdout.write(`${options.receipt}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `precutover database backup proof failed: ${error.message}\n`,
  );
  process.exitCode = 1;
});
