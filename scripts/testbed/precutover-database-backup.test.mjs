import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { reproveDatabaseBackup } from "../precutover-database-backup.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const cli = join(repoRoot, "scripts/precutover-database-backup.mjs");
const image =
  "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20";
const container = `vem-precutover-pg-${process.pid}`;
const temporary = mkdtempSync(join(tmpdir(), "vem-precutover-pg-"));
const sourceDatabase = "vem_precutover_source";
const dockerBytes = readFileSync("/usr/bin/docker");
const dockerSha256 = `sha256:${createHash("sha256")
  .update(dockerBytes)
  .digest("hex")}`;
const dockerByteSize = statSync("/usr/bin/docker").size;
const dockerVersion = execFileSync("/usr/bin/docker", ["--version"], {
  encoding: "utf8",
}).trim();
let baselineCatalogSha256;

function canonical(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  return `${JSON.stringify(sort(value))}\n`;
}

function pinnedToolArgs() {
  return [
    "--docker-binary",
    "/usr/bin/docker",
    "--expected-docker-byte-size",
    String(dockerByteSize),
    "--expected-docker-sha256",
    dockerSha256,
    "--expected-docker-version",
    dockerVersion,
  ];
}

function docker(args, options = {}) {
  return execFileSync("/usr/bin/docker", args, {
    encoding: "utf8",
    ...options,
  }).trim();
}

function run(args) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      resolveResult({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

async function waitForPostgres() {
  let consecutive = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const ready = execFileSync(
        "/usr/bin/docker",
        [
          "exec",
          "--user",
          "postgres",
          container,
          "/usr/bin/psql",
          "-AtX",
          "--dbname",
          "postgres",
          "--command",
          "SELECT 1",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      consecutive = ready.trim() === "1" ? consecutive + 1 : 0;
      if (consecutive === 2) return;
    } catch {
      consecutive = 0;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("test-owned PostgreSQL did not become ready");
}

function psql(database, sql) {
  return docker(
    [
      "exec",
      "--interactive",
      "--user",
      "postgres",
      container,
      "/usr/bin/psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-X",
      "--dbname",
      database,
    ],
    { input: sql },
  );
}

function migrateAndSeed() {
  psql(
    sourceDatabase,
    'CREATE SCHEMA drizzle; CREATE TABLE drizzle."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);',
  );
  const migrationsRoot = join(repoRoot, "packages/db/drizzle");
  const directories = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && /^20\d{12}_[a-z0-9_]+$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  assert.equal(directories.length, 45);
  for (const directory of directories) {
    const sql = readFileSync(
      join(migrationsRoot, directory, "migration.sql"),
      "utf8",
    );
    const hash = createHash("sha256").update(sql).digest("hex");
    const stamp = Date.UTC(
      Number(directory.slice(0, 4)),
      Number(directory.slice(4, 6)) - 1,
      Number(directory.slice(6, 8)),
      Number(directory.slice(8, 10)),
      Number(directory.slice(10, 12)),
      Number(directory.slice(12, 14)),
    );
    psql(
      sourceDatabase,
      `BEGIN;\n${sql.replaceAll("--> statement-breakpoint", "")}\nINSERT INTO drizzle."__drizzle_migrations"(hash,created_at) VALUES ('${hash}',${stamp});\nCOMMIT;\n`,
    );
  }
  psql(
    sourceDatabase,
    `INSERT INTO media_assets(id,purpose,storage_provider,storage_key,content_type,byte_size,sha256,public_url,width,height,has_transparency)
     VALUES ('00000000-0000-4000-8000-000000000001','try_on_garment','test','garment.png','image/png',7,repeat('a',64),'https://example.test/garment.png',512,512,true);
     INSERT INTO products(id,name,status,sort_order)
     VALUES ('00000000-0000-4000-8000-000000000002','receipt product','active',0);
     INSERT INTO try_on_garments(id,product_id,color_label,source_media_asset_id,template,status,confirmed_at)
     VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','blue','00000000-0000-4000-8000-000000000001','tshirt_short_sleeve','active',now());
     INSERT INTO product_variants(id,product_id,sku,price_cents,status,try_on_garment_id,target_gender)
     VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','RECEIPT-SKU',100,'active','00000000-0000-4000-8000-000000000003','female');`,
  );
}

before(async () => {
  try {
    docker(["rm", "-f", container], { stdio: "ignore" });
  } catch {}
  docker([
    "run",
    "--detach",
    "--name",
    container,
    "--env",
    "POSTGRES_PASSWORD=precutover-test-password",
    image,
  ]);
  await waitForPostgres();
  psql("postgres", `CREATE DATABASE ${sourceDatabase};`);
  migrateAndSeed();
});

after(() => {
  try {
    docker(["rm", "-f", container], { stdio: "ignore" });
  } catch {}
  rmSync(temporary, { recursive: true, force: true });
});

describe("precutover PostgreSQL backup receipt", () => {
  it("creates, restores, and proves a PG16 custom backup", async () => {
    const backup = join(temporary, "precutover.dump");
    const receiptPath = join(temporary, "precutover-database.json");
    const result = await run([
      "create",
      ...pinnedToolArgs(),
      "--container",
      container,
      "--source-database",
      sourceDatabase,
      "--expected-database-name",
      sourceDatabase,
      "--source-user",
      "postgres",
      "--repo-root",
      repoRoot,
      "--backup",
      backup,
      "--receipt",
      receiptPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const raw = readFileSync(receiptPath, "utf8");
    const receipt = JSON.parse(raw);
    assert.equal(receipt.schemaVersion, "vem.precutover.database-backup.v1");
    assert.equal(receipt.trustStatus, "pending_release_set_approval");
    assert.equal(receipt.source.databaseName, sourceDatabase);
    assert.match(receipt.source.snapshotId, /^[A-Fa-f0-9-]{3,128}$/);
    assert.equal(
      receipt.source.migration.target,
      "20260810000000_hard_delete_legacy_try_on_data",
    );
    assert.equal(receipt.source.migration.count, 45);
    assert.equal(receipt.source.catalogData.garmentCount, 1);
    assert.equal(receipt.source.catalogData.associationCount, 1);
    assert.equal(receipt.source.catalogData.mediaAssetCount, 1);
    assert.equal(receipt.source.catalogData.productCount, 1);
    assert.equal(receipt.source.catalogData.variantCount, 1);
    baselineCatalogSha256 = receipt.source.catalogData.sha256;
    assert.equal(receipt.toolchain.docker.byteSize, dockerByteSize);
    assert.equal(receipt.toolchain.docker.sha256, dockerSha256);
    assert.equal(receipt.toolchain.docker.version, dockerVersion);
    assert.equal(receipt.toolchain.image, image);
    assert.match(receipt.toolchain.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(receipt.toolchain.pgDump.path, "/usr/bin/pg_dump");
    assert.equal(receipt.toolchain.pgRestore.path, "/usr/bin/pg_restore");
    assert.equal(receipt.toolchain.psql.path, "/usr/bin/psql");
    assert.match(receipt.toolchain.serverVersion, /^16\d{4}$/);
    assert.equal(receipt.restoreProof.migration.count, 45);
    assert.equal(
      receipt.restoreProof.catalogData.sha256,
      receipt.source.catalogData.sha256,
    );
    assert.deepEqual(receipt.restoreProof.legacyResidue, {
      columns: 0,
      constraints: 0,
      indexes: 0,
      purposeRows: 0,
      storageReferences: 0,
    });
    assert.equal(raw, `${JSON.stringify(receipt)}\n`);
    assert.ok(readFileSync(backup).subarray(0, 5).equals(Buffer.from("PGDMP")));
    const leftovers = docker([
      "exec",
      "--user",
      "postgres",
      container,
      "/usr/bin/psql",
      "-AtX",
      "--dbname",
      "postgres",
      "--command",
      "SELECT count(*) FROM pg_database WHERE datname LIKE 'vem_precutover_restore_%'",
    ]);
    assert.equal(leftovers, "0");

    const reproof = await reproveDatabaseBackup({
      backupPath: backup,
      container,
      dockerBinary: "/usr/bin/docker",
      expectedDockerByteSize: dockerByteSize,
      expectedDockerSha256: dockerSha256,
      expectedDockerVersion: dockerVersion,
      receiptText: raw,
      repoRoot,
      sourceUser: "postgres",
    });
    assert.equal(reproof.backup.sha256, receipt.backup.sha256);
    assert.equal(reproof.catalogData.sha256, receipt.source.catalogData.sha256);
    assert.equal(reproof.migration.count, 45);

    const forged = structuredClone(receipt);
    const forgedCatalogSha256 = `sha256:${"f".repeat(64)}`;
    forged.source.catalogData.sha256 = forgedCatalogSha256;
    forged.restoreProof.catalogData.sha256 = forgedCatalogSha256;
    await assert.rejects(
      reproveDatabaseBackup({
        backupPath: backup,
        container,
        dockerBinary: "/usr/bin/docker",
        expectedDockerByteSize: dockerByteSize,
        expectedDockerSha256: dockerSha256,
        expectedDockerVersion: dockerVersion,
        receiptText: canonical(forged),
        repoRoot,
        sourceUser: "postgres",
      }),
      /restored facts differ/i,
      "a structurally valid, self-consistent pending receipt must not replace an isolated restore",
    );

    const forgedToolchain = structuredClone(receipt);
    forgedToolchain.toolchain.docker.version =
      "Docker version 99.0.0, build attacker";
    await assert.rejects(
      reproveDatabaseBackup({
        backupPath: backup,
        container,
        dockerBinary: "/usr/bin/docker",
        expectedDockerByteSize: dockerByteSize,
        expectedDockerSha256: dockerSha256,
        expectedDockerVersion: dockerVersion,
        receiptText: canonical(forgedToolchain),
        repoRoot,
        sourceUser: "postgres",
      }),
      /toolchain differs/i,
    );

    const validSelfInspection = await run([
      "verify",
      "--docker-binary",
      "/usr/bin/docker",
      "--container",
      container,
      "--source-user",
      "postgres",
      "--repo-root",
      repoRoot,
      "--backup",
      backup,
      "--receipt",
      receiptPath,
    ]);
    assert.notEqual(
      validSelfInspection.status,
      0,
      "an unapproved receipt must have no production verify path",
    );
    assert.match(validSelfInspection.stderr, /create.*only|unknown command/i);
  });

  it("dumps the same exported snapshot while all catalog facts change", async () => {
    psql(
      sourceDatabase,
      "CREATE TABLE snapshot_padding(payload text); INSERT INTO snapshot_padding SELECT repeat('x',5000) FROM generate_series(1,2000)",
    );
    const backup = join(temporary, "snapshot.dump");
    const receiptPath = join(temporary, "snapshot.json");
    const pending = run([
      "create",
      ...pinnedToolArgs(),
      "--container",
      container,
      "--source-database",
      sourceDatabase,
      "--expected-database-name",
      sourceDatabase,
      "--source-user",
      "postgres",
      "--repo-root",
      repoRoot,
      "--backup",
      backup,
      "--receipt",
      receiptPath,
    ]);
    try {
      let exported = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const count = psql(
          sourceDatabase,
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%pg_export_snapshot%'",
        );
        if (count !== "0") {
          exported = true;
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.equal(
        exported,
        true,
        "the production CLI exported a live snapshot",
      );
      psql(
        sourceDatabase,
        `UPDATE media_assets SET storage_key='garment-mutated.png',byte_size=8,sha256=repeat('b',64);
       UPDATE products SET name='receipt product mutated';
       UPDATE try_on_garments SET color_label='green';
       UPDATE product_variants SET price_cents=101,try_on_garment_id=NULL`,
      );
      const snapshotResult = await pending;
      assert.equal(snapshotResult.status, 0, snapshotResult.stderr);
      const snapshotReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.equal(
        snapshotReceipt.source.catalogData.sha256,
        baselineCatalogSha256,
      );
      assert.equal(
        snapshotReceipt.restoreProof.catalogData.sha256,
        baselineCatalogSha256,
      );

      const changedReceiptPath = join(temporary, "changed.json");
      const changed = await run([
        "create",
        ...pinnedToolArgs(),
        "--container",
        container,
        "--source-database",
        sourceDatabase,
        "--expected-database-name",
        sourceDatabase,
        "--source-user",
        "postgres",
        "--repo-root",
        repoRoot,
        "--backup",
        join(temporary, "changed.dump"),
        "--receipt",
        changedReceiptPath,
      ]);
      assert.equal(changed.status, 0, changed.stderr);
      const changedReceipt = JSON.parse(
        readFileSync(changedReceiptPath, "utf8"),
      );
      assert.notEqual(
        changedReceipt.source.catalogData.sha256,
        baselineCatalogSha256,
      );
      assert.equal(changedReceipt.source.catalogData.associationCount, 0);
    } finally {
      await pending;
      psql(
        sourceDatabase,
        `UPDATE media_assets SET storage_key='garment.png',byte_size=7,sha256=repeat('a',64);
       UPDATE products SET name='receipt product';
       UPDATE try_on_garments SET color_label='blue';
       UPDATE product_variants SET price_cents=100,try_on_garment_id='00000000-0000-4000-8000-000000000003';
       DROP TABLE IF EXISTS snapshot_padding`,
      );
    }
  });

  it("rejects the wrong source database identity", async () => {
    const result = await run([
      "create",
      ...pinnedToolArgs(),
      "--container",
      container,
      "--source-database",
      "postgres",
      "--source-user",
      "postgres",
      "--repo-root",
      repoRoot,
      "--backup",
      join(temporary, "wrong.dump"),
      "--receipt",
      join(temporary, "wrong.json"),
      "--expected-database-name",
      sourceDatabase,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /database identity/i);
  });

  it("rejects a Docker binary outside the external size/SHA/version pin", async () => {
    const result = await run([
      "create",
      ...pinnedToolArgs().map((value) =>
        value === dockerSha256 ? `sha256:${"0".repeat(64)}` : value,
      ),
      "--container",
      container,
      "--source-database",
      sourceDatabase,
      "--expected-database-name",
      sourceDatabase,
      "--source-user",
      "postgres",
      "--repo-root",
      repoRoot,
      "--backup",
      join(temporary, "wrong-tool.dump"),
      "--receipt",
      join(temporary, "wrong-tool.json"),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Docker binary.*pin/i);
  });

  it("rejects a source whose applied migration chain drifted", async () => {
    const originalHash = psql(
      sourceDatabase,
      'SELECT hash FROM drizzle."__drizzle_migrations" ORDER BY created_at DESC,id DESC LIMIT 1',
    );
    psql(
      sourceDatabase,
      `UPDATE drizzle."__drizzle_migrations" SET hash=repeat('0',64) WHERE id=(SELECT max(id) FROM drizzle."__drizzle_migrations")`,
    );
    try {
      const result = await run([
        "create",
        ...pinnedToolArgs(),
        "--container",
        container,
        "--source-database",
        sourceDatabase,
        "--expected-database-name",
        sourceDatabase,
        "--source-user",
        "postgres",
        "--repo-root",
        repoRoot,
        "--backup",
        join(temporary, "drifted.dump"),
        "--receipt",
        join(temporary, "drifted.json"),
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /migration chain/i);
    } finally {
      psql(
        sourceDatabase,
        `UPDATE drizzle."__drizzle_migrations" SET hash='${originalHash}' WHERE id=(SELECT max(id) FROM drizzle."__drizzle_migrations")`,
      );
    }
  });
});
