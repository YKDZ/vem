ALTER TABLE "machines" ADD COLUMN "secret_hash" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "secret_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "secret_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "credential_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mqtt_signing_secret_encrypted_json" jsonb;--> statement-breakpoint
CREATE INDEX "machines_credential_revoked_at_idx" ON "machines" ("credential_revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vending_commands_order_slot_unique" ON "vending_commands" ("order_id","slot_id");