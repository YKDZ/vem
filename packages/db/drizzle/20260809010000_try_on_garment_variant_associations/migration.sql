ALTER TABLE "product_variants" ADD COLUMN "try_on_garment_id" uuid;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_try_on_garment_id_try_on_garments_id_fkey" FOREIGN KEY ("try_on_garment_id") REFERENCES "public"."try_on_garments"("id");--> statement-breakpoint
CREATE INDEX "product_variants_try_on_garment_id_idx" ON "product_variants" USING btree ("try_on_garment_id");--> statement-breakpoint
DROP INDEX "product_variants_try_on_silhouette_media_asset_id_idx";--> statement-breakpoint
ALTER TABLE "product_variants" DROP COLUMN "try_on_silhouette_media_asset_id";
