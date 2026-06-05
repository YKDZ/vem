CREATE TABLE "machine_raw_stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"movement_id" varchar(128) NOT NULL,
	"planogram_version" varchar(128) NOT NULL,
	"slot_id" uuid NOT NULL,
	"movement_type" varchar(64) NOT NULL,
	"quantity" integer NOT NULL,
	"source" varchar(128) NOT NULL,
	"attributed_to" varchar(128),
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"normalized_json" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'accepted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_raw_stock_movements_quantity_non_negative" CHECK ("quantity" >= 0),
	CONSTRAINT "machine_raw_stock_movements_type_enum" CHECK ("movement_type" IN ('planned_refill', 'stock_count_correction')),
	CONSTRAINT "machine_raw_stock_movements_status_enum" CHECK ("status" IN ('accepted', 'rejected', 'reconciliation'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "machine_raw_stock_movements_machine_movement_unique" ON "machine_raw_stock_movements" ("machine_id","movement_id");--> statement-breakpoint
CREATE INDEX "machine_raw_stock_movements_machine_idx" ON "machine_raw_stock_movements" ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_raw_stock_movements_status_idx" ON "machine_raw_stock_movements" ("status");--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movements" ADD CONSTRAINT "machine_raw_stock_movements_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");
