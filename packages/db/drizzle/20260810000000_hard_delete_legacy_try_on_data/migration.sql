-- Irreversible V2 cutover: remove retired planogram presentation data and
-- destroy the old media purpose.  Existing products, garments, and display
-- media are deliberately untouched.
ALTER TABLE "machine_planogram_slots"
  DROP COLUMN IF EXISTS "try_on_silhouette_url";

ALTER TABLE "product_variants"
  DROP CONSTRAINT IF EXISTS "product_variants_try_on_silhouette_media_asset_id_media_assets_id_fkey";
DROP INDEX IF EXISTS "product_variants_try_on_silhouette_media_asset_id_idx";
ALTER TABLE "product_variants"
  DROP COLUMN IF EXISTS "try_on_silhouette_media_asset_id";

UPDATE "products"
SET "display_image_media_asset_id" = NULL
WHERE "display_image_media_asset_id" IN (
  SELECT "id" FROM "media_assets" WHERE "purpose" = 'try_on_silhouette'
);

DELETE FROM "try_on_garments"
WHERE "source_media_asset_id" IN (
  SELECT "id" FROM "media_assets" WHERE "purpose" = 'try_on_silhouette'
);

DELETE FROM "media_assets"
WHERE "purpose" = 'try_on_silhouette';
