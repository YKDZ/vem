ALTER TABLE "product_variants" ADD COLUMN "try_on_silhouette_media_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_try_on_silhouette_media_asset_id_media_assets_id_fkey" FOREIGN KEY ("try_on_silhouette_media_asset_id") REFERENCES "media_assets"("id");--> statement-breakpoint
CREATE INDEX "product_variants_try_on_silhouette_media_asset_id_idx" ON "product_variants" USING btree ("try_on_silhouette_media_asset_id");
