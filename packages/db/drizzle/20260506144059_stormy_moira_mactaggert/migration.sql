ALTER TYPE "notification_type" ADD VALUE 'work_order_created';--> statement-breakpoint
ALTER TYPE "payment_provider_type" ADD VALUE 'wechat_pay' BEFORE 'qr_code';--> statement-breakpoint
ALTER TYPE "payment_provider_type" ADD VALUE 'alipay' BEFORE 'qr_code';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE 'machineOps.read';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE 'machineOps.write';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE 'hardwareErrorPolicies.read';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE 'hardwareErrorPolicies.write';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE 'maintenanceWorkOrders.read';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE 'maintenanceWorkOrders.write';--> statement-breakpoint
CREATE TABLE "payment_reconciliation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"payment_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"trigger" varchar(32) NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"provider_payment_status" varchar(64),
	"provider_trade_no" varchar(128),
	"error_code" varchar(128),
	"error_message" text,
	"raw_payload_sha256" text,
	"raw_payload_excerpt" text,
	"next_retry_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid,
	"provider_code" varchar(64) NOT NULL,
	"payment_id" uuid,
	"refund_id" uuid,
	"matched_config_id" uuid,
	"event_kind" varchar(32) DEFAULT 'unknown' NOT NULL,
	"event_type" varchar(128),
	"provider_event_id" varchar(128),
	"payment_no" varchar(64),
	"refund_no" varchar(64),
	"order_no" varchar(64),
	"remote_ip" varchar(64),
	"user_agent" text,
	"headers_hash" text NOT NULL,
	"headers_summary_json" jsonb NOT NULL,
	"raw_body_sha256" text NOT NULL,
	"raw_body_bytes" integer NOT NULL,
	"raw_body_excerpt" text,
	"redacted_payload_json" jsonb,
	"signature_valid" boolean,
	"business_valid" boolean,
	"handled" boolean DEFAULT false NOT NULL,
	"duplicate" boolean DEFAULT false NOT NULL,
	"failure_reason" varchar(128),
	"error_code" varchar(128),
	"http_status" integer,
	"retention_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"refund_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"provider_refund_no" varchar(128),
	"status" "refund_status" NOT NULL,
	"raw_payload_json" jsonb NOT NULL,
	"signature_valid" boolean,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_reconciliation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"refund_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"trigger" varchar(32) NOT NULL,
	"attempt_no" integer NOT NULL,
	"status" varchar(32) NOT NULL,
	"provider_refund_status" varchar(64),
	"provider_refund_no" varchar(128),
	"error_code" varchar(128),
	"error_message" text,
	"raw_payload_sha256" text,
	"raw_payload_excerpt" text,
	"next_retry_at" timestamp with time zone,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_configs_provider_global_unique" ON "payment_provider_configs" ("provider_id") WHERE "machine_id" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_reconciliation_attempts_payment_idx" ON "payment_reconciliation_attempts" ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_reconciliation_attempts_next_retry_idx" ON "payment_reconciliation_attempts" ("next_retry_at");--> statement-breakpoint
CREATE INDEX "payment_reconciliation_attempts_status_idx" ON "payment_reconciliation_attempts" ("status");--> statement-breakpoint
CREATE INDEX "payment_webhook_attempts_provider_created_idx" ON "payment_webhook_attempts" ("provider_code","created_at");--> statement-breakpoint
CREATE INDEX "payment_webhook_attempts_payment_id_idx" ON "payment_webhook_attempts" ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_attempts_refund_id_idx" ON "payment_webhook_attempts" ("refund_id");--> statement-breakpoint
CREATE INDEX "payment_webhook_attempts_signature_idx" ON "payment_webhook_attempts" ("signature_valid");--> statement-breakpoint
CREATE INDEX "payment_webhook_attempts_failure_reason_idx" ON "payment_webhook_attempts" ("failure_reason");--> statement-breakpoint
CREATE INDEX "payment_webhook_attempts_retention_idx" ON "payment_webhook_attempts" ("retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_events_provider_event_unique" ON "refund_events" ("provider_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "refund_events_refund_id_idx" ON "refund_events" ("refund_id");--> statement-breakpoint
CREATE INDEX "refund_reconciliation_attempts_refund_idx" ON "refund_reconciliation_attempts" ("refund_id","created_at");--> statement-breakpoint
CREATE INDEX "refund_reconciliation_attempts_next_retry_idx" ON "refund_reconciliation_attempts" ("next_retry_at");--> statement-breakpoint
ALTER TABLE "payment_reconciliation_attempts" ADD CONSTRAINT "payment_reconciliation_attempts_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "payment_reconciliation_attempts" ADD CONSTRAINT "payment_reconciliation_attempts_PERZM16ytwQr_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id");--> statement-breakpoint
ALTER TABLE "payment_webhook_attempts" ADD CONSTRAINT "payment_webhook_attempts_provider_id_payment_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id");--> statement-breakpoint
ALTER TABLE "payment_webhook_attempts" ADD CONSTRAINT "payment_webhook_attempts_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "payment_webhook_attempts" ADD CONSTRAINT "payment_webhook_attempts_refund_id_refunds_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id");--> statement-breakpoint
ALTER TABLE "payment_webhook_attempts" ADD CONSTRAINT "payment_webhook_attempts_jah3fGPpgheQ_fkey" FOREIGN KEY ("matched_config_id") REFERENCES "payment_provider_configs"("id");--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_refund_id_refunds_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id");--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_payment_id_payments_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id");--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_provider_id_payment_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id");--> statement-breakpoint
ALTER TABLE "refund_reconciliation_attempts" ADD CONSTRAINT "refund_reconciliation_attempts_refund_id_refunds_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id");--> statement-breakpoint
ALTER TABLE "refund_reconciliation_attempts" ADD CONSTRAINT "refund_reconciliation_attempts_wyH8bqO8T67X_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id");