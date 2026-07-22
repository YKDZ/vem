DELETE FROM "role_permissions"
WHERE "permission_id" IN (
  SELECT "id" FROM "permissions"
  WHERE "code"::text = 'inventory.refill'
);--> statement-breakpoint
DELETE FROM "permissions"
WHERE "code"::text = 'inventory.refill';--> statement-breakpoint

ALTER TYPE "permission_code" RENAME TO "permission_code_retired";--> statement-breakpoint
CREATE TYPE "permission_code" AS ENUM(
  'dashboard.read',
  'products.read',
  'products.write',
  'inventory.read',
  'inventory.adjust',
  'orders.read',
  'orders.recover',
  'orders.refund',
  'payments.read',
  'payments.configure',
  'payments.refund',
  'machines.read',
  'machines.write',
  'machines.command',
  'machines.manage-credentials',
  'adminUsers.read',
  'adminUsers.write',
  'roles.write',
  'notifications.read',
  'notifications.write',
  'audit.read',
  'machineOps.read',
  'machineOps.write',
  'hardwareErrorPolicies.read',
  'hardwareErrorPolicies.write',
  'maintenanceWorkOrders.read',
  'maintenanceWorkOrders.write'
);--> statement-breakpoint
ALTER TABLE "permissions"
  ALTER COLUMN "code" TYPE "permission_code"
  USING "code"::text::"permission_code";--> statement-breakpoint
DROP TYPE "permission_code_retired";
