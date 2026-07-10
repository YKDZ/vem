ALTER TABLE "maintenance_relay_control_state"
  ADD COLUMN "observed_state" jsonb;

CREATE TABLE "maintenance_relay_desired_state_revisions" (
  "revision" bigint PRIMARY KEY NOT NULL,
  "desired_state" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maintenance_relay_desired_state_revision_nonnegative_check"
    CHECK ("revision" >= 0)
);

INSERT INTO "maintenance_relay_desired_state_revisions" (
  "revision",
  "desired_state"
)
SELECT
  control."desired_state_version",
  jsonb_build_object(
    'schemaVersion', 'maintenance-relay-desired-state/v1',
    'desiredStateVersion', control."desired_state_version",
    'generatedAt', to_char(
      control."updated_at" AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'peers', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', peer."id",
          'role', peer."role",
          'publicKey', peer."public_key",
          'tunnelAddress', peer."tunnel_address"
        )
        ORDER BY peer."tunnel_address"
      )
      FROM "maintenance_peers" peer
      WHERE peer."status" = 'active'
        AND peer."revoked_at" IS NULL
    ), '[]'::jsonb),
    'authorizations', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'sessionId', session."id",
          'sourcePeerId', source_peer."id",
          'sourceTunnelAddress', source_peer."tunnel_address",
          'targetMachineId', session."target_machine_id",
          'targetTunnelAddress', target_peer."tunnel_address",
          'protocol', session."protocol",
          'port', session."port",
          'expiresAt', to_char(
            session."expires_at" AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )
        ORDER BY session."issued_at" DESC
      )
      FROM "maintenance_sessions" session
      INNER JOIN "maintenance_peers" source_peer
        ON source_peer."id" = session."source_peer_id"
       AND source_peer."role" = 'runner'
       AND source_peer."status" = 'active'
       AND source_peer."revoked_at" IS NULL
      INNER JOIN "maintenance_peers" target_peer
        ON target_peer."machine_id" = session."target_machine_id"
       AND target_peer."role" = 'machine'
       AND target_peer."status" = 'active'
       AND target_peer."revoked_at" IS NULL
      WHERE session."revoked_at" IS NULL
    ), '[]'::jsonb)
  )
FROM "maintenance_relay_control_state" control
WHERE control."singleton_key" = 'default';
