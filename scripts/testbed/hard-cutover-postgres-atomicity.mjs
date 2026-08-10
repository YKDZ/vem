#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const pg = require(
  resolve(import.meta.dirname, "../../packages/db/node_modules/pg"),
);

const root = resolve(import.meta.dirname, "../..");
const migrationsRoot = resolve(root, "packages/db/drizzle");
const cutoverDirectory = "20260810000000_hard_delete_legacy_try_on_data";
const cutoverSql = readFileSync(
  join(migrationsRoot, cutoverDirectory, "migration.sql"),
  "utf8",
);
const databaseUrl = process.env.DATABASE_URL;

if (process.env.VEM_D2_PG16_PROOF !== "1") {
  throw new Error(
    "VEM_D2_PG16_PROOF=1 is required before this destructive PostgreSQL proof",
  );
}
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for PostgreSQL hard-cutover proof");
if (new URL(databaseUrl).pathname !== "/vem_d2_proof") {
  throw new Error(
    "PostgreSQL hard-cutover proof only permits the vem_d2_proof database",
  );
}

const historyDirectories = Object.freeze(
  readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("20"))
    .map((entry) => entry.name)
    .sort()
    .filter((directory) => directory !== cutoverDirectory),
);

assert.equal(
  historyDirectories.length,
  44,
  "pre-D2 chain remains 44 migrations",
);
assert.doesNotMatch(
  cutoverSql,
  /\b(?:BEGIN|COMMIT)\b/i,
  "D2 relies on Drizzle transaction",
);

const legacyColumn = cutoverSql.match(/DROP COLUMN "([^"]+)"/)?.[1];
const legacyPurpose = cutoverSql.match(/asset\."purpose" = '([^']+)'/)?.[1];
assert.ok(legacyColumn, "D2 identifies one physical legacy planogram column");
assert.ok(legacyPurpose, "D2 identifies one legacy media purpose");

function migrationConfig(out) {
  const config = join(out, "drizzle.config.ts");
  writeFileSync(
    config,
    `import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "postgresql", schema: ${JSON.stringify(resolve(root, "packages/db/src/drizzle/schema/schema.ts"))}, out: ${JSON.stringify(out)}, dbCredentials: { url: process.env.DATABASE_URL, ssl: false } });\n`,
  );
  return config;
}

function migrate(directories) {
  const temp = mkdtempSync(join(tmpdir(), "vem-d2-pg-migrations-"));
  try {
    for (const directory of directories) {
      cpSync(join(migrationsRoot, directory), join(temp, directory), {
        recursive: true,
      });
    }
    execFileSync(
      "pnpm",
      [
        "--filter",
        "@vem/db",
        "exec",
        "drizzle-kit",
        "migrate",
        "--config",
        migrationConfig(temp),
      ],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "inherit",
      },
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function query(client, text, values = []) {
  return await client.query(text, values);
}

async function seedPreD2(client) {
  const ids = {
    legacyAsset: "00000000-0000-4000-8000-000000000001",
    newAsset: "00000000-0000-4000-8000-000000000002",
    legacyProduct: "00000000-0000-4000-8000-000000000011",
    newProduct: "00000000-0000-4000-8000-000000000012",
    legacyGarment: "00000000-0000-4000-8000-000000000021",
    newGarment: "00000000-0000-4000-8000-000000000022",
    legacyVariantA: "00000000-0000-4000-8000-000000000031",
    legacyVariantB: "00000000-0000-4000-8000-000000000032",
    newVariant: "00000000-0000-4000-8000-000000000033",
  };
  await query(
    client,
    `INSERT INTO "media_assets"(id,purpose,storage_provider,storage_key,content_type,byte_size,sha256,public_url,width,height,has_transparency) VALUES
    ($1,$2,'test','legacy.png','image/png',1,repeat('a',64),'https://example.test/legacy.png',512,512,true),
    ($3,'try_on_garment','test','new.png','image/png',1,repeat('b',64),'https://example.test/new.png',512,512,true)`,
    [ids.legacyAsset, legacyPurpose, ids.newAsset],
  );
  await query(
    client,
    `INSERT INTO "products"(id,name,status,sort_order,display_image_media_asset_id) VALUES
    ($1,'legacy display','active',0,$2),($3,'new display','active',0,$4)`,
    [ids.legacyProduct, ids.legacyAsset, ids.newProduct, ids.newAsset],
  );
  await query(
    client,
    `INSERT INTO "try_on_garments"(id,product_id,color_label,source_media_asset_id,template,status) VALUES
    ($1,$2,'legacy',$3,'tshirt_short_sleeve','active'),($4,$5,'new',$6,'tshirt_short_sleeve','active')`,
    [
      ids.legacyGarment,
      ids.legacyProduct,
      ids.legacyAsset,
      ids.newGarment,
      ids.newProduct,
      ids.newAsset,
    ],
  );
  await query(
    client,
    `INSERT INTO "product_variants"(id,product_id,sku,price_cents,status,try_on_garment_id) VALUES
    ($1,$2,'LEGACY-A',100,'active',$3),($4,$2,'LEGACY-B',100,'active',$3),($5,$6,'NEW-A',100,'active',$7)`,
    [
      ids.legacyVariantA,
      ids.legacyProduct,
      ids.legacyGarment,
      ids.legacyVariantB,
      ids.newVariant,
      ids.newProduct,
      ids.newGarment,
    ],
  );
  return ids;
}

async function assertPreD2(client, ids) {
  const result = await query(
    client,
    `SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_name='machine_planogram_slots' AND column_name=$1) AS legacy_column,
    (SELECT count(*) FROM "media_assets" WHERE id=$2) AS legacy_asset,
    (SELECT count(*) FROM "try_on_garments" WHERE id=$3) AS legacy_garment,
    (SELECT count(*) FROM "product_variants" WHERE try_on_garment_id=$3) AS legacy_variants,
    (SELECT count(*) FROM "product_variants" WHERE id=$4 AND try_on_garment_id=$5) AS new_variant,
    (SELECT count(*) FROM drizzle."__drizzle_migrations") AS migration_count`,
    [
      legacyColumn,
      ids.legacyAsset,
      ids.legacyGarment,
      ids.newVariant,
      ids.newGarment,
    ],
  );
  assert.deepEqual(result.rows[0], {
    legacy_column: "1",
    legacy_asset: "1",
    legacy_garment: "1",
    legacy_variants: "2",
    new_variant: "1",
    migration_count: "44",
  });
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await query(
    client,
    `DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public`,
  );
  migrate(historyDirectories);
  const ids = await seedPreD2(client);
  await assertPreD2(client, ids);

  await query(client, "BEGIN");
  await query(client, cutoverSql);
  await query(client, "ROLLBACK");
  await assertPreD2(client, ids);

  await query(client, "BEGIN");
  await query(client, cutoverSql);
  await client.end();
  const aborted = new pg.Client({ connectionString: databaseUrl });
  await aborted.connect();
  await assertPreD2(aborted, ids);
  await aborted.end();

  migrate([...historyDirectories, cutoverDirectory]);
  const normal = new pg.Client({ connectionString: databaseUrl });
  await normal.connect();
  const migrated = await query(
    normal,
    `SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_name='machine_planogram_slots' AND column_name=$1) AS legacy_column,
    (SELECT count(*) FROM "media_assets" WHERE id=$2) AS legacy_asset,
    (SELECT count(*) FROM "try_on_garments" WHERE id=$3) AS legacy_garment,
    (SELECT count(*) FROM "product_variants" WHERE try_on_garment_id=$3) AS legacy_variants,
    (SELECT count(*) FROM "product_variants" WHERE id=$4 AND try_on_garment_id=$5) AS new_variant,
    (SELECT count(*) FROM drizzle."__drizzle_migrations") AS migration_count`,
    [
      legacyColumn,
      ids.legacyAsset,
      ids.legacyGarment,
      ids.newVariant,
      ids.newGarment,
    ],
  );
  assert.deepEqual(migrated.rows[0], {
    legacy_column: "0",
    legacy_asset: "0",
    legacy_garment: "0",
    legacy_variants: "0",
    new_variant: "1",
    migration_count: "45",
  });
  await normal.end();
  migrate([...historyDirectories, cutoverDirectory]);
  const repeated = new pg.Client({ connectionString: databaseUrl });
  await repeated.connect();
  const repeatedHistory = await query(
    repeated,
    'SELECT count(*) AS migration_count FROM drizzle."__drizzle_migrations"',
  );
  assert.deepEqual(repeatedHistory.rows, [{ migration_count: "45" }]);
  await repeated.end();
  process.stdout.write("PostgreSQL D2 atomicity proof passed.\n");
} finally {
  await client.end().catch(() => undefined);
}
