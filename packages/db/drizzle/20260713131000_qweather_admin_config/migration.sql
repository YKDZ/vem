CREATE TABLE "qweather_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_code" varchar(32) NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "api_host" varchar(255) NOT NULL,
  "jwt_key_id" varchar(128) NOT NULL,
  "jwt_project_id" varchar(128) NOT NULL,
  "private_key_encrypted_json" jsonb,
  "weather_now_path" varchar(255) DEFAULT '/v7/weather/now' NOT NULL,
  "sun_path" varchar(255) DEFAULT '/v7/astronomy/sun' NOT NULL,
  "timeout_ms" integer DEFAULT 3000 NOT NULL,
  "updated_by_admin_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "qweather_configs_provider_code_unique"
  ON "qweather_configs" ("provider_code");
--> statement-breakpoint
ALTER TABLE "qweather_configs"
  ADD CONSTRAINT "qweather_configs_updated_by_admin_user_id_admin_users_id_fkey"
  FOREIGN KEY ("updated_by_admin_user_id") REFERENCES "admin_users"("id");
