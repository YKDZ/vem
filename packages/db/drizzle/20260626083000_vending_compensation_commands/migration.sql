ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'orders.recover';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_recovery_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"action" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'started' NOT NULL,
	"note" text NOT NULL,
	"requested_by_admin_user_id" uuid NOT NULL,
	"result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_recovery_actions_action_enum" CHECK ("order_recovery_actions"."action" IN ('confirm_dispensed', 'confirm_not_dispensed', 'request_refund', 'compensation_dispense')),
	CONSTRAINT "order_recovery_actions_status_enum" CHECK ("order_recovery_actions"."status" IN ('started', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "vending_commands" ADD COLUMN IF NOT EXISTS "command_kind" varchar(32) DEFAULT 'dispatch' NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_commands" ADD COLUMN IF NOT EXISTS "recovery_action_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_recovery_actions" ADD CONSTRAINT "order_recovery_actions_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_recovery_actions" ADD CONSTRAINT "order_recovery_actions_command_id_vending_commands_id_fkey" FOREIGN KEY ("command_id") REFERENCES "public"."vending_commands"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_recovery_actions" ADD CONSTRAINT "order_recovery_actions_zdJijJCi5Wue_fkey" FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vending_commands" ADD CONSTRAINT "vending_commands_command_kind_enum" CHECK ("command_kind" IN ('dispatch', 'compensation'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_recovery_actions_order_id_idx" ON "order_recovery_actions" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_recovery_actions_command_id_idx" ON "order_recovery_actions" ("command_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_recovery_actions_status_idx" ON "order_recovery_actions" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_recovery_actions_order_action_unique" ON "order_recovery_actions" ("order_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_recovery_actions_physical_outcome_unique" ON "order_recovery_actions" ("order_id") WHERE "action" IN ('confirm_dispensed', 'confirm_not_dispensed');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_recovery_actions_remedy_unique" ON "order_recovery_actions" ("order_id") WHERE "action" IN ('request_refund', 'compensation_dispense');--> statement-breakpoint
DROP INDEX IF EXISTS "vending_commands_order_slot_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_commands_order_slot_unique" ON "vending_commands" ("order_id","slot_id") WHERE "command_kind" = 'dispatch';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_commands_recovery_action_unique" ON "vending_commands" ("recovery_action_id") WHERE "recovery_action_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vending_commands_command_kind_idx" ON "vending_commands" ("command_kind");
