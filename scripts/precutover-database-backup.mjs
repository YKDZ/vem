#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { runOwnedCommand, startOwnedProcess } from "./lib/owned-process.mjs";
import { validateDatabaseBackupReceiptText } from "./precutover-receipts.mjs";

const RECEIPT_SCHEMA = "vem.precutover.database-backup.v1";
const PINNED_POSTGRES_IMAGE =
  "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const DATABASE_RE = /^[a-z][a-z0-9_]{0,62}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const COMMAND_DEADLINE_MS = 30_000;
const DATABASE_OPERATION_DEADLINE_MS = 300_000;
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
  if (command !== "create") {
    fail("create is the only production database-backup command");
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
    "expected-docker-byte-size",
    "expected-docker-sha256",
    "expected-docker-version",
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
    ["expectedDockerByteSize", "expected-docker-byte-size"],
    ["expectedDockerSha256", "expected-docker-sha256"],
    ["expectedDockerVersion", "expected-docker-version"],
  ]) {
    if (!values[key]) fail(`--${flag} is required`);
  }
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
  const expectedDockerByteSize = Number(values.expectedDockerByteSize);
  if (
    !Number.isSafeInteger(expectedDockerByteSize) ||
    expectedDockerByteSize <= 0 ||
    !DIGEST_RE.test(values.expectedDockerSha256) ||
    values.expectedDockerVersion.length > 256
  ) {
    fail("external Docker binary pin is invalid");
  }
  values.expectedDockerByteSize = expectedDockerByteSize;
  return { command, ...values };
}

async function verifyAbsoluteExecutable(path, options) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (stat.mode & 0o111) === 0
  ) {
    fail("docker binary must be an absolute real regular executable");
  }
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    byteSize += chunk.byteLength;
    digest.update(chunk);
  }
  const sha256Value = `sha256:${digest.digest("hex")}`;
  if (
    byteSize !== options.expectedDockerByteSize ||
    sha256Value !== options.expectedDockerSha256
  ) {
    fail("Docker binary does not match its external size/SHA-256 pin");
  }
  const version = await run(path, ["--version"]);
  if (version !== options.expectedDockerVersion) {
    fail("Docker binary does not match its external version pin");
  }
  return { byteSize, path, sha256: sha256Value, version };
}

function run(
  binary,
  args,
  {
    input,
    maximum = MAX_COMMAND_OUTPUT,
    deadlineMs = COMMAND_DEADLINE_MS,
  } = {},
) {
  return runOwnedCommand(binary, args, {
    deadlineMs,
    input,
    maximumOutputBytes: maximum,
  });
}

function containerTool(tool, args, deadlineMs = COMMAND_DEADLINE_MS) {
  const innerSeconds = Math.max(1, Math.floor((deadlineMs - 5_000) / 1_000));
  return [
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=5s",
    `${innerSeconds}s`,
    tool,
    ...args,
  ];
}

async function validateContainer(options) {
  const docker = await verifyAbsoluteExecutable(options.dockerBinary, options);
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
      ...containerTool(`/usr/bin/${tool}`, ["--version"]),
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
  return {
    containerId: container.Id,
    docker,
    image: PINNED_POSTGRES_IMAGE,
    imageId: container.Image,
    pgDumpVersion: versions[0],
    pgRestoreVersion: versions[1],
    psqlVersion: versions[2],
    serverVersion,
  };
}

async function psql(
  options,
  containerId,
  database,
  sql,
  maximum = MAX_COMMAND_OUTPUT,
) {
  return await run(
    options.dockerBinary,
    [
      "exec",
      "--user",
      "postgres",
      containerId,
      ...containerTool("/usr/bin/psql", [
        "-v",
        "ON_ERROR_STOP=1",
        "-AtX",
        "--dbname",
        database,
        "--username",
        options.sourceUser,
        "--command",
        sql,
      ]),
    ],
    { maximum },
  );
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
  'catalogData',json_build_object(
    'mediaAssets',(SELECT coalesce(json_agg(to_jsonb(m) ORDER BY m.id),'[]'::json) FROM media_assets m),
    'products',(SELECT coalesce(json_agg(to_jsonb(p) ORDER BY p.id),'[]'::json) FROM products p),
    'variants',(SELECT coalesce(json_agg(to_jsonb(v) ORDER BY v.id),'[]'::json) FROM product_variants v),
    'garments',(SELECT coalesce(json_agg(to_jsonb(g) ORDER BY g.id),'[]'::json) FROM try_on_garments g),
    'associations',(SELECT coalesce(json_agg(json_build_object(
      'garmentId',v.try_on_garment_id::text,'productId',v.product_id::text,'variantId',v.id::text)
      ORDER BY v.try_on_garment_id,v.id),'[]'::json)
      FROM product_variants v WHERE v.try_on_garment_id IS NOT NULL)
  )
)`;

function validateDatabaseFacts(raw, database, expectedMigration) {
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
  exactKeys(
    raw.catalogData,
    ["associations", "garments", "mediaAssets", "products", "variants"],
    "catalog data proof",
  );
  for (const [key, rows] of Object.entries(raw.catalogData)) {
    if (!Array.isArray(rows)) fail(`catalog data ${key} is invalid`);
  }
  const catalogData = {
    associationCount: raw.catalogData.associations.length,
    garmentCount: raw.catalogData.garments.length,
    mediaAssetCount: raw.catalogData.mediaAssets.length,
    productCount: raw.catalogData.products.length,
    sha256: sha256(canonicalJson(raw.catalogData)),
    variantCount: raw.catalogData.variants.length,
  };
  return {
    databaseName: raw.databaseName,
    systemIdentifier: raw.systemIdentifier,
    currentLsn: raw.currentLsn,
    snapshotTime: raw.snapshotTime,
    migration: expectedMigration.receipt,
    constraints: EXPECTED_CONSTRAINTS,
    constraintsSha256: sha256(canonicalJson(EXPECTED_CONSTRAINTS)),
    legacyResidue,
    catalogData,
  };
}

async function databaseFacts(
  options,
  containerId,
  database,
  expectedMigration,
) {
  let raw;
  try {
    raw = JSON.parse(
      await psql(
        options,
        containerId,
        database,
        DATABASE_FACTS_SQL,
        64 * 1024 * 1024,
      ),
    );
  } catch (error) {
    fail(`database migration or schema proof failed: ${error.message}`);
  }
  return validateDatabaseFacts(raw, database, expectedMigration);
}

async function openSourceSnapshot(options, containerId, database) {
  const owned = startOwnedProcess(
    options.dockerBinary,
    [
      "exec",
      "--interactive",
      "--user",
      "postgres",
      containerId,
      ...containerTool(
        "/usr/bin/psql",
        [
          "-v",
          "ON_ERROR_STOP=1",
          "-qAtX",
          "--dbname",
          database,
          "--username",
          options.sourceUser,
        ],
        DATABASE_OPERATION_DEADLINE_MS,
      ),
    ],
    {
      deadlineMs: DATABASE_OPERATION_DEADLINE_MS,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const { child } = owned;
  const stderr = [];
  let stderrSize = 0;
  let streamFailure;
  let stdoutSize = 0;
  let stdout = Buffer.alloc(0);
  child.stderr.on("data", (chunk) => {
    stderrSize += chunk.byteLength;
    if (stderrSize <= MAX_COMMAND_OUTPUT) stderr.push(Buffer.from(chunk));
    else {
      streamFailure = new Error("snapshot stderr exceeded its output cap");
      void owned.terminate();
    }
  });
  const firstLine = new Promise((resolveLine, reject) => {
    const onData = (chunk) => {
      stdoutSize += chunk.byteLength;
      if (stdoutSize > 64 * 1024 * 1024) {
        streamFailure = new Error(
          "database snapshot facts exceed their output cap",
        );
        void owned.terminate();
        reject(streamFailure);
        return;
      }
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      const newline = stdout.indexOf(0x0a);
      if (newline >= 0) {
        child.stdout.off("data", onData);
        resolveLine(stdout.subarray(0, newline).toString("utf8"));
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", () => {
      if (!stdout.includes(0x0a)) {
        reject(
          streamFailure ??
            new Error(
              `snapshot transaction ended before export: ${Buffer.concat(stderr).toString("utf8").trim()}`,
            ),
        );
      }
    });
  });
  child.stdin.write(
    `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT json_build_object('snapshotId',pg_export_snapshot(),'facts',(${DATABASE_FACTS_SQL}));\n`,
  );
  let exported;
  try {
    exported = JSON.parse(await firstLine);
    exactKeys(exported, ["facts", "snapshotId"], "exported database snapshot");
    if (!/^[A-Fa-f0-9-]{3,128}$/.test(exported.snapshotId)) {
      fail("exported database snapshot identity is invalid");
    }
  } catch (error) {
    await owned.terminate();
    throw error;
  }
  let finished = false;
  const finish = async (commit) => {
    if (finished) fail("database snapshot transaction was already closed");
    finished = true;
    if (!commit) {
      await owned.terminate();
      return;
    }
    child.stdin.end("COMMIT;\n\\q\n");
    let result;
    try {
      result = await owned.wait();
    } catch (error) {
      fail(`database snapshot transaction failed: ${error.message}`);
    }
    if (streamFailure || result.status !== 0) {
      fail(
        streamFailure?.message ??
          `database snapshot transaction failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
      );
    }
  };
  return {
    abort: async () => await finish(false),
    commit: async () => await finish(true),
    facts: exported.facts,
    snapshotId: exported.snapshotId,
  };
}

async function streamDump(options, containerId, database, snapshotId, staging) {
  const owned = startOwnedProcess(
    options.dockerBinary,
    [
      "exec",
      "--user",
      "postgres",
      containerId,
      ...containerTool(
        "/usr/bin/pg_dump",
        [
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          `--snapshot=${snapshotId}`,
          "--dbname",
          database,
          "--username",
          options.sourceUser,
        ],
        DATABASE_OPERATION_DEADLINE_MS,
      ),
    ],
    {
      deadlineMs: DATABASE_OPERATION_DEADLINE_MS,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const { child } = owned;
  const digest = createHash("sha256");
  let byteSize = 0;
  const stderr = [];
  let stderrSize = 0;
  let stderrExceeded = false;
  child.stderr.on("data", (chunk) => {
    stderrSize += chunk.byteLength;
    if (stderrSize <= MAX_COMMAND_OUTPUT) stderr.push(Buffer.from(chunk));
    else {
      stderrExceeded = true;
      void owned.terminate();
    }
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
  try {
    const streamed = pipeline(
      child.stdout,
      meter,
      createWriteStream(staging, { flags: "wx", mode: 0o600 }),
    ).catch((error) => {
      void owned.terminate();
      throw error;
    });
    const results = await Promise.allSettled([streamed, owned.wait()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    const processResult = results[1].value;
    if (stderrExceeded) fail("pg_dump stderr exceeded its output cap");
    if (processResult.status !== 0) {
      fail(
        `pg_dump failed (${processResult.status ?? processResult.signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
      );
    }
  } catch (error) {
    await owned.terminate();
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

function fileIdentity(stat) {
  return {
    ctimeNs: stat.ctimeNs.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
  };
}

function sameIdentity(left, right) {
  return (
    canonicalJson(fileIdentity(left)) === canonicalJson(fileIdentity(right))
  );
}

async function hashOpenFile(fd, path) {
  const digest = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path, {
    autoClose: false,
    fd,
    start: 0,
  })) {
    byteSize += chunk.byteLength;
    if (byteSize > MAX_BACKUP_BYTES)
      fail("database backup exceeds its size cap");
    digest.update(chunk);
  }
  return {
    byteSize,
    format: "postgresql-custom",
    sha256: `sha256:${digest.digest("hex")}`,
  };
}

function assertOriginalBackupUnchanged(resource) {
  let descriptorStat;
  let pathStat;
  try {
    descriptorStat = fstatSync(resource.sourceFd, { bigint: true });
    pathStat = lstatSync(resource.sourcePath, { bigint: true });
  } catch {
    fail("database backup input changed during reproof");
  }
  if (
    !descriptorStat.isFile() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    !sameIdentity(descriptorStat, resource.sourceIdentity) ||
    !sameIdentity(pathStat, resource.sourceIdentity)
  ) {
    fail("database backup input changed during reproof");
  }
}

async function stageBackupForReproof(sourcePath) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    fail("database backup staging requires O_NOFOLLOW");
  }
  const directory = mkdtempSync(join(tmpdir(), "vem-precutover-reproof-"));
  const stagingPath = join(directory, "backup.dump");
  let sourceFd;
  let stagingFd;
  try {
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      fail("database backup private staging directory is unsafe");
    }
    if (realpathSync(sourcePath) !== sourcePath) {
      fail("database backup input path must be canonical");
    }
    sourceFd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceIdentity = fstatSync(sourceFd, { bigint: true });
    const sourcePathIdentity = lstatSync(sourcePath, { bigint: true });
    if (
      !sourceIdentity.isFile() ||
      sourcePathIdentity.isSymbolicLink() ||
      !sourcePathIdentity.isFile() ||
      !sameIdentity(sourceIdentity, sourcePathIdentity) ||
      sourceIdentity.size <= 0n ||
      sourceIdentity.size > BigInt(MAX_BACKUP_BYTES)
    ) {
      fail("database backup live input is invalid");
    }
    stagingFd = openSync(
      stagingPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_RDWR,
      0o600,
    );
    const digest = createHash("sha256");
    let byteSize = 0;
    for await (const chunk of createReadStream(sourcePath, {
      autoClose: false,
      fd: sourceFd,
      start: 0,
    })) {
      byteSize += chunk.byteLength;
      if (byteSize > MAX_BACKUP_BYTES) {
        fail("database backup exceeds its size cap");
      }
      digest.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        written += writeSync(
          stagingFd,
          chunk,
          written,
          chunk.byteLength - written,
          byteSize - chunk.byteLength + written,
        );
      }
    }
    fsyncSync(stagingFd);
    const stagingIdentity = fstatSync(stagingFd, { bigint: true });
    if (
      !stagingIdentity.isFile() ||
      stagingIdentity.nlink !== 1n ||
      stagingIdentity.size !== BigInt(byteSize)
    ) {
      fail("database backup private staging identity is invalid");
    }
    const resource = {
      byteFacts: {
        byteSize,
        format: "postgresql-custom",
        sha256: `sha256:${digest.digest("hex")}`,
      },
      directory,
      sourceFd,
      sourceIdentity,
      sourcePath,
      stagingFd,
      stagingIdentity,
      stagingPath,
    };
    assertOriginalBackupUnchanged(resource);
    return resource;
  } catch (error) {
    if (stagingFd !== undefined) closeSync(stagingFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function verifyAndCloseStagedBackup(resource) {
  let verificationError;
  try {
    assertOriginalBackupUnchanged(resource);
    const stagingIdentity = fstatSync(resource.stagingFd, { bigint: true });
    const stagingPathIdentity = lstatSync(resource.stagingPath, {
      bigint: true,
    });
    if (
      !sameIdentity(stagingIdentity, resource.stagingIdentity) ||
      !sameIdentity(stagingPathIdentity, resource.stagingIdentity)
    ) {
      fail("database backup private staging changed during reproof");
    }
    const finalFacts = await hashOpenFile(
      resource.stagingFd,
      resource.stagingPath,
    );
    if (canonicalJson(finalFacts) !== canonicalJson(resource.byteFacts)) {
      fail("database backup private staging changed during reproof");
    }
    assertOriginalBackupUnchanged(resource);
  } catch (error) {
    verificationError = error;
  } finally {
    closeSync(resource.stagingFd);
    closeSync(resource.sourceFd);
    rmSync(resource.directory, { recursive: true, force: true });
  }
  if (verificationError) throw verificationError;
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
    const owned = startOwnedProcess(
      options.dockerBinary,
      [
        "exec",
        "--interactive",
        "--user",
        "postgres",
        containerId,
        ...containerTool(
          "/usr/bin/pg_restore",
          [
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
            "--dbname",
            database,
            "--username",
            options.sourceUser,
          ],
          DATABASE_OPERATION_DEADLINE_MS,
        ),
      ],
      {
        deadlineMs: DATABASE_OPERATION_DEADLINE_MS,
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    const { child } = owned;
    const stderr = [];
    let stderrSize = 0;
    let stderrExceeded = false;
    child.stderr.on("data", (chunk) => {
      stderrSize += chunk.byteLength;
      if (stderrSize <= MAX_COMMAND_OUTPUT) stderr.push(Buffer.from(chunk));
      else {
        stderrExceeded = true;
        void owned.terminate();
      }
    });
    try {
      const backupStream =
        typeof backup === "string"
          ? createReadStream(backup)
          : createReadStream(backup.stagingPath, {
              autoClose: false,
              fd: backup.stagingFd,
              start: 0,
            });
      const streamed = pipeline(backupStream, child.stdin).catch((error) => {
        void owned.terminate();
        throw error;
      });
      const restoreResults = await Promise.allSettled([streamed, owned.wait()]);
      const restoreFailure = restoreResults.find(
        (result) => result.status === "rejected",
      );
      if (restoreFailure) throw restoreFailure.reason;
      const processResult = restoreResults[1].value;
      if (stderrExceeded) fail("pg_restore stderr exceeded its output cap");
      if (processResult.status !== 0) {
        fail(
          `pg_restore failed (${processResult.status ?? processResult.signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        );
      }
    } catch (error) {
      await owned.terminate();
      throw error;
    }
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

async function createReceipt(options, container) {
  if (options.sourceDatabase !== options.expectedDatabaseName)
    fail("source database identity mismatch");
  const migration = migrationFacts(options.repoRoot);
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
  let sourceSnapshot;
  try {
    sourceSnapshot = await openSourceSnapshot(
      options,
      container.containerId,
      options.sourceDatabase,
    );
    const source = validateDatabaseFacts(
      sourceSnapshot.facts,
      options.sourceDatabase,
      migration,
    );
    if (source.databaseName !== options.expectedDatabaseName)
      fail("source database identity mismatch");
    const backup = await streamDump(
      options,
      container.containerId,
      options.sourceDatabase,
      sourceSnapshot.snapshotId,
      staging,
    );
    const committedSnapshot = sourceSnapshot;
    sourceSnapshot = undefined;
    await committedSnapshot.commit();
    const restoreProof = await restoreBackup(
      options,
      container.containerId,
      staging,
      migration,
    );
    if (
      restoreProof.migration.chainSha256 !== source.migration.chainSha256 ||
      restoreProof.catalogData.sha256 !== source.catalogData.sha256 ||
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
        catalogData: restoreProof.catalogData,
        constraintsSha256: restoreProof.constraintsSha256,
        databaseName: restoreProof.databaseName,
        legacyResidue: restoreProof.legacyResidue,
        migration: restoreProof.migration,
        verifiedAt: restoreProof.verifiedAt,
      },
      schemaVersion: RECEIPT_SCHEMA,
      source: {
        catalogData: source.catalogData,
        currentLsn: source.currentLsn,
        databaseName: source.databaseName,
        migration: source.migration,
        snapshotId: committedSnapshot.snapshotId,
        snapshotTime: source.snapshotTime,
        systemIdentifier: source.systemIdentifier,
      },
      toolchain: {
        docker: container.docker,
        image: container.image,
        imageId: container.imageId,
        pgDump: {
          path: "/usr/bin/pg_dump",
          version: container.pgDumpVersion,
        },
        pgRestore: {
          path: "/usr/bin/pg_restore",
          version: container.pgRestoreVersion,
        },
        psql: { path: "/usr/bin/psql", version: container.psqlVersion },
        serverVersion: container.serverVersion,
      },
      trustStatus: "pending_release_set_approval",
    };
    writeAtomic(options.receipt, canonicalJson(receipt));
    receiptPublished = true;
  } finally {
    if (sourceSnapshot) await sourceSnapshot.abort();
    rmSync(staging, { force: true });
    if (backupPublished && !receiptPublished)
      rmSync(options.backup, { force: true });
  }
}

export async function reproveDatabaseBackup({
  backupPath,
  container: containerName,
  dockerBinary,
  expectedDockerByteSize,
  expectedDockerSha256,
  expectedDockerVersion,
  receiptText,
  repoRoot,
  sourceUser,
}) {
  const receipt = validateDatabaseBackupReceiptText(receiptText);
  const options = {
    backup: backupPath,
    container: containerName,
    dockerBinary,
    expectedDockerByteSize,
    expectedDockerSha256,
    expectedDockerVersion,
    repoRoot,
    sourceUser,
  };
  for (const path of [backupPath, dockerBinary, repoRoot]) {
    if (!isAbsolute(path)) fail("database reproof paths must be absolute");
  }
  if (!DATABASE_RE.test(sourceUser)) fail("database reproof user is invalid");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) {
    fail("database reproof container identity is invalid");
  }
  const size = Number(expectedDockerByteSize);
  if (!Number.isSafeInteger(size) || size <= 0) {
    fail("database reproof Docker size pin is invalid");
  }
  options.expectedDockerByteSize = size;
  const container = await validateContainer(options);
  const liveToolchain = {
    docker: container.docker,
    image: container.image,
    imageId: container.imageId,
    pgDump: { path: "/usr/bin/pg_dump", version: container.pgDumpVersion },
    pgRestore: {
      path: "/usr/bin/pg_restore",
      version: container.pgRestoreVersion,
    },
    psql: { path: "/usr/bin/psql", version: container.psqlVersion },
    serverVersion: container.serverVersion,
  };
  if (canonicalJson(liveToolchain) !== canonicalJson(receipt.toolchain)) {
    fail("database reproof toolchain differs from the pending receipt");
  }
  const migration = migrationFacts(repoRoot);
  if (
    canonicalJson(migration.receipt) !== canonicalJson(receipt.source.migration)
  ) {
    fail("database reproof migration chain differs from the receipt");
  }
  const stagedBackup = await stageBackupForReproof(backupPath);
  let restored;
  let primaryError;
  try {
    if (
      canonicalJson(stagedBackup.byteFacts) !== canonicalJson(receipt.backup)
    ) {
      fail("database reproof backup bytes differ from the receipt");
    }
    restored = await restoreBackup(
      options,
      container.containerId,
      stagedBackup,
      migration,
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await verifyAndCloseStagedBackup(stagedBackup);
  } catch (error) {
    primaryError = error;
  }
  if (primaryError) throw primaryError;
  if (
    canonicalJson(restored.catalogData) !==
      canonicalJson(receipt.source.catalogData) ||
    restored.constraintsSha256 !== receipt.restoreProof.constraintsSha256 ||
    canonicalJson(restored.legacyResidue) !==
      canonicalJson(receipt.restoreProof.legacyResidue)
  ) {
    fail("database reproof restored facts differ from the pending receipt");
  }
  return {
    backup: stagedBackup.byteFacts,
    catalogData: restored.catalogData,
    migration: migration.receipt,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const container = await validateContainer(options);
  await createReceipt(options, container);
  process.stdout.write(`${options.receipt}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      `precutover database backup proof failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
