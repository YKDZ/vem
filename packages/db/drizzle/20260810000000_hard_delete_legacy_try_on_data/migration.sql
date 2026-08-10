-- Irreversible V2 cutover.  The locking order is legacy-purpose assets,
-- affected garments, then variants: it gives concurrent writers one stable
-- deletion set without touching unrelated product presentation or audit JSON.
BEGIN;

LOCK TABLE "media_assets", "try_on_garments", "product_variants", "products"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "machine_planogram_slots"
  DROP COLUMN "try_on_silhouette_url";

-- The product/garment composite foreign key must be cleared before removing
-- garments whose source is a retired-purpose asset.
UPDATE "product_variants" AS variant
SET "try_on_garment_id" = NULL
FROM "try_on_garments" AS garment
JOIN "media_assets" AS asset ON asset."id" = garment."source_media_asset_id"
WHERE variant."try_on_garment_id" = garment."id"
  AND asset."purpose" = 'try_on_silhouette';

-- Product display links are the only other media foreign key.  Only links to
-- retired-purpose assets are cleared; all normal product display media remains.
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

COMMIT;
