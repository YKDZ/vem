ALTER TABLE "orders"
  ADD COLUMN "payment_creation_idempotency_key" varchar(128);

CREATE UNIQUE INDEX "orders_machine_payment_creation_idempotency_unique"
  ON "orders" ("machine_id", "payment_creation_idempotency_key")
  WHERE "payment_creation_idempotency_key" IS NOT NULL;

ALTER TABLE "payments"
  ADD COLUMN "intent_creation_lease_expires_at" timestamp with time zone;
