ALTER TYPE "payment_provider_type" ADD VALUE IF NOT EXISTS 'wechat_pay';--> statement-breakpoint
ALTER TYPE "payment_provider_type" ADD VALUE IF NOT EXISTS 'alipay';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'machineOps.read';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'machineOps.write';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'hardwareErrorPolicies.read';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'hardwareErrorPolicies.write';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'maintenanceWorkOrders.read';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'maintenanceWorkOrders.write';--> statement-breakpoint
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'work_order_created';--> statement-breakpoint
CREATE TABLE "hardware_error_code_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"error_code" varchar(64) NOT NULL,
	"restore_inventory" boolean NOT NULL,
	"fault_slot" boolean NOT NULL,
	"request_refund" boolean NOT NULL,
	"create_work_order" boolean NOT NULL,
	"severity" "notification_severity" DEFAULT 'critical'::"notification_severity" NOT NULL,
	"status" "payment_provider_status" DEFAULT 'enabled'::"payment_provider_status" NOT NULL,
	"updated_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_log_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"op_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_path" text NOT NULL,
	"dedupe_key" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_remote_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"type" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"requested_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failed_reason" text,
	"result_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "maintenance_work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"work_order_no" varchar(64) NOT NULL,
	"machine_id" uuid,
	"slot_id" uuid,
	"order_id" uuid,
	"command_id" uuid,
	"title" varchar(128) NOT NULL,
	"description" text NOT NULL,
	"priority" varchar(32) DEFAULT 'medium' NOT NULL,
	"status" varchar(32) DEFAULT 'open' NOT NULL,
	"assignee_admin_user_id" uuid,
	"resolution_note" text,
	"dedupe_key" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hardware_error_code_configs_error_code_unique" ON "hardware_error_code_configs" ("error_code");--> statement-breakpoint
CREATE INDEX "hardware_error_code_configs_status_idx" ON "hardware_error_code_configs" ("status");--> statement-breakpoint
CREATE INDEX "machine_log_artifacts_op_id_idx" ON "machine_log_artifacts" ("op_id");--> statement-breakpoint
CREATE INDEX "machine_log_artifacts_machine_id_idx" ON "machine_log_artifacts" ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_log_artifacts_dedupe_key_unique" ON "machine_log_artifacts" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "machine_remote_ops_machine_id_idx" ON "machine_remote_ops" ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_remote_ops_status_idx" ON "machine_remote_ops" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_work_orders_no_unique" ON "maintenance_work_orders" ("work_order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_work_orders_dedupe_key_unique" ON "maintenance_work_orders" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "maintenance_work_orders_status_idx" ON "maintenance_work_orders" ("status");--> statement-breakpoint
CREATE INDEX "maintenance_work_orders_machine_id_idx" ON "maintenance_work_orders" ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_notification_target_unique" ON "notification_deliveries" ("notification_id","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_targets_name_unique" ON "notification_targets" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_configs_provider_machine_unique" ON "payment_provider_configs" ("provider_id","machine_id");--> statement-breakpoint
ALTER TABLE "hardware_error_code_configs" ADD CONSTRAINT "hardware_error_code_configs_xsAsRAQAlFHc_fkey" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "machine_log_artifacts" ADD CONSTRAINT "machine_log_artifacts_op_id_machine_remote_ops_id_fkey" FOREIGN KEY ("op_id") REFERENCES "machine_remote_ops"("id");--> statement-breakpoint
ALTER TABLE "machine_log_artifacts" ADD CONSTRAINT "machine_log_artifacts_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "machine_remote_ops" ADD CONSTRAINT "machine_remote_ops_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "machine_remote_ops" ADD CONSTRAINT "machine_remote_ops_epQpHOZ6UBkl_fkey" FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_slot_id_machine_slots_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "machine_slots"("id");--> statement-breakpoint
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_command_id_vending_commands_id_fkey" FOREIGN KEY ("command_id") REFERENCES "vending_commands"("id");--> statement-breakpoint
ALTER TABLE "maintenance_work_orders" ADD CONSTRAINT "maintenance_work_orders_KJ4qnxCcZ6my_fkey" FOREIGN KEY ("assignee_admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_reserved_qty_lte_on_hand_qty" CHECK ("reserved_qty" <= "on_hand_qty");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_configs_provider_global_unique" ON "payment_provider_configs" ("provider_id") WHERE "machine_id" IS NULL;
