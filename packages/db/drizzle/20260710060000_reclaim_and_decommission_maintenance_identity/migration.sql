ALTER TABLE "maintenance_peers"
  ADD COLUMN "reclaim_expires_at" timestamptz,
  ADD COLUMN "handshake_verified_at" timestamptz,
  ADD COLUMN "reclaim_failed_at" timestamptz,
  ADD COLUMN "reclaim_failure_reason" varchar(128);

ALTER TABLE "maintenance_peers"
  DROP CONSTRAINT "maintenance_peers_status_check",
  ADD CONSTRAINT "maintenance_peers_status_check"
    CHECK ("maintenance_peers"."status" IN ('active', 'pending_reclaim', 'reclaim_failed', 'revoked')),
  DROP CONSTRAINT "maintenance_peers_lifecycle_consistency_check",
  ADD CONSTRAINT "maintenance_peers_lifecycle_consistency_check"
    CHECK (
      ("maintenance_peers"."status" = 'active'
        AND "maintenance_peers"."revoked_at" IS NULL
        AND "maintenance_peers"."reclaim_expires_at" IS NULL
        AND "maintenance_peers"."reclaim_failed_at" IS NULL
        AND "maintenance_peers"."reclaim_failure_reason" IS NULL)
      OR ("maintenance_peers"."status" = 'pending_reclaim'
        AND "maintenance_peers"."revoked_at" IS NULL
        AND "maintenance_peers"."reclaim_expires_at" IS NOT NULL
        AND "maintenance_peers"."handshake_verified_at" IS NULL
        AND "maintenance_peers"."reclaim_failed_at" IS NULL
        AND "maintenance_peers"."reclaim_failure_reason" IS NULL)
      OR ("maintenance_peers"."status" = 'reclaim_failed'
        AND "maintenance_peers"."revoked_at" IS NULL
        AND "maintenance_peers"."reclaim_expires_at" IS NOT NULL
        AND "maintenance_peers"."handshake_verified_at" IS NULL
        AND "maintenance_peers"."reclaim_failed_at" IS NOT NULL
        AND "maintenance_peers"."reclaim_failure_reason" IS NOT NULL)
      OR ("maintenance_peers"."status" = 'revoked'
        AND "maintenance_peers"."revoked_at" IS NOT NULL
        AND "maintenance_peers"."reclaim_expires_at" IS NULL
        AND "maintenance_peers"."reclaim_failed_at" IS NULL
        AND "maintenance_peers"."reclaim_failure_reason" IS NULL)
    );

CREATE UNIQUE INDEX "maintenance_peers_pending_machine_unique"
  ON "maintenance_peers" ("machine_id")
  WHERE "role" = 'machine' AND "status" = 'pending_reclaim' AND "revoked_at" IS NULL;

ALTER TABLE "machine_commands"
  ADD COLUMN "delivery_topic" varchar(255),
  ADD COLUMN "delivery_payload_json" jsonb,
  ADD COLUMN "delivery_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "next_delivery_attempt_at" timestamptz,
  ADD COLUMN "delivery_expires_at" timestamptz;

CREATE INDEX "machine_commands_next_delivery_attempt_at_idx"
  ON "machine_commands" ("next_delivery_attempt_at");
