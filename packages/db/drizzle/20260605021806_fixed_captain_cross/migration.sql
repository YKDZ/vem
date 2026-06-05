CREATE TYPE "order_line_fulfillment_status" AS ENUM('pending', 'dispensing', 'dispensed', 'dispense_failed', 'manual_handling');--> statement-breakpoint
CREATE TYPE "order_line_refund_status" AS ENUM('not_required', 'pending', 'refunded', 'failed', 'manual_handling');--> statement-breakpoint
ALTER TYPE "order_fulfillment_state" ADD VALUE 'partial_dispensed' BEFORE 'dispense_failed';--> statement-breakpoint
ALTER TYPE "order_payment_state" ADD VALUE 'partial_refund_pending' BEFORE 'refunded';--> statement-breakpoint
ALTER TYPE "order_payment_state" ADD VALUE 'manual_handling' BEFORE 'refunded';--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE 'partial_refund_pending' BEFORE 'refunded';--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE 'manual_handling' BEFORE 'refunded';--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD COLUMN "order_item_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "planogram_version" varchar(128) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfillment_status" "order_line_fulfillment_status" DEFAULT 'pending'::"order_line_fulfillment_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "refund_status" "order_line_refund_status" DEFAULT 'not_required'::"order_line_refund_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "refund_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "fulfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "refund_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vending_commands" ADD COLUMN "order_item_id" uuid;--> statement-breakpoint
CREATE INDEX "inventory_reservations_order_item_id_idx" ON "inventory_reservations" ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_items_fulfillment_status_idx" ON "order_items" ("fulfillment_status");--> statement-breakpoint
CREATE INDEX "order_items_refund_status_idx" ON "order_items" ("refund_status");--> statement-breakpoint
CREATE INDEX "vending_commands_order_item_id_idx" ON "vending_commands" ("order_item_id");--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_item_id_order_items_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_refund_id_refunds_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id");--> statement-breakpoint
ALTER TABLE "vending_commands" ADD CONSTRAINT "vending_commands_order_item_id_order_items_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id");