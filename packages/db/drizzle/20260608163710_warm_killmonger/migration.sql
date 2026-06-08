CREATE TYPE "machine_claim_code_state" AS ENUM('pending', 'consumed', 'expired', 'revoked', 'locked');--> statement-breakpoint
CREATE TABLE "machine_claim_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"machine_id" uuid NOT NULL,
	"verifier_hash" text NOT NULL,
	"state" "machine_claim_code_state" DEFAULT 'pending'::"machine_claim_code_state" NOT NULL,
	"failed_attempt_count" integer DEFAULT 0 NOT NULL,
	"max_failed_attempts" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"created_by_admin_user_id" uuid,
	"revoked_by_admin_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_claim_codes_failed_attempt_count_non_negative" CHECK ("failed_attempt_count" >= 0),
	CONSTRAINT "machine_claim_codes_max_failed_attempts_positive" CHECK ("max_failed_attempts" > 0)
);
--> statement-breakpoint
CREATE INDEX "machine_claim_codes_machine_id_idx" ON "machine_claim_codes" ("machine_id");--> statement-breakpoint
CREATE INDEX "machine_claim_codes_state_idx" ON "machine_claim_codes" ("state");--> statement-breakpoint
CREATE INDEX "machine_claim_codes_expires_at_idx" ON "machine_claim_codes" ("expires_at");--> statement-breakpoint
CREATE INDEX "machine_claim_codes_created_by_admin_user_id_idx" ON "machine_claim_codes" ("created_by_admin_user_id");--> statement-breakpoint
CREATE INDEX "machine_claim_codes_revoked_by_admin_user_id_idx" ON "machine_claim_codes" ("revoked_by_admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_claim_codes_machine_open_unique" ON "machine_claim_codes" ("machine_id") WHERE "state" IN ('pending', 'locked');--> statement-breakpoint
ALTER TABLE "machine_claim_codes" ADD CONSTRAINT "machine_claim_codes_machine_id_machines_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id");--> statement-breakpoint
ALTER TABLE "machine_claim_codes" ADD CONSTRAINT "machine_claim_codes_v59XzapShlkJ_fkey" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id");--> statement-breakpoint
ALTER TABLE "machine_claim_codes" ADD CONSTRAINT "machine_claim_codes_koAi3OTYEMKN_fkey" FOREIGN KEY ("revoked_by_admin_user_id") REFERENCES "admin_users"("id");