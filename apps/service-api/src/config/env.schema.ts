import { z } from "zod";

import { parseMaintenanceAddressPools } from "../maintenance-access/maintenance-address-pools";

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(604800),
  MACHINE_JWT_SECRET: z.string().min(32),
  MACHINE_CREDENTIAL_ENCRYPTION_KEY: z.string().min(32),
  MACHINE_CLAIM_LOOKUP_HMAC_KEY: z
    .string()
    .min(32)
    .default("dev-machine-claim-lookup-hmac-key-change-me"),
  MACHINE_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  MQTT_URL: z.url(),
  MQTT_USERNAME: z.string().min(1).optional(),
  MQTT_PASSWORD: z.string().min(1).optional(),
  MQTT_SIGNATURE_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(300),
  MACHINE_COMMAND_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(5),
  MACHINE_HEARTBEAT_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(180),
  MACHINE_CLAIM_CODE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(600),
  MAINTENANCE_RELAY_ADDRESS_POOL: z.string().default("10.91.0.0/24"),
  MAINTENANCE_RUNNER_ADDRESS_POOL: z.string().default("10.91.1.0/24"),
  MAINTENANCE_MAINTAINER_ADDRESS_POOL: z.string().default("10.91.3.0/24"),
  MAINTENANCE_MACHINE_ADDRESS_POOL: z.string().default("10.91.16.0/20"),
  MAINTENANCE_RELAY_CREDENTIAL: z
    .string()
    .min(32)
    .default("dev-maintenance-relay-credential-change-me"),
  MAINTENANCE_RELAY_JWT_SECRET: z
    .string()
    .min(32)
    .default("dev-maintenance-relay-jwt-secret-change-me"),
  MAINTENANCE_RELAY_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(300),
  MAINTENANCE_GITHUB_OIDC_TRUST_POLICY: z.string().min(1).optional(),
  MAINTENANCE_GITHUB_OIDC_TRUST_POLICY_PATH: z.string().min(1).optional(),
  MAINTENANCE_GITHUB_OIDC_JWKS_JSON: z.string().min(1).optional(),
  MAINTENANCE_GITHUB_OIDC_JWKS_PATH: z.string().min(1).optional(),
  MAINTENANCE_GITHUB_OIDC_JWKS_URL: z.url().optional(),
  MAINTENANCE_AUTOMATION_JWT_SECRET: z.string().min(32).optional(),
  MAINTENANCE_AUTOMATION_JWT_SECRET_PATH: z.string().min(1).optional(),
  PAYMENT_MOCK_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) return true;
        if (["false", "0", "no", "off"].includes(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  PAYMENT_WEBHOOK_BASE_URL: z.url(),
  MACHINE_API_BASE_URL: z.url().default("http://localhost:3000/api"),
  MEDIA_ASSET_STORAGE_ROOT: z
    .string()
    .min(1)
    .default("/var/lib/vem/service-api/media-assets"),
  MEDIA_ASSET_PUBLIC_BASE_URL: z.url().optional(),
  PAYMENT_CONFIG_ENCRYPTION_KEY: z
    .string()
    .min(32)
    .default("dev-payment-config-encryption-key-change-me"),
  PAYMENT_RECONCILE_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(120),
  PAYMENT_PRODUCTION_READINESS_REQUIRED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) return true;
        if (["false", "0", "no", "off"].includes(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(false),
  PAYMENT_ALERT_WINDOW_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(1440)
    .default(60),
  PAYMENT_CERTIFICATE_EXPIRY_WARNING_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .default(30),
  QWEATHER_API_KEY: z.string().min(1).optional(),
  QWEATHER_API_HOST: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9.-]+$/)
    .optional(),
  QWEATHER_JWT_KEY_ID: z.string().min(1).optional(),
  QWEATHER_JWT_PROJECT_ID: z.string().min(1).optional(),
  QWEATHER_JWT_PRIVATE_KEY: z.string().min(1).optional(),
  QWEATHER_JWT_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  QWEATHER_WEATHER_NOW_PATH: z
    .string()
    .regex(/^\/.+/)
    .default("/v7/weather/now"),
  QWEATHER_SUN_PATH: z.string().regex(/^\/.+/).default("/v7/astronomy/sun"),
  QWEATHER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(3_000),
  BOOTSTRAP_ADMIN_USERNAME: z.string().min(3).max(64).default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).max(128),
});

const DEFAULT_PAYMENT_CONFIG_ENCRYPTION_KEY =
  "dev-payment-config-encryption-key-change-me";

export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  for (const key of [
    "MAINTENANCE_GITHUB_OIDC_TRUST_POLICY",
    "MAINTENANCE_GITHUB_OIDC_JWKS_JSON",
    "MAINTENANCE_GITHUB_OIDC_JWKS_URL",
    "MAINTENANCE_AUTOMATION_JWT_SECRET",
  ] as const) {
    if (env[key]) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is not supported; mount deployment-owned read-only configuration instead`,
      });
    }
  }
  try {
    parseMaintenanceAddressPools({
      relay: env.MAINTENANCE_RELAY_ADDRESS_POOL,
      runner: env.MAINTENANCE_RUNNER_ADDRESS_POOL,
      maintainer: env.MAINTENANCE_MAINTAINER_ADDRESS_POOL,
      machine: env.MAINTENANCE_MACHINE_ADDRESS_POOL,
    });
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["MAINTENANCE_RELAY_ADDRESS_POOL"],
      message:
        error instanceof Error
          ? error.message
          : "Maintenance address pools are invalid",
    });
  }
  if (env.NODE_ENV === "production" && env.PAYMENT_MOCK_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["PAYMENT_MOCK_ENABLED"],
      message: "PAYMENT_MOCK_ENABLED must be false in production",
    });
  }
  if (
    env.NODE_ENV === "production" &&
    env.MAINTENANCE_RELAY_CREDENTIAL ===
      "dev-maintenance-relay-credential-change-me"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["MAINTENANCE_RELAY_CREDENTIAL"],
      message:
        "MAINTENANCE_RELAY_CREDENTIAL must be set explicitly in production",
    });
  }
  if (
    env.NODE_ENV === "production" &&
    env.MAINTENANCE_RELAY_JWT_SECRET ===
      "dev-maintenance-relay-jwt-secret-change-me"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["MAINTENANCE_RELAY_JWT_SECRET"],
      message:
        "MAINTENANCE_RELAY_JWT_SECRET must be set explicitly in production",
    });
  }
  if (
    env.NODE_ENV === "production" &&
    [
      env.JWT_SECRET,
      env.JWT_REFRESH_SECRET,
      env.MACHINE_JWT_SECRET,
      env.MACHINE_CLAIM_LOOKUP_HMAC_KEY,
      env.MAINTENANCE_RELAY_JWT_SECRET,
    ].includes(env.MAINTENANCE_RELAY_CREDENTIAL)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["MAINTENANCE_RELAY_CREDENTIAL"],
      message:
        "MAINTENANCE_RELAY_CREDENTIAL must differ from signing and HMAC secrets in production",
    });
  }
  if (
    env.NODE_ENV === "production" &&
    env.MACHINE_CLAIM_LOOKUP_HMAC_KEY ===
      "dev-machine-claim-lookup-hmac-key-change-me"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["MACHINE_CLAIM_LOOKUP_HMAC_KEY"],
      message:
        "MACHINE_CLAIM_LOOKUP_HMAC_KEY must be set explicitly in production",
    });
  }
  if (
    env.NODE_ENV === "production" &&
    (!env.MQTT_USERNAME || !env.MQTT_PASSWORD)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["MQTT_USERNAME"],
      message: "MQTT_USERNAME and MQTT_PASSWORD are required in production",
    });
  }
  if (
    env.NODE_ENV === "production" &&
    env.PAYMENT_CONFIG_ENCRYPTION_KEY === DEFAULT_PAYMENT_CONFIG_ENCRYPTION_KEY
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["PAYMENT_CONFIG_ENCRYPTION_KEY"],
      message:
        "PAYMENT_CONFIG_ENCRYPTION_KEY must be set explicitly in production",
    });
  }
  if (
    env.NODE_ENV === "production" &&
    !env.PAYMENT_PRODUCTION_READINESS_REQUIRED
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["PAYMENT_PRODUCTION_READINESS_REQUIRED"],
      message:
        "PAYMENT_PRODUCTION_READINESS_REQUIRED must be true in production",
    });
  }
  if (env.NODE_ENV === "production") {
    const webhookBase = new URL(env.PAYMENT_WEBHOOK_BASE_URL);
    if (webhookBase.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_WEBHOOK_BASE_URL"],
        message: "PAYMENT_WEBHOOK_BASE_URL must use https in production",
      });
    }
  }
  if (env.QWEATHER_API_KEY) {
    ctx.addIssue({
      code: "custom",
      path: ["QWEATHER_API_KEY"],
      message: "QWEATHER_API_KEY is no longer supported; use QWeather JWT",
    });
  }
  const qweatherConfigured = Boolean(
    env.QWEATHER_API_HOST ||
    env.QWEATHER_JWT_KEY_ID ||
    env.QWEATHER_JWT_PROJECT_ID ||
    env.QWEATHER_JWT_PRIVATE_KEY ||
    env.QWEATHER_JWT_PRIVATE_KEY_PATH,
  );
  if (qweatherConfigured && !env.QWEATHER_API_HOST) {
    ctx.addIssue({
      code: "custom",
      path: ["QWEATHER_API_HOST"],
      message: "QWEATHER_API_HOST is required when QWeather is configured",
    });
  }
  if (
    env.QWEATHER_API_HOST &&
    ["api.qweather.com", "devapi.qweather.com", "geoapi.qweather.com"].includes(
      env.QWEATHER_API_HOST,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["QWEATHER_API_HOST"],
      message: "QWEATHER_API_HOST must be the account-specific API Host",
    });
  }
  if (qweatherConfigured && !env.QWEATHER_JWT_KEY_ID) {
    ctx.addIssue({
      code: "custom",
      path: ["QWEATHER_JWT_KEY_ID"],
      message: "QWEATHER_JWT_KEY_ID is required when QWeather is configured",
    });
  }
  if (qweatherConfigured && !env.QWEATHER_JWT_PROJECT_ID) {
    ctx.addIssue({
      code: "custom",
      path: ["QWEATHER_JWT_PROJECT_ID"],
      message:
        "QWEATHER_JWT_PROJECT_ID is required when QWeather is configured",
    });
  }
  if (
    qweatherConfigured &&
    !env.QWEATHER_JWT_PRIVATE_KEY &&
    !env.QWEATHER_JWT_PRIVATE_KEY_PATH
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["QWEATHER_JWT_PRIVATE_KEY"],
      message:
        "QWEATHER_JWT_PRIVATE_KEY or QWEATHER_JWT_PRIVATE_KEY_PATH is required when QWeather is configured",
    });
  }
  if (env.QWEATHER_JWT_PRIVATE_KEY && env.QWEATHER_JWT_PRIVATE_KEY_PATH) {
    ctx.addIssue({
      code: "custom",
      path: ["QWEATHER_JWT_PRIVATE_KEY_PATH"],
      message:
        "Set only one of QWEATHER_JWT_PRIVATE_KEY or QWEATHER_JWT_PRIVATE_KEY_PATH",
    });
  }
});

export type ServiceEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): ServiceEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid service-api environment: ${parsed.error.message}`);
  }
  return parsed.data;
}
