CREATE TABLE "maintenance_automation_exchanges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "oidc_issuer" varchar(255) NOT NULL,
  "oidc_token_id" varchar(512) NOT NULL,
  "github_repository_id" varchar(20) NOT NULL,
  "github_claim_model" varchar(16) NOT NULL,
  "github_workflow_ref" varchar(1024) NOT NULL,
  "github_workflow_sha" varchar(40) NOT NULL,
  "github_ref" varchar(512) NOT NULL,
  "automation_token_digest" varchar(64) NOT NULL,
  "github_run_id" varchar(20) NOT NULL,
  "github_run_attempt" varchar(10) NOT NULL,
  "github_sha" varchar(40) NOT NULL,
  "source_peer_id" uuid NOT NULL,
  "target_machine_id" uuid NOT NULL,
  "reason" varchar(500) NOT NULL,
  "session_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maintenance_automation_exchanges_digest_check"
    CHECK ("automation_token_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "maintenance_automation_exchanges_sha_check"
    CHECK ("github_sha" ~ '^[0-9a-f]{40}$' AND "github_workflow_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "maintenance_automation_exchanges_claim_model_check"
    CHECK ("github_claim_model" IN ('direct', 'reusable')),
  CONSTRAINT "maintenance_automation_exchanges_expiry_check"
    CHECK ("expires_at" > "created_at")
);--> statement-breakpoint
ALTER TABLE "maintenance_automation_exchanges"
  ADD CONSTRAINT "maintenance_automation_exchanges_source_peer_id_maintenance_peers_id_fk"
  FOREIGN KEY ("source_peer_id") REFERENCES "maintenance_peers"("id") ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT "maintenance_automation_exchanges_target_machine_id_machines_id_fk"
  FOREIGN KEY ("target_machine_id") REFERENCES "machines"("id") ON DELETE no action ON UPDATE no action,
  ADD CONSTRAINT "maintenance_automation_exchanges_session_id_maintenance_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "maintenance_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_automation_exchanges_oidc_jti_unique"
  ON "maintenance_automation_exchanges" USING btree ("oidc_issuer", "oidc_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_automation_exchanges_run_attempt_unique"
  ON "maintenance_automation_exchanges" USING btree ("oidc_issuer", "github_repository_id", "github_run_id", "github_run_attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_automation_exchanges_token_digest_unique"
  ON "maintenance_automation_exchanges" USING btree ("automation_token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_automation_exchanges_session_unique"
  ON "maintenance_automation_exchanges" USING btree ("session_id") WHERE "session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "maintenance_automation_exchanges_run_idx"
  ON "maintenance_automation_exchanges" USING btree ("github_run_id", "github_run_attempt");--> statement-breakpoint
CREATE INDEX "maintenance_automation_exchanges_active_idx"
  ON "maintenance_automation_exchanges" USING btree ("expires_at", "revoked_at");
