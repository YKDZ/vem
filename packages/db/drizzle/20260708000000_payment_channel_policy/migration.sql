CREATE TABLE "payment_channel_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel_key" varchar(64) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "rank" integer NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "updated_by_admin_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_channel_policies_key_check" CHECK ("channel_key" IN ('qr_code:alipay', 'payment_code:alipay', 'qr_code:wechat_pay', 'payment_code:wechat_pay')),
  CONSTRAINT "payment_channel_policies_rank_check" CHECK ("rank" BETWEEN 1 AND 4)
);

ALTER TABLE "payment_channel_policies"
  ADD CONSTRAINT "payment_channel_policies_updated_by_admin_user_id_admin_users_id_fk"
  FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX "payment_channel_policies_key_unique"
  ON "payment_channel_policies" ("channel_key");

CREATE UNIQUE INDEX "payment_channel_policies_rank_unique"
  ON "payment_channel_policies" ("rank");

CREATE UNIQUE INDEX "payment_channel_policies_default_unique"
  ON "payment_channel_policies" ("is_default")
  WHERE "payment_channel_policies"."is_default" = true;
