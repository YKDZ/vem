CREATE TYPE "public"."try_on_garment_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "has_transparency" boolean;--> statement-breakpoint
CREATE TABLE "try_on_garments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL,
  "color_label" varchar(32) NOT NULL,
  "source_media_asset_id" uuid NOT NULL,
  "template" varchar(32) NOT NULL,
  "status" "try_on_garment_status" DEFAULT 'draft' NOT NULL,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "try_on_garments_template_supported" CHECK ("try_on_garments"."template" IN ('tshirt_short_sleeve', 'tshirt_long_sleeve'))
);--> statement-breakpoint
ALTER TABLE "try_on_garments" ADD CONSTRAINT "try_on_garments_product_id_products_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");--> statement-breakpoint
ALTER TABLE "try_on_garments" ADD CONSTRAINT "try_on_garments_source_media_asset_id_media_assets_id_fkey" FOREIGN KEY ("source_media_asset_id") REFERENCES "public"."media_assets"("id");--> statement-breakpoint
CREATE INDEX "try_on_garments_product_id_idx" ON "try_on_garments" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "try_on_garments_source_media_asset_id_idx" ON "try_on_garments" USING btree ("source_media_asset_id");
