import { z } from "zod";

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SERVICE_HOST: z.string().min(1).default("0.0.0.0"),
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
  MACHINE_MQTT_URL: z.url(),
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
    .default(15),
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
    .max(86400)
    .default(600),
  MACHINE_RECLAIM_HANDSHAKE_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(300),
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
  PAYMENT_MOCK_PROVIDER_RESPONSE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(0),
  PAYMENT_MOCK_PROVIDER_CREATE_GATE_PATH: z.string().min(1).optional(),
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
  if (env.NODE_ENV === "production" && env.PAYMENT_MOCK_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["PAYMENT_MOCK_ENABLED"],
      message: "PAYMENT_MOCK_ENABLED must be false in production",
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
  const parsed = envSchema.safeParse({
    ...config,
    MACHINE_MQTT_URL:
      config["MACHINE_MQTT_URL"] === undefined
        ? config["MQTT_URL"]
        : config["MACHINE_MQTT_URL"],
  });
  if (!parsed.success) {
    throw new Error(`Invalid service-api environment: ${parsed.error.message}`);
  }
  return parsed.data;
}
