ALTER TABLE "payments"
  ADD COLUMN "intent_creation_lease_owner_token" varchar(64),
  ADD COLUMN "intent_creation_lease_fence" bigint DEFAULT 0 NOT NULL;
