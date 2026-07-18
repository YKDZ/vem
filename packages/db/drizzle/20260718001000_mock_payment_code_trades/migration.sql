CREATE TABLE "mock_payment_code_trades" (
  "provider_payment_no" varchar(64) PRIMARY KEY NOT NULL,
  "charge_idempotency_key" varchar(128) NOT NULL,
  "reversal_idempotency_key" varchar(128),
  "provider_trade_no" varchar(128) NOT NULL,
  "amount_cents" integer NOT NULL,
  "auth_code_length" integer NOT NULL,
  "status" varchar(16) NOT NULL,
  "charge_accepted_count" integer DEFAULT 1 NOT NULL,
  "reversal_accepted_count" integer DEFAULT 0 NOT NULL,
  "paid_at" timestamp with time zone NOT NULL,
  "reversed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mock_payment_code_trades_status_check"
    CHECK ("status" in ('succeeded', 'reversed')),
  CONSTRAINT "mock_payment_code_trades_charge_once_check"
    CHECK ("charge_accepted_count" = 1),
  CONSTRAINT "mock_payment_code_trades_reversal_once_check"
    CHECK ("reversal_accepted_count" in (0, 1))
);

CREATE UNIQUE INDEX "mock_payment_code_trades_charge_idempotency_unique"
  ON "mock_payment_code_trades" USING btree ("charge_idempotency_key");

CREATE UNIQUE INDEX "mock_payment_code_trades_provider_trade_no_unique"
  ON "mock_payment_code_trades" USING btree ("provider_trade_no");
