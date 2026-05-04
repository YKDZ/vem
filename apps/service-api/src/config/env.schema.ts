import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(604800),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  MQTT_URL: z.url(),
  PAYMENT_MOCK_ENABLED: z
    .preprocess((value) => {
      if (typeof value === "string") {
        const normalized = value.toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) return true;
        if (["false", "0", "no", "off"].includes(normalized)) return false;
      }
      return value;
    }, z.boolean())
    .default(true),
  PAYMENT_WEBHOOK_BASE_URL: z.url(),
  BOOTSTRAP_ADMIN_USERNAME: z.string().min(3).max(64).default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).max(128),
});

export type ServiceEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): ServiceEnv {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid service-api environment: ${parsed.error.message}`);
  }
  return parsed.data;
}
