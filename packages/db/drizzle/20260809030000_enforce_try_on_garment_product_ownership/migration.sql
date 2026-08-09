-- A variant may only point at a garment owned by the same product.  Keep the
-- ownership check in PostgreSQL so every writer, including a concurrent PATCH,
-- receives the same invariant.
UPDATE "product_variants" AS variant
SET "try_on_garment_id" = NULL
FROM "try_on_garments" AS garment
WHERE variant."try_on_garment_id" = garment."id"
  AND variant."product_id" <> garment."product_id";--> statement-breakpoint

ALTER TABLE "product_variants"
  DROP CONSTRAINT "product_variants_try_on_garment_id_try_on_garments_id_fkey";--> statement-breakpoint

ALTER TABLE "try_on_garments"
  ADD CONSTRAINT "try_on_garments_id_product_id_unique"
  UNIQUE ("id", "product_id");--> statement-breakpoint

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_try_on_garment_product_id_fkey"
  FOREIGN KEY ("try_on_garment_id", "product_id")
  REFERENCES "try_on_garments" ("id", "product_id");
