CREATE TABLE "machine_raw_stock_movement_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"raw_movement_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"movement_id" varchar(128) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"normalized_json" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'reconciliation' NOT NULL,
	"reconciliation_reason" varchar(128) NOT NULL,
	"platform_review_status" varchar(32) NOT NULL,
	"sale_safety_blocker_state" varchar(64),
	"sale_safety_blocker_slot_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_raw_stock_movement_conflicts_status_enum" CHECK ("status" IN ('reconciliation')),
	CONSTRAINT "machine_raw_stock_movement_conflicts_platform_review_status_enum" CHECK ("platform_review_status" IN ('open', 'resolved')),
	CONSTRAINT "machine_raw_stock_movement_conflicts_sale_safety_blocker_enum" CHECK ("sale_safety_blocker_state" IS NULL OR "sale_safety_blocker_state" IN ('needs_count', 'blocked_for_planogram_change', 'movement_rejected', 'needs_platform_review'))
);
--> statement-breakpoint
CREATE INDEX "machine_raw_stock_movement_conflicts_raw_idx" ON "machine_raw_stock_movement_conflicts" USING btree ("raw_movement_id");--> statement-breakpoint
CREATE INDEX "machine_raw_stock_movement_conflicts_machine_movement_idx" ON "machine_raw_stock_movement_conflicts" USING btree ("machine_id","movement_id");--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movement_conflicts" ADD CONSTRAINT "machine_raw_stock_movement_conflicts_msZ1K2NJ1sRr_fkey" FOREIGN KEY ("raw_movement_id") REFERENCES "machine_raw_stock_movements"("id");--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movement_conflicts" ADD CONSTRAINT "machine_raw_stock_movement_conflicts_nQeaNd6J0TrW_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
