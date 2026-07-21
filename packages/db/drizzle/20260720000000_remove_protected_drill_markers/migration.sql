DROP INDEX IF EXISTS "orders_is_drill_idx";
DROP INDEX IF EXISTS "payments_is_drill_idx";
DROP INDEX IF EXISTS "refunds_is_drill_idx";

ALTER TABLE "orders" DROP COLUMN IF EXISTS "is_drill";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "drill_scenario";

ALTER TABLE "payments" DROP COLUMN IF EXISTS "is_drill";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "drill_scenario";

ALTER TABLE "refunds" DROP COLUMN IF EXISTS "is_drill";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "drill_scenario";
