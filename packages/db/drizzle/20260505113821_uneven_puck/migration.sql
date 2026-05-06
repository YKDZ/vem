ALTER TYPE "permission_code" ADD VALUE 'machines.manage-credentials' BEFORE 'adminUsers.read';--> statement-breakpoint
DROP INDEX "refunds_order_reason_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_order_reason_active_unique" ON "refunds" ("order_id","reason") WHERE "status" IN ('created', 'processing', 'succeeded');