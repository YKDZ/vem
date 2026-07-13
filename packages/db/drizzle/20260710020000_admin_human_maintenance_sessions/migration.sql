ALTER TABLE "maintenance_sessions"
  ADD COLUMN "session_kind" varchar(16),
  ADD COLUMN "target_peer_id" uuid,
  ADD COLUMN "automation_actor_id" varchar(128),
  ADD COLUMN "activated_at" timestamp with time zone,
  ADD COLUMN "expired_at" timestamp with time zone,
  ADD COLUMN "failed_at" timestamp with time zone,
  ADD COLUMN "failure_reason_code" varchar(64),
  ADD COLUMN "desired_state_version" bigint;--> statement-breakpoint

UPDATE "maintenance_sessions" session
SET
  "session_kind" = CASE
    WHEN source_peer."role" = 'maintainer' THEN 'human'
    ELSE 'ci'
  END,
  "automation_actor_id" = CASE
    WHEN source_peer."role" = 'runner' THEN 'legacy-control-plane'
    ELSE NULL
  END,
  "issued_by_admin_user_id" = CASE
    WHEN source_peer."role" = 'maintainer' THEN session."issued_by_admin_user_id"
    ELSE NULL
  END
FROM "maintenance_peers" source_peer
WHERE source_peer."id" = session."source_peer_id";--> statement-breakpoint

UPDATE "maintenance_sessions" session
SET "target_peer_id" = (
  SELECT peer."id"
  FROM "maintenance_peers" peer
  WHERE peer."machine_id" = session."target_machine_id"
    AND peer."role" = 'machine'
  ORDER BY
    CASE WHEN peer."status" = 'active' AND peer."revoked_at" IS NULL THEN 0 ELSE 1 END,
    peer."created_at" DESC
  LIMIT 1
);--> statement-breakpoint

UPDATE "maintenance_sessions"
SET "desired_state_version" = control."desired_state_version"
FROM "maintenance_relay_control_state" control
WHERE control."singleton_key" = 'default';--> statement-breakpoint

ALTER TABLE "maintenance_sessions"
  ALTER COLUMN "issued_by_admin_user_id" DROP NOT NULL,
  ALTER COLUMN "session_kind" SET NOT NULL,
  ALTER COLUMN "target_peer_id" SET NOT NULL,
  ALTER COLUMN "desired_state_version" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "maintenance_sessions"
  ADD CONSTRAINT "maintenance_sessions_target_peer_id_maintenance_peers_id_fk"
  FOREIGN KEY ("target_peer_id") REFERENCES "maintenance_peers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "maintenance_sessions"
  ADD CONSTRAINT "maintenance_sessions_desired_state_version_revision_fk"
  FOREIGN KEY ("desired_state_version") REFERENCES "maintenance_relay_desired_state_revisions"("revision") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

ALTER TABLE "maintenance_sessions"
  ADD CONSTRAINT "maintenance_sessions_kind_check"
  CHECK ("session_kind" IN ('human', 'ci')),
  ADD CONSTRAINT "maintenance_sessions_actor_consistency_check"
  CHECK (
    ("session_kind" = 'human' AND "issued_by_admin_user_id" IS NOT NULL AND "automation_actor_id" IS NULL)
    OR
    ("session_kind" = 'ci' AND "issued_by_admin_user_id" IS NULL AND "automation_actor_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "maintenance_sessions_failure_consistency_check"
  CHECK (("failed_at" IS NULL) = ("failure_reason_code" IS NULL)),
  ADD CONSTRAINT "maintenance_sessions_failure_reason_code_check"
  CHECK (
    "failure_reason_code" IS NULL
    OR "failure_reason_code" IN (
      'desired_state_rejected',
      'wireguard_apply_failed',
      'firewall_apply_failed',
      'journal_persist_failed',
      'peer_observation_failed',
      'relay_internal_error'
    )
  ),
  ADD CONSTRAINT "maintenance_sessions_terminal_exclusivity_check"
  CHECK (num_nonnulls("revoked_at", "expired_at", "failed_at") <= 1),
  ADD CONSTRAINT "maintenance_sessions_lifecycle_time_check"
  CHECK (
    ("activated_at" IS NULL OR ("activated_at" >= "issued_at" AND "activated_at" < "expires_at"))
    AND ("revoked_at" IS NULL OR ("revoked_at" >= "issued_at" AND "revoked_at" < "expires_at"))
    AND ("failed_at" IS NULL OR ("failed_at" >= "issued_at" AND "failed_at" < "expires_at"))
    AND ("expired_at" IS NULL OR "expired_at" = "expires_at")
  ),
  ADD CONSTRAINT "maintenance_sessions_desired_state_version_check"
  CHECK ("desired_state_version" >= 0);--> statement-breakpoint

DROP INDEX "maintenance_sessions_expires_at_idx";--> statement-breakpoint
DROP INDEX "maintenance_sessions_actor_id_idx";--> statement-breakpoint

CREATE INDEX "maintenance_sessions_target_peer_id_idx"
  ON "maintenance_sessions" ("target_peer_id");--> statement-breakpoint
CREATE INDEX "maintenance_sessions_active_expiry_idx"
  ON "maintenance_sessions" ("expires_at", "issued_at")
  WHERE "revoked_at" IS NULL AND "expired_at" IS NULL AND "failed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "maintenance_sessions_revoked_status_idx"
  ON "maintenance_sessions" ("revoked_at", "issued_at")
  WHERE "revoked_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "maintenance_sessions_expired_status_idx"
  ON "maintenance_sessions" ("expired_at", "issued_at")
  WHERE "expired_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "maintenance_sessions_failed_status_idx"
  ON "maintenance_sessions" ("failed_at", "issued_at")
  WHERE "failed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "maintenance_sessions_kind_issued_idx"
  ON "maintenance_sessions" ("session_kind", "issued_at");--> statement-breakpoint
CREATE INDEX "maintenance_sessions_admin_actor_idx"
  ON "maintenance_sessions" ("issued_by_admin_user_id")
  WHERE "issued_by_admin_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "maintenance_sessions_automation_actor_idx"
  ON "maintenance_sessions" ("automation_actor_id")
  WHERE "automation_actor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "maintenance_sessions_desired_revision_idx"
  ON "maintenance_sessions" ("desired_state_version");
