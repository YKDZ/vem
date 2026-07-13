ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'maintenanceAccess.read';--> statement-breakpoint
ALTER TYPE "permission_code" ADD VALUE IF NOT EXISTS 'maintenanceAccess.write';--> statement-breakpoint

CREATE TYPE "maintenance_peer_role" AS ENUM ('relay', 'runner', 'maintainer', 'machine');--> statement-breakpoint

CREATE TABLE "maintenance_peers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "role" "maintenance_peer_role" NOT NULL,
  "public_key" text NOT NULL,
  "tunnel_address" varchar(15) NOT NULL,
  "machine_id" uuid,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maintenance_peers_role_machine_binding_check"
    CHECK (("role" = 'machine') = ("machine_id" IS NOT NULL)),
  CONSTRAINT "maintenance_peers_status_check"
    CHECK ("status" IN ('active', 'revoked')),
  CONSTRAINT "maintenance_peers_lifecycle_consistency_check"
    CHECK (("status" = 'active' AND "revoked_at" IS NULL)
      OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "maintenance_peers"
  ADD CONSTRAINT "maintenance_peers_machine_id_machines_id_fk"
  FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "maintenance_peers_public_key_unique" ON "maintenance_peers" ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_peers_tunnel_address_unique" ON "maintenance_peers" ("tunnel_address");--> statement-breakpoint
CREATE INDEX "maintenance_peers_role_status_idx" ON "maintenance_peers" ("role", "status");--> statement-breakpoint
CREATE INDEX "maintenance_peers_machine_id_idx" ON "maintenance_peers" ("machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_peers_active_machine_unique"
  ON "maintenance_peers" ("machine_id")
  WHERE "maintenance_peers"."role" = 'machine'
    AND "maintenance_peers"."status" = 'active'
    AND "maintenance_peers"."revoked_at" IS NULL;--> statement-breakpoint

CREATE TABLE "maintenance_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_peer_id" uuid NOT NULL,
  "target_machine_id" uuid NOT NULL,
  "issued_by_admin_user_id" uuid NOT NULL,
  "protocol" varchar(8) DEFAULT 'tcp' NOT NULL,
  "port" integer DEFAULT 22 NOT NULL,
  "reason" varchar(500) NOT NULL,
  "issued_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "maintenance_sessions_protocol_port_check"
    CHECK ("protocol" = 'tcp' AND "port" = 22),
  CONSTRAINT "maintenance_sessions_expiry_after_issue_check"
    CHECK ("expires_at" > "issued_at")
);--> statement-breakpoint

ALTER TABLE "maintenance_sessions"
  ADD CONSTRAINT "maintenance_sessions_source_peer_id_maintenance_peers_id_fk"
  FOREIGN KEY ("source_peer_id") REFERENCES "maintenance_peers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_sessions"
  ADD CONSTRAINT "maintenance_sessions_target_machine_id_machines_id_fk"
  FOREIGN KEY ("target_machine_id") REFERENCES "machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_sessions"
  ADD CONSTRAINT "maintenance_sessions_issued_by_admin_user_id_admin_users_id_fk"
  FOREIGN KEY ("issued_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "maintenance_sessions_source_peer_id_idx" ON "maintenance_sessions" ("source_peer_id");--> statement-breakpoint
CREATE INDEX "maintenance_sessions_target_machine_id_idx" ON "maintenance_sessions" ("target_machine_id");--> statement-breakpoint
CREATE INDEX "maintenance_sessions_expires_at_idx" ON "maintenance_sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "maintenance_sessions_actor_id_idx" ON "maintenance_sessions" ("issued_by_admin_user_id");--> statement-breakpoint

CREATE TABLE "maintenance_relay_control_state" (
  "singleton_key" varchar(32) PRIMARY KEY NOT NULL,
  "desired_state_version" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maintenance_relay_control_state_singleton_check"
    CHECK ("singleton_key" = 'default'),
  CONSTRAINT "maintenance_relay_control_state_version_check"
    CHECK ("desired_state_version" >= 0)
);--> statement-breakpoint

INSERT INTO "maintenance_relay_control_state" ("singleton_key", "desired_state_version")
VALUES ('default', 0);
