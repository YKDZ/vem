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
assert.match(legacyColumn, /^[a-z][a-z0-9_]*$/);
const legacyColumnSql = `"${legacyColumn}"`;
const legacyStoragePrefix = `${legacyPurpose.replaceAll("_", "-")}s`;
const legacyToken = legacyPurpose.split("_").at(-1);
assert.ok(legacyToken, "D2 identifies one legacy media token");

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

function runPublicApiTracer() {
  execFileSync(
    "pnpm",
    [
      "--filter",
      "service-api",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.e2e.config.ts",
      "src/flows/admin-try-on-garment-contract.e2e-spec.ts",
      "-t",
      "projects only an active confirmed explicit association",
      "--reporter=agent",
      "--silent=passed-only",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        BOOTSTRAP_ADMIN_PASSWORD: "AdminPassword123!",
        DATABASE_URL: databaseUrl,
        JWT_REFRESH_SECRET: "service-api-e2e-refresh-secret-0000000001",
        JWT_SECRET: "service-api-e2e-jwt-secret-0000000000000001",
        MACHINE_API_BASE_URL: "http://127.0.0.1:3000/api",
        MACHINE_CLAIM_LOOKUP_HMAC_KEY:
          "service-api-e2e-machine-claim-lookup-key-0001",
        MACHINE_CREDENTIAL_ENCRYPTION_KEY:
          "service-api-e2e-machine-credential-key-0000001",
        MACHINE_JWT_SECRET: "service-api-e2e-machine-jwt-secret-0000001",
        MACHINE_MQTT_URL: "mqtt://127.0.0.1:1883",
        MQTT_URL: "mqtt://127.0.0.1:1883",
        NODE_ENV: "test",
        PAYMENT_MOCK_ENABLED: "true",
        PAYMENT_WEBHOOK_BASE_URL: "http://127.0.0.1:3000/api/payments/webhooks",
        VEM_D2_LEGACY_MEDIA_PURPOSE: legacyPurpose,
        VEM_TEST_POSTGRES_URL: databaseUrl,
      },
      stdio: "inherit",
    },
  );
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
    invalidGenderVariant: "00000000-0000-4000-8000-000000000034",
    machine: "00000000-0000-4000-8000-000000000041",
    machineSlot: "00000000-0000-4000-8000-000000000042",
    planogramVersion: "00000000-0000-4000-8000-000000000043",
    planogramSlot: "00000000-0000-4000-8000-000000000044",
    inventory: "00000000-0000-4000-8000-000000000045",
  };
  await query(
    client,
    `INSERT INTO "media_assets"(id,purpose,storage_provider,storage_key,content_type,byte_size,sha256,public_url,width,height,has_transparency) VALUES
    ($1,$2,'test',$3,'image/png',1,repeat('a',64),$4,512,512,true),
    ($5,'try_on_garment','test','new.png','image/png',1,repeat('b',64),'https://example.test/new.png',512,512,true)`,
    [
      ids.legacyAsset,
      legacyPurpose,
      `${legacyStoragePrefix}/legacy.png`,
      `https://example.test/${legacyStoragePrefix}/legacy.png`,
      ids.newAsset,
    ],
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
    `INSERT INTO "product_variants"(id,product_id,sku,price_cents,status,try_on_garment_id,target_gender) VALUES
    ($1,$2,'LEGACY-A',100,'active',$3,'male'),
    ($4,$2,'LEGACY-B',100,'active',$3,'female'),
    ($5,$6,'NEW-A',100,'active',$7,NULL)`,
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
  await query(
    client,
    `INSERT INTO "machines"(id,code,name) VALUES ($1,'D2-LEGACY-MACHINE','D2 legacy machine')`,
    [ids.machine],
  );
  await query(
    client,
    `INSERT INTO "machine_slots"(id,machine_id,row_no,cell_no,capacity) VALUES ($1,$2,1,1,1)`,
    [ids.machineSlot, ids.machine],
  );
  await query(
    client,
    `INSERT INTO "machine_planogram_versions"(id,machine_id,planogram_version,status) VALUES ($1,$2,'legacy-v1','active')`,
    [ids.planogramVersion, ids.machine],
  );
  await query(
    client,
    `INSERT INTO "machine_planogram_slots"(
      id,machine_planogram_version_id,slot_id,row_no,cell_no,capacity,par_level,
      inventory_id,variant_id,product_id,product_name,sku,price_cents,
      product_sort_order,${legacyColumnSql}
    ) VALUES ($1,$2,$3,1,1,1,1,$4,$5,$6,'legacy display','LEGACY-A',100,0,$7)`,
    [
      ids.planogramSlot,
      ids.planogramVersion,
      ids.machineSlot,
      ids.inventory,
      ids.legacyVariantA,
      ids.legacyProduct,
      `https://example.test/${legacyStoragePrefix}/legacy.png`,
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
    (SELECT count(*) FROM "product_variants" WHERE id IN ($4,$7,$8) AND (target_gender IN ('male','female') OR target_gender IS NULL)) AS legal_target_genders,
    (SELECT count(*) FROM "machine_planogram_slots" WHERE id=$6 AND ${legacyColumnSql} IS NOT NULL) AS legacy_planogram_path,
    (SELECT count(*) FROM drizzle."__drizzle_migrations") AS migration_count`,
    [
      legacyColumn,
      ids.legacyAsset,
      ids.legacyGarment,
      ids.newVariant,
      ids.newGarment,
      ids.planogramSlot,
      ids.legacyVariantA,
      ids.legacyVariantB,
    ],
  );
  assert.deepEqual(result.rows[0], {
    legacy_column: "1",
    legacy_asset: "1",
    legacy_garment: "1",
    legacy_variants: "2",
    new_variant: "1",
    legal_target_genders: "3",
    legacy_planogram_path: "1",
    migration_count: "44",
  });
}

async function assertFinalTryOnCatalog(client) {
  const columns = await query(
    client,
    `SELECT table_name,column_name,data_type,udt_name,is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name IN ('product_variants','try_on_garments')
     ORDER BY table_name,ordinal_position`,
  );
  assert.deepEqual(columns.rows, [
    {
      table_name: "product_variants",
      column_name: "id",
      data_type: "uuid",
      udt_name: "uuid",
      is_nullable: "NO",
    },
    {
      table_name: "product_variants",
      column_name: "product_id",
      data_type: "uuid",
      udt_name: "uuid",
      is_nullable: "NO",
    },
    {
      table_name: "product_variants",
      column_name: "sku",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "NO",
    },
    {
      table_name: "product_variants",
      column_name: "size",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "YES",
    },
    {
      table_name: "product_variants",
      column_name: "color",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "YES",
    },
    {
      table_name: "product_variants",
      column_name: "barcode",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "YES",
    },
    {
      table_name: "product_variants",
      column_name: "price_cents",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "NO",
    },
    {
      table_name: "product_variants",
      column_name: "cost_cents",
      data_type: "integer",
      udt_name: "int4",
      is_nullable: "YES",
    },
    {
      table_name: "product_variants",
      column_name: "status",
      data_type: "USER-DEFINED",
      udt_name: "variant_status",
      is_nullable: "NO",
    },
    {
      table_name: "product_variants",
      column_name: "created_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "NO",
    },
    {
      table_name: "product_variants",
      column_name: "updated_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "NO",
    },
    {
      table_name: "product_variants",
      column_name: "deleted_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "YES",
    },
    {
      table_name: "product_variants",
      column_name: "target_gender",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "YES",
    },
    {
      table_name: "product_variants",
      column_name: "try_on_garment_id",
      data_type: "uuid",
      udt_name: "uuid",
      is_nullable: "YES",
    },
    {
      table_name: "try_on_garments",
      column_name: "id",
      data_type: "uuid",
      udt_name: "uuid",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "product_id",
      data_type: "uuid",
      udt_name: "uuid",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "color_label",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "source_media_asset_id",
      data_type: "uuid",
      udt_name: "uuid",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "template",
      data_type: "character varying",
      udt_name: "varchar",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "status",
      data_type: "USER-DEFINED",
      udt_name: "try_on_garment_status",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "confirmed_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "YES",
    },
    {
      table_name: "try_on_garments",
      column_name: "created_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "updated_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "NO",
    },
    {
      table_name: "try_on_garments",
      column_name: "deleted_at",
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      is_nullable: "YES",
    },
  ]);

  const constraints = await query(
    client,
    `SELECT c.relname AS table_name,con.conname,con.contype,pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con
     JOIN pg_class c ON c.oid=con.conrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('media_assets','product_variants','try_on_garments')
     ORDER BY c.relname,con.conname`,
  );
  assert.deepEqual(constraints.rows, [
    {
      table_name: "media_assets",
      conname: "media_assets_pkey",
      contype: "p",
      definition: "PRIMARY KEY (id)",
    },
    {
      table_name: "media_assets",
      conname: "media_assets_purpose_allowed",
      contype: "c",
      definition:
        "CHECK (((purpose)::text = ANY ((ARRAY['product_display_image'::character varying, 'try_on_garment'::character varying])::text[])))",
    },
    {
      table_name: "product_variants",
      conname: "product_variants_cost_cents_non_negative",
      contype: "c",
      definition: "CHECK (((cost_cents IS NULL) OR (cost_cents >= 0)))",
    },
    {
      table_name: "product_variants",
      conname: "product_variants_pkey",
      contype: "p",
      definition: "PRIMARY KEY (id)",
    },
    {
      table_name: "product_variants",
      conname: "product_variants_price_cents_non_negative",
      contype: "c",
      definition: "CHECK ((price_cents >= 0))",
    },
    {
      table_name: "product_variants",
      conname: "product_variants_product_id_products_id_fkey",
      contype: "f",
      definition: "FOREIGN KEY (product_id) REFERENCES products(id)",
    },
    {
      table_name: "product_variants",
      conname: "product_variants_target_gender_enum",
      contype: "c",
      definition:
        "CHECK (((target_gender IS NULL) OR ((target_gender)::text = ANY ((ARRAY['male'::character varying, 'female'::character varying])::text[]))))",
    },
    {
      table_name: "product_variants",
      conname: "product_variants_try_on_garment_product_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (try_on_garment_id, product_id) REFERENCES try_on_garments(id, product_id)",
    },
    {
      table_name: "try_on_garments",
      conname: "try_on_garments_id_product_id_unique",
      contype: "u",
      definition: "UNIQUE (id, product_id)",
    },
    {
      table_name: "try_on_garments",
      conname: "try_on_garments_pkey",
      contype: "p",
      definition: "PRIMARY KEY (id)",
    },
    {
      table_name: "try_on_garments",
      conname: "try_on_garments_product_id_products_id_fkey",
      contype: "f",
      definition: "FOREIGN KEY (product_id) REFERENCES products(id)",
    },
    {
      table_name: "try_on_garments",
      conname: "try_on_garments_source_media_asset_id_media_assets_id_fkey",
      contype: "f",
      definition:
        "FOREIGN KEY (source_media_asset_id) REFERENCES media_assets(id)",
    },
    {
      table_name: "try_on_garments",
      conname: "try_on_garments_template_supported",
      contype: "c",
      definition:
        "CHECK (((template)::text = ANY ((ARRAY['tshirt_short_sleeve'::character varying, 'tshirt_long_sleeve'::character varying])::text[])))",
    },
  ]);

  const indexes = await query(
    client,
    `SELECT tablename,indexname,indexdef FROM pg_indexes
     WHERE schemaname='public' AND tablename IN ('media_assets','product_variants','try_on_garments')
     ORDER BY tablename,indexname`,
  );
  assert.deepEqual(
    indexes.rows.map(({ tablename, indexname }) => [tablename, indexname]),
    [
      ["media_assets", "media_assets_pkey"],
      ["media_assets", "media_assets_purpose_idx"],
      ["media_assets", "media_assets_storage_provider_idx"],
      ["product_variants", "product_variants_pkey"],
      ["product_variants", "product_variants_product_id_idx"],
      ["product_variants", "product_variants_sku_unique"],
      ["product_variants", "product_variants_status_idx"],
      ["product_variants", "product_variants_try_on_garment_id_idx"],
      ["try_on_garments", "try_on_garments_id_product_id_unique"],
      ["try_on_garments", "try_on_garments_pkey"],
      ["try_on_garments", "try_on_garments_product_id_idx"],
      ["try_on_garments", "try_on_garments_source_media_asset_id_idx"],
    ],
  );

  const statuses = await query(
    client,
    `SELECT enumlabel
     FROM pg_enum
     JOIN pg_type ON pg_type.oid=pg_enum.enumtypid
     WHERE pg_type.typname='try_on_garment_status'
     ORDER BY pg_enum.enumsortorder`,
  );
  assert.deepEqual(statuses.rows, [
    { enumlabel: "draft" },
    { enumlabel: "active" },
    { enumlabel: "retired" },
  ]);
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

  await query(
    client,
    `INSERT INTO "product_variants"(id,product_id,sku,price_cents,target_gender)
     VALUES ($1,$2,'D2-PREEXISTING-INVALID-GENDER',100,'other')`,
    [ids.invalidGenderVariant, ids.newProduct],
  );
  await query(client, "BEGIN");
  await assert.rejects(
    query(client, cutoverSql),
    /product_variants_target_gender_enum/,
    "the migration must not clean or map an invalid existing target gender",
  );
  await query(client, "ROLLBACK");
  await assertPreD2(client, ids);
  const constraintsAfterRollback = await query(
    client,
    `SELECT count(*) AS total FROM pg_constraint
     WHERE conname IN ('media_assets_purpose_allowed','product_variants_target_gender_enum')`,
  );
  assert.deepEqual(constraintsAfterRollback.rows, [{ total: "0" }]);
  const invalidGenderAfterRollback = await query(
    client,
    `SELECT count(*) AS total FROM "product_variants"
     WHERE id=$1 AND target_gender='other'`,
    [ids.invalidGenderVariant],
  );
  assert.deepEqual(invalidGenderAfterRollback.rows, [{ total: "1" }]);
  await query(client, `DELETE FROM "product_variants" WHERE id=$1`, [
    ids.invalidGenderVariant,
  ]);

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
  const legacyResidue = await query(
    normal,
    `SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name ILIKE $1) AS columns,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND (indexname ILIKE $1 OR indexdef ILIKE $1)) AS indexes,
      (SELECT count(*) FROM pg_constraint WHERE conname ILIKE $1 OR pg_get_constraintdef(oid) ILIKE $1) AS constraints,
      (SELECT count(*) FROM "media_assets" WHERE purpose=$2) AS purpose_rows,
      (SELECT count(*) FROM "media_assets" WHERE storage_key ILIKE $1 OR public_url ILIKE $1) AS storage_refs`,
    [`%${legacyToken}%`, legacyPurpose],
  );
  assert.deepEqual(legacyResidue.rows, [
    {
      columns: "0",
      indexes: "0",
      constraints: "0",
      purpose_rows: "0",
      storage_refs: "0",
    },
  ]);
  await assertFinalTryOnCatalog(normal);
  await assert.rejects(
    query(
      normal,
      `INSERT INTO "media_assets"(purpose,storage_provider,storage_key,content_type,byte_size,sha256,public_url) VALUES
      ($1,'test',$2,'image/png',1,repeat('c',64),$3)`,
      [
        legacyPurpose,
        `${legacyStoragePrefix}/reintroduced.png`,
        `https://example.test/${legacyStoragePrefix}/reintroduced.png`,
      ],
    ),
    /media_assets_purpose_allowed/,
    "the migrated schema must reject retired media purposes",
  );
  await query(normal, "BEGIN");
  await query(
    normal,
    `INSERT INTO "product_variants"(product_id,sku,price_cents,target_gender) VALUES
     ($1,'D2-VALID-GENDER-MALE',100,'male'),
     ($1,'D2-VALID-GENDER-FEMALE',100,'female'),
     ($1,'D2-VALID-GENDER-NULL',100,NULL)`,
    [ids.newProduct],
  );
  const legalTargetGenders = await query(
    normal,
    `SELECT target_gender FROM "product_variants"
     WHERE sku LIKE 'D2-VALID-GENDER-%'
     ORDER BY sku`,
  );
  assert.deepEqual(legalTargetGenders.rows, [
    { target_gender: "female" },
    { target_gender: "male" },
    { target_gender: null },
  ]);
  await query(normal, "ROLLBACK");
  await assert.rejects(
    query(
      normal,
      `INSERT INTO "product_variants"(product_id,sku,price_cents,target_gender)
       VALUES ($1,'D2-INVALID-TARGET-GENDER',100,'other')`,
      [ids.newProduct],
    ),
    /product_variants_target_gender_enum/,
    "the migrated schema must reject unknown target genders",
  );
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
  runPublicApiTracer();
  process.stdout.write("PostgreSQL D2 atomicity proof passed.\n");
} finally {
  await client.end().catch(() => undefined);
}
