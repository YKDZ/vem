ALTER TABLE "orders" ADD COLUMN "is_drill" boolean DEFAULT false NOT NULL;
ALTER TABLE "orders" ADD COLUMN "drill_scenario" varchar(64);

ALTER TABLE "payments" ADD COLUMN "is_drill" boolean DEFAULT false NOT NULL;
ALTER TABLE "payments" ADD COLUMN "drill_scenario" varchar(64);

ALTER TABLE "refunds" ADD COLUMN "is_drill" boolean DEFAULT false NOT NULL;
ALTER TABLE "refunds" ADD COLUMN "drill_scenario" varchar(64);

CREATE INDEX "orders_is_drill_idx" ON "orders" ("is_drill");
CREATE INDEX "payments_is_drill_idx" ON "payments" ("is_drill");
CREATE INDEX "refunds_is_drill_idx" ON "refunds" ("is_drill");
