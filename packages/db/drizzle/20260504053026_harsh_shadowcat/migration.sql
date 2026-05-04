CREATE TYPE "admin_user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "category_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "inventory_movement_reason" AS ENUM('refill', 'adjust', 'purchase_reserved', 'purchase_confirmed', 'reservation_released', 'refund_return', 'hardware_sync');--> statement-breakpoint
CREATE TYPE "inventory_reservation_status" AS ENUM('active', 'confirmed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "machine_slot_status" AS ENUM('enabled', 'disabled', 'faulted');--> statement-breakpoint
CREATE TYPE "machine_status" AS ENUM('online', 'offline', 'maintenance', 'disabled');--> statement-breakpoint
CREATE TYPE "notification_delivery_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "notification_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "notification_status" AS ENUM('unread', 'read', 'archived');--> statement-breakpoint
CREATE TYPE "notification_target_type" AS ENUM('in_app', 'sms', 'wechat', 'email');--> statement-breakpoint
CREATE TYPE "notification_type" AS ENUM('low_stock', 'sold_out', 'machine_offline', 'payment_failed', 'dispense_failed');--> statement-breakpoint
CREATE TYPE "order_source" AS ENUM('machine_ui', 'admin', 'api');--> statement-breakpoint
CREATE TYPE "order_status" AS ENUM('pending_payment', 'payment_expired', 'canceled', 'paid', 'dispensing', 'fulfilled', 'dispense_failed', 'manual_handling', 'refund_pending', 'refunded', 'closed');--> statement-breakpoint
CREATE TYPE "payment_method" AS ENUM('mock', 'qr_code', 'face_pay');--> statement-breakpoint
CREATE TYPE "payment_provider_status" AS ENUM('enabled', 'disabled');--> statement-breakpoint
CREATE TYPE "payment_provider_type" AS ENUM('mock', 'qr_code', 'face_pay', 'aggregate');--> statement-breakpoint
CREATE TYPE "payment_status" AS ENUM('created', 'pending', 'processing', 'succeeded', 'failed', 'expired', 'canceled', 'refund_pending', 'refunded', 'partial_refunded');--> statement-breakpoint
CREATE TYPE "permission_code" AS ENUM('dashboard.read', 'products.read', 'products.write', 'inventory.read', 'inventory.adjust', 'inventory.refill', 'orders.read', 'orders.refund', 'payments.read', 'payments.configure', 'payments.refund', 'machines.read', 'machines.write', 'machines.command', 'adminUsers.read', 'adminUsers.write', 'roles.write', 'notifications.read', 'notifications.write', 'audit.read');--> statement-breakpoint
CREATE TYPE "product_status" AS ENUM('draft', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "refund_status" AS ENUM('created', 'processing', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "role_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "variant_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "vending_command_status" AS ENUM('pending', 'sent', 'acknowledged', 'succeeded', 'failed', 'timeout');--> statement-breakpoint
CREATE TABLE "admin_user_roles" (
	"admin_user_id" uuid,
	"role_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY("admin_user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"username" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(64) NOT NULL,
	"mobile" varchar(32),
	"email" varchar(255),
	"status" "admin_user_status" DEFAULT 'active'::"admin_user_status" NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"admin_user_id" uuid,
	"action" varchar(128) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" uuid,
	"ip_address" varchar(64),
	"user_agent" text,
	"before_json" jsonb,
	"after_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"on_hand_qty" integer NOT NULL,
	"reserved_qty" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 1 NOT NULL,
	"sold_out_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventories_on_hand_qty_non_negative" CHECK ("on_hand_qty" >= 0),
	CONSTRAINT "inventories_reserved_qty_non_negative" CHECK ("reserved_qty" >= 0),
	CONSTRAINT "inventories_low_stock_threshold_non_negative" CHECK ("low_stock_threshold" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"inventory_id" uuid NOT NULL,
	"delta_qty" integer NOT NULL,
	"reason" "inventory_movement_reason" NOT NULL,
	"order_id" uuid,
	"operator_admin_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"order_id" uuid NOT NULL,
	"inventory_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" "inventory_reservation_status" DEFAULT 'active'::"inventory_reservation_status" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "machine_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"payload_json" jsonb NOT NULL,
	"mqtt_topic" varchar(255) NOT NULL,
	"message_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"status_payload_json" jsonb NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"layer_no" integer NOT NULL,
	"cell_no" integer NOT NULL,
	"slot_code" varchar(32) NOT NULL,
	"capacity" integer NOT NULL,
	"status" "machine_slot_status" DEFAULT 'enabled'::"machine_slot_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "machine_slots_layer_no_positive" CHECK ("layer_no" > 0),
	CONSTRAINT "machine_slots_cell_no_positive" CHECK ("cell_no" > 0),
	CONSTRAINT "machine_slots_capacity_non_negative" CHECK ("capacity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"location_text" text,
	"status" "machine_status" DEFAULT 'offline'::"machine_status" NOT NULL,
	"last_seen_at" timestamp with time zone,
	"mqtt_client_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"notification_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"channel" "notification_target_type" NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending'::"notification_delivery_status" NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(128) NOT NULL,
	"type" "notification_target_type" NOT NULL,
	"target_masked" varchar(128),
	"config_json" jsonb NOT NULL,
	"status" "payment_provider_status" DEFAULT 'enabled'::"payment_provider_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"type" "notification_type" NOT NULL,
	"title" varchar(128) NOT NULL,
	"content" text NOT NULL,
	"severity" "notification_severity" DEFAULT 'info'::"notification_severity" NOT NULL,
	"resource_type" varchar(64),
	"resource_id" uuid,
	"status" "notification_status" DEFAULT 'unread'::"notification_status" NOT NULL,
	"dedupe_key" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"inventory_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"product_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0),
	CONSTRAINT "order_items_unit_price_cents_non_negative" CHECK ("unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"reason" varchar(128) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"order_no" varchar(64) NOT NULL,
	"machine_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment'::"order_status" NOT NULL,
	"total_amount_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'CNY' NOT NULL,
	"payment_id" uuid,
	"profile_snapshot" jsonb,
	"created_from" "order_source" DEFAULT 'machine_ui'::"order_source" NOT NULL,
	"paid_at" timestamp with time zone,
	"dispensed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_total_amount_cents_non_negative" CHECK ("total_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"payment_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"raw_payload_json" jsonb NOT NULL,
	"signature_valid" boolean DEFAULT false NOT NULL,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid NOT NULL,
	"machine_id" uuid,
	"merchant_no" varchar(128),
	"app_id" varchar(128),
	"config_encrypted_json" jsonb NOT NULL,
	"public_config_json" jsonb NOT NULL,
	"status" "payment_provider_status" DEFAULT 'enabled'::"payment_provider_status" NOT NULL,
	"updated_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"type" "payment_provider_type" NOT NULL,
	"status" "payment_provider_status" DEFAULT 'enabled'::"payment_provider_status" NOT NULL,
	"capabilities" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_user_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_code" varchar(64) NOT NULL,
	"provider_user_id_hash" text,
	"masked_account" varchar(128),
	"display_name_masked" varchar(128),
	"extra_masked_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"payment_no" varchar(64) NOT NULL,
	"order_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'created'::"payment_status" NOT NULL,
	"amount_cents" integer NOT NULL,
	"provider_trade_no" varchar(128),
	"payment_url" text,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"failed_reason" text,
	"payer_snapshot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_cents_non_negative" CHECK ("amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" "permission_code" NOT NULL,
	"name" varchar(128) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(128) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" "category_status" DEFAULT 'active'::"category_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"product_id" uuid NOT NULL,
	"sku" varchar(64) NOT NULL,
	"size" varchar(32),
	"color" varchar(32),
	"barcode" varchar(128),
	"price_cents" integer NOT NULL,
	"cost_cents" integer,
	"status" "variant_status" DEFAULT 'active'::"variant_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "product_variants_price_cents_non_negative" CHECK ("price_cents" >= 0),
	CONSTRAINT "product_variants_cost_cents_non_negative" CHECK ("cost_cents" IS NULL OR "cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(128) NOT NULL,
	"category_id" uuid,
	"description" text,
	"cover_image_url" text,
	"status" "product_status" DEFAULT 'draft'::"product_status" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"admin_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"refund_no" varchar(64) NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "refund_status" DEFAULT 'created'::"refund_status" NOT NULL,
	"provider_refund_no" varchar(128),
	"reason" text NOT NULL,
	"requested_by_admin_user_id" uuid,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_amount_cents_non_negative" CHECK ("amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid,
	"permission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"status" "role_status" DEFAULT 'active'::"role_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vending_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"command_no" varchar(64) NOT NULL,
	"order_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "vending_command_status" DEFAULT 'pending'::"vending_command_status" NOT NULL,
	"sent_at" timestamp with time zone,
	"ack_at" timestamp with time zone,
	"result_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vending_commands_retry_count_non_negative" CHECK ("retry_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "admin_user_roles_role_id_idx" ON "admin_user_roles" ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_username_unique" ON "admin_users" ("username");--> statement-breakpoint
CREATE INDEX "admin_users_status_idx" ON "admin_users" ("status");--> statement-breakpoint
CREATE INDEX "audit_logs_admin_user_id_idx" ON "audit_logs" ("admin_user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventories_slot_id_unique" ON "inventories" ("slot_id");--> statement-breakpoint
CREATE INDEX "inventories_machine_id_idx" ON "inventories" ("machine_id");--> statement-breakpoint
CREATE INDEX "inventories_variant_id_idx" ON "inventories" ("variant_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_inventory_id_idx" ON "inventory_movements" ("inventory_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_order_id_idx" ON "inventory_movements" ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_reason_idx" ON "inventory_movements" ("reason");--> statement-breakpoint
CREATE INDEX "inventory_movements_created_at_idx" ON "inventory_movements" ("created_at");--> statement-breakpoint
CREATE INDEX "inventory_reservations_order_id_idx" ON "inventory_reservations" ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_inventory_id_idx" ON "inventory_reservations" ("inventory_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_status_idx" ON "inventory_reservations" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_events_machine_message_unique" ON "machine_events" ("machine_id","message_id");--> statement-breakpoint
CREATE INDEX "machine_events_machine_id_idx" ON "machine_events" ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_events_event_type_idx" ON "machine_events" ("event_type");--> statement-breakpoint
CREATE INDEX "machine_heartbeats_machine_id_idx" ON "machine_heartbeats" ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_heartbeats_reported_at_idx" ON "machine_heartbeats" ("reported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_slots_position_unique" ON "machine_slots" ("machine_id","layer_no","cell_no");--> statement-breakpoint
CREATE INDEX "machine_slots_machine_id_idx" ON "machine_slots" ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_slots_status_idx" ON "machine_slots" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_code_unique" ON "machines" ("code");--> statement-breakpoint
CREATE INDEX "machines_status_idx" ON "machines" ("status");--> statement-breakpoint
CREATE INDEX "machines_last_seen_at_idx" ON "machines" ("last_seen_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries" ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_target_id_idx" ON "notification_deliveries" ("target_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_status_idx" ON "notification_deliveries" ("status");--> statement-breakpoint
CREATE INDEX "notification_targets_type_idx" ON "notification_targets" ("type");--> statement-breakpoint
CREATE INDEX "notification_targets_status_idx" ON "notification_targets" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_unique" ON "notifications" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_type_idx" ON "notifications" ("type");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" ("status");--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" ("created_at");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_id_idx" ON "order_items" ("variant_id");--> statement-breakpoint
CREATE INDEX "order_status_events_order_id_idx" ON "order_status_events" ("order_id");--> statement-breakpoint
CREATE INDEX "order_status_events_created_at_idx" ON "order_status_events" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_no_unique" ON "orders" ("order_no");--> statement-breakpoint
CREATE INDEX "orders_machine_id_idx" ON "orders" ("machine_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" ("status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_unique" ON "payment_events" ("provider_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events" ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_provider_configs_provider_id_idx" ON "payment_provider_configs" ("provider_id");--> statement-breakpoint
CREATE INDEX "payment_provider_configs_machine_id_idx" ON "payment_provider_configs" ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_providers_code_unique" ON "payment_providers" ("code");--> statement-breakpoint
CREATE INDEX "payment_providers_status_idx" ON "payment_providers" ("status");--> statement-breakpoint
CREATE INDEX "payment_user_snapshots_provider_code_idx" ON "payment_user_snapshots" ("provider_code");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_payment_no_unique" ON "payments" ("payment_no");--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" ("order_id");--> statement-breakpoint
CREATE INDEX "payments_provider_id_idx" ON "payments" ("provider_id");--> statement-breakpoint
CREATE INDEX "payments_status_idx" ON "payments" ("status");--> statement-breakpoint
CREATE INDEX "payments_created_at_idx" ON "payments" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_code_unique" ON "permissions" ("code");--> statement-breakpoint
CREATE INDEX "product_categories_parent_id_idx" ON "product_categories" ("parent_id");--> statement-breakpoint
CREATE INDEX "product_categories_status_idx" ON "product_categories" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_sku_unique" ON "product_variants" ("sku");--> statement-breakpoint
CREATE INDEX "product_variants_product_id_idx" ON "product_variants" ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_status_idx" ON "product_variants" ("status");--> statement-breakpoint
CREATE INDEX "products_category_id_idx" ON "products" ("category_id");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_unique" ON "refresh_tokens" ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_admin_user_id_idx" ON "refresh_tokens" ("admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_refund_no_unique" ON "refunds" ("refund_no");--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "refunds" ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_order_id_idx" ON "refunds" ("order_id");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions" ("permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_code_unique" ON "roles" ("code");--> statement-breakpoint
CREATE INDEX "roles_status_idx" ON "roles" ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "vending_commands_command_no_unique" ON "vending_commands" ("command_no");--> statement-breakpoint
CREATE INDEX "vending_commands_order_id_idx" ON "vending_commands" ("order_id");--> statement-breakpoint
CREATE INDEX "vending_commands_machine_id_idx" ON "vending_commands" ("machine_id");--> statement-breakpoint
CREATE INDEX "vending_commands_status_idx" ON "vending_commands" ("status");--> statement-breakpoint
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_admin_user_id_admin_users_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_user_id_admin_users_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_slot_id_machine_slots_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "machine_slots"("id");--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_variant_id_product_variants_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_id_inventories_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "inventories"("id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_operator_admin_user_id_admin_users_id_fkey" FOREIGN KEY ("operator_admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_inventory_id_inventories_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "inventories"("id");--> statement-breakpoint
ALTER TABLE "machine_events" ADD CONSTRAINT "machine_events_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "machine_heartbeats" ADD CONSTRAINT "machine_heartbeats_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "machine_slots" ADD CONSTRAINT "machine_slots_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id");--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_target_id_notification_targets_id_fkey" FOREIGN KEY ("target_id") REFERENCES "notification_targets"("id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_inventory_id_inventories_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "inventories"("id");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_slot_id_machine_slots_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "machine_slots"("id");--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_provider_id_payment_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id");--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD CONSTRAINT "payment_provider_configs_provider_id_payment_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id");--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD CONSTRAINT "payment_provider_configs_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD CONSTRAINT "payment_provider_configs_0y8VTK2px9sV_fkey" FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_id_payment_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_snapshot_id_payment_user_snapshots_id_fkey" FOREIGN KEY ("payer_snapshot_id") REFERENCES "payment_user_snapshots"("id");--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_product_categories_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "product_categories"("id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_admin_user_id_admin_users_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_admin_user_id_admin_users_id_fkey" FOREIGN KEY ("requested_by_admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id");--> statement-breakpoint
ALTER TABLE "vending_commands" ADD CONSTRAINT "vending_commands_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id");--> statement-breakpoint
ALTER TABLE "vending_commands" ADD CONSTRAINT "vending_commands_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "vending_commands" ADD CONSTRAINT "vending_commands_slot_id_machine_slots_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "machine_slots"("id");