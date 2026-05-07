ALTER TABLE "payments" ADD COLUMN "payment_provider_config_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_config_snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_xQAgY1Jf53P8_fkey" FOREIGN KEY ("payment_provider_config_id") REFERENCES "payment_provider_configs"("id");