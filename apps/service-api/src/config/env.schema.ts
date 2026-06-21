import { z } from "zod";

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
  MACHINE_CLAIM_CODE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(600),
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
});

export type ServiceEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): ServiceEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid service-api environment: ${parsed.error.message}`);
  }
  return parsed.data;
}
