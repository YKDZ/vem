ALTER TABLE "payment_code_attempts"
  ADD COLUMN "recovery_lease_expires_at" timestamp with time zone,
  ADD COLUMN "recovery_lease_owner_token" varchar(64),
  ADD COLUMN "recovery_lease_fence" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "recovery_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "recovery_next_at" timestamp with time zone;

CREATE INDEX "payment_code_attempts_recovery_due_idx"
  ON "payment_code_attempts" USING btree ("recovery_next_at")
  WHERE "payment_code_attempts"."is_active" = true;
