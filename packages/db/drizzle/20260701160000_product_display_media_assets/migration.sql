CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" varchar(64) NOT NULL,
	"storage_provider" varchar(32) NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"byte_size" integer NOT NULL,
	"original_filename" varchar(255),
	"sha256" varchar(64) NOT NULL,
	"public_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "display_image_media_asset_id" uuid;
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_display_image_media_asset_id_media_assets_id_fkey" FOREIGN KEY ("display_image_media_asset_id") REFERENCES "media_assets"("id");
--> statement-breakpoint
CREATE INDEX "media_assets_purpose_idx" ON "media_assets" USING btree ("purpose");
--> statement-breakpoint
CREATE INDEX "media_assets_storage_provider_idx" ON "media_assets" USING btree ("storage_provider");
--> statement-breakpoint
CREATE INDEX "products_display_image_media_asset_id_idx" ON "products" USING btree ("display_image_media_asset_id");
--> statement-breakpoint
UPDATE "products" SET "cover_image_url" = NULL WHERE "cover_image_url" IS NOT NULL;
