DROP TABLE IF EXISTS "maintenance_automation_exchanges" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "maintenance_ssh_certificates" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "maintenance_sessions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "maintenance_relay_control_state" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "maintenance_relay_desired_state_revisions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "maintenance_peers" CASCADE;--> statement-breakpoint
DELETE FROM "permissions"
WHERE "code"::text IN ('maintenanceAccess.read', 'maintenanceAccess.write');--> statement-breakpoint
DROP TYPE IF EXISTS "maintenance_peer_role";
