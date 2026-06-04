ALTER TABLE "machine_raw_stock_movements" ADD COLUMN "reconciliation_reason" varchar(128);--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movements" ADD COLUMN "platform_review_status" varchar(32);--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movements" ADD COLUMN "sale_safety_blocker_state" varchar(64);--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movements" ADD COLUMN "sale_safety_blocker_slot_id" uuid;--> statement-breakpoint
CREATE INDEX "machine_raw_stock_movements_sale_safety_blocker_idx" ON "machine_raw_stock_movements" ("machine_id","sale_safety_blocker_slot_id");--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movements" ADD CONSTRAINT "machine_raw_stock_movements_platform_review_status_enum" CHECK ("platform_review_status" IS NULL OR "platform_review_status" IN ('open', 'resolved'));--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movements" ADD CONSTRAINT "machine_raw_stock_movements_sale_safety_blocker_enum" CHECK ("sale_safety_blocker_state" IS NULL OR "sale_safety_blocker_state" IN ('needs_count', 'blocked_for_planogram_change', 'movement_rejected', 'needs_platform_review'));
