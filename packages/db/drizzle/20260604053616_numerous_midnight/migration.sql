CREATE TYPE "machine_command_status" AS ENUM('pending', 'sent', 'acknowledged', 'succeeded', 'failed', 'timeout');--> statement-breakpoint
CREATE TABLE "machine_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"command_no" varchar(64) NOT NULL,
	"machine_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"status" "machine_command_status" DEFAULT 'pending'::"machine_command_status" NOT NULL,
	"payload_json" jsonb NOT NULL,
	"result_json" jsonb,
	"sent_at" timestamp with time zone,
	"ack_at" timestamp with time zone,
	"result_at" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"requested_by_admin_user_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "machine_commands_command_no_unique" ON "machine_commands" ("command_no");--> statement-breakpoint
CREATE INDEX "machine_commands_machine_id_idx" ON "machine_commands" ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_commands_type_idx" ON "machine_commands" ("type");--> statement-breakpoint
CREATE INDEX "machine_commands_status_idx" ON "machine_commands" ("status");--> statement-breakpoint
CREATE INDEX "machine_commands_timeout_at_idx" ON "machine_commands" ("timeout_at");--> statement-breakpoint
CREATE INDEX "machine_commands_requested_by_admin_user_id_idx" ON "machine_commands" ("requested_by_admin_user_id");--> statement-breakpoint
ALTER TABLE "machine_commands" ADD CONSTRAINT "machine_commands_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "machine_commands" ADD CONSTRAINT "machine_commands_requested_by_admin_user_id_admin_users_id_fkey" FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "admin_users"("id");
