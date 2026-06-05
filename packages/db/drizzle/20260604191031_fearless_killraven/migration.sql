CREATE TABLE "machine_planogram_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_planogram_version_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"slot_code" varchar(32) NOT NULL,
	"layer_no" integer NOT NULL,
	"cell_no" integer NOT NULL,
	"capacity" integer NOT NULL,
	"par_level" integer NOT NULL,
	"inventory_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"product_name" varchar(128) NOT NULL,
	"product_description" text,
	"cover_image_url" text,
	"category_id" uuid,
	"category_name" varchar(128),
	"sku" varchar(64) NOT NULL,
	"size" varchar(64),
	"color" varchar(64),
	"price_cents" integer NOT NULL,
	"product_sort_order" integer NOT NULL,
	"target_gender" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_planogram_slots_capacity_non_negative" CHECK ("capacity" >= 0),
	CONSTRAINT "machine_planogram_slots_par_level_non_negative" CHECK ("par_level" >= 0),
	CONSTRAINT "machine_planogram_slots_price_cents_non_negative" CHECK ("price_cents" >= 0),
	CONSTRAINT "machine_planogram_slots_target_gender_enum" CHECK ("target_gender" IS NULL OR "target_gender" IN ('male', 'female'))
);
--> statement-breakpoint
CREATE TABLE "machine_planogram_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"planogram_version" varchar(128) NOT NULL,
	"status" varchar(32) DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_planogram_versions_status_enum" CHECK ("status" IN ('published', 'active', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "machine_planogram_slots_version_slot_unique" ON "machine_planogram_slots" ("machine_planogram_version_id","slot_id");--> statement-breakpoint
CREATE INDEX "machine_planogram_slots_version_idx" ON "machine_planogram_slots" ("machine_planogram_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_planogram_versions_machine_version_unique" ON "machine_planogram_versions" ("machine_id","planogram_version");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_planogram_versions_machine_active_unique" ON "machine_planogram_versions" ("machine_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "machine_planogram_versions_machine_status_idx" ON "machine_planogram_versions" ("machine_id","status");--> statement-breakpoint
ALTER TABLE "machine_planogram_slots" ADD CONSTRAINT "machine_planogram_slots_0Y5Uv57BAkq4_fkey" FOREIGN KEY ("machine_planogram_version_id") REFERENCES "machine_planogram_versions"("id");--> statement-breakpoint
ALTER TABLE "machine_planogram_slots" ADD CONSTRAINT "machine_planogram_slots_slot_id_machine_slots_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "machine_slots"("id");--> statement-breakpoint
ALTER TABLE "machine_planogram_versions" ADD CONSTRAINT "machine_planogram_versions_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
