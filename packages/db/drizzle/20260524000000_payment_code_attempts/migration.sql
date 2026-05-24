ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'payment_code';--> statement-breakpoint
CREATE TYPE "payment_code_attempt_status" AS ENUM('created', 'submitting', 'user_confirming', 'querying', 'succeeded', 'failed', 'reversing', 'reversed', 'unknown', 'manual_handling', 'canceled');--> statement-breakpoint
CREATE TABLE "payment_code_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"payment_provider_config_id" uuid,
	"attempt_no" integer NOT NULL,
	"provider_payment_no" varchar(64) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"status" "payment_code_attempt_status" DEFAULT 'created' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"auth_code_hash" varchar(64) NOT NULL,
	"auth_code_masked" varchar(32) NOT NULL,
	"source" varchar(32) NOT NULL,
	"scanner_health_json" jsonb,
	"provider_trade_no" varchar(128),
	"provider_status" varchar(64),
	"failure_code" varchar(128),
	"failure_message" text,
	"raw_payload_json" jsonb,
	"submitted_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"manual_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_code_attempts_amount_cents_positive" CHECK ("payment_code_attempts"."amount_cents" > 0)
);--> statement-breakpoint
ALTER TABLE "payment_code_attempts" ADD CONSTRAINT "payment_code_attempts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_code_attempts" ADD CONSTRAINT "payment_code_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_code_attempts" ADD CONSTRAINT "payment_code_attempts_provider_id_payment_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_code_attempts" ADD CONSTRAINT "payment_code_attempts_payment_provider_config_id_payment_provider_configs_id_fk" FOREIGN KEY ("payment_provider_config_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_code_attempts_provider_payment_no_unique" ON "payment_code_attempts" USING btree ("provider_payment_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_code_attempts_idempotency_unique" ON "payment_code_attempts" USING btree ("payment_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_code_attempts_order_attempt_unique" ON "payment_code_attempts" USING btree ("order_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_code_attempts_order_active_unique" ON "payment_code_attempts" USING btree ("order_id") WHERE "payment_code_attempts"."is_active" = true;--> statement-breakpoint
CREATE INDEX "payment_code_attempts_payment_id_idx" ON "payment_code_attempts" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_code_attempts_status_idx" ON "payment_code_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_code_attempts_auth_hash_idx" ON "payment_code_attempts" USING btree ("auth_code_hash");