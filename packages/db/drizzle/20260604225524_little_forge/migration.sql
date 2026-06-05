CREATE TYPE "order_fulfillment_state" AS ENUM('awaiting_fulfillment', 'dispensing', 'dispensed', 'dispense_failed', 'manual_handling', 'canceled');--> statement-breakpoint
CREATE TYPE "order_payment_state" AS ENUM('awaiting_payment', 'paid', 'payment_failed', 'payment_expired', 'canceled', 'refund_pending', 'refunded', 'partial_refunded');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_state" "order_payment_state" DEFAULT 'awaiting_payment'::"order_payment_state" NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_state" "order_fulfillment_state" DEFAULT 'awaiting_fulfillment'::"order_fulfillment_state" NOT NULL;--> statement-breakpoint
UPDATE "orders" SET
  "status" = (CASE "status"
    WHEN 'closed' THEN 'canceled'
    ELSE "status"
  END)::"order_status",
  "payment_state" = (CASE "status"
    WHEN 'pending_payment' THEN 'awaiting_payment'
    WHEN 'payment_expired' THEN 'payment_expired'
    WHEN 'canceled' THEN 'canceled'
    WHEN 'paid' THEN 'paid'
    WHEN 'dispensing' THEN 'paid'
    WHEN 'fulfilled' THEN 'paid'
    WHEN 'dispense_failed' THEN 'paid'
    WHEN 'manual_handling' THEN 'paid'
    WHEN 'refund_pending' THEN 'refund_pending'
    WHEN 'refunded' THEN 'refunded'
    WHEN 'closed' THEN 'canceled'
    ELSE 'awaiting_payment'
  END)::"order_payment_state",
  "fulfillment_state" = (CASE "status"
    WHEN 'pending_payment' THEN 'awaiting_fulfillment'
    WHEN 'payment_expired' THEN 'canceled'
    WHEN 'canceled' THEN 'canceled'
    WHEN 'paid' THEN 'awaiting_fulfillment'
    WHEN 'dispensing' THEN 'dispensing'
    WHEN 'fulfilled' THEN 'dispensed'
    WHEN 'dispense_failed' THEN 'dispense_failed'
    WHEN 'manual_handling' THEN 'manual_handling'
    WHEN 'refund_pending' THEN 'manual_handling'
    WHEN 'refunded' THEN 'manual_handling'
    WHEN 'closed' THEN 'canceled'
    ELSE 'awaiting_fulfillment'
  END)::"order_fulfillment_state";--> statement-breakpoint
CREATE INDEX "orders_payment_state_idx" ON "orders" ("payment_state");--> statement-breakpoint
CREATE INDEX "orders_fulfillment_state_idx" ON "orders" ("fulfillment_state");--> statement-breakpoint
ALTER TABLE "machine_raw_stock_movements" DROP CONSTRAINT "machine_raw_stock_movements_type_enum", ADD CONSTRAINT "machine_raw_stock_movements_type_enum" CHECK ("movement_type" IN ('planned_refill', 'stock_count_correction', 'dispense_succeeded'));
