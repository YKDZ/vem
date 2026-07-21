import { describe, expect, it } from "vitest";

import { validateEnv } from "./env.schema";

const baseValidEnv = {
  NODE_ENV: "development",
  SERVICE_PORT: "3000",
  DATABASE_URL: "postgres://vem:pass@localhost:5432/vem",
  JWT_SECRET: "local-access-secret-change-before-production-min32",
  JWT_REFRESH_SECRET: "local-refresh-secret-change-before-production-min32",
  MACHINE_JWT_SECRET: "local-machine-jwt-secret-change-before-production-min32",
  MACHINE_CREDENTIAL_ENCRYPTION_KEY:
    "local-cred-enc-key-change-before-production!",
  MACHINE_CLAIM_LOOKUP_HMAC_KEY:
    "local-claim-lookup-hmac-key-change-before-production",
  CORS_ORIGINS: "http://localhost:5173",
  MQTT_URL: "mqtt://localhost:1883",
  PAYMENT_MOCK_ENABLED: "true",
  PAYMENT_WEBHOOK_BASE_URL: "http://localhost:3000/api/payments/webhooks",
  MACHINE_API_BASE_URL: "http://localhost:3000/api",
  BOOTSTRAP_ADMIN_USERNAME: "admin",
  BOOTSTRAP_ADMIN_PASSWORD: "local-admin-password-12",
};

const productionPaymentConfigEncryptionKey =
  "prod-payment-config-encryption-key-change-me-now";

describe("validateEnv", () => {
  it("accepts valid development config with mock enabled", () => {
    const env = validateEnv(baseValidEnv);
    expect(env.PAYMENT_MOCK_ENABLED).toBe(true);
    expect(env.NODE_ENV).toBe("development");
    expect(env.MACHINE_CLAIM_CODE_TTL_SECONDS).toBe(600);
  });

  it("accepts QWeather credentials and endpoint settings for External Natural Environment", () => {
    const env = validateEnv({
      ...baseValidEnv,
      QWEATHER_API_HOST: "abcxyz.qweatherapi.com",
      QWEATHER_JWT_KEY_ID: "qweather-key-id",
      QWEATHER_JWT_PROJECT_ID: "qweather-project-id",
      QWEATHER_JWT_PRIVATE_KEY_PATH: "docs/qweather/ed25519-private.pem",
      QWEATHER_WEATHER_NOW_PATH: "/v7/weather/now",
      QWEATHER_SUN_PATH: "/v7/astronomy/sun",
      QWEATHER_TIMEOUT_MS: "2500",
    });

    expect(env.QWEATHER_API_HOST).toBe("abcxyz.qweatherapi.com");
    expect(env.QWEATHER_JWT_KEY_ID).toBe("qweather-key-id");
    expect(env.QWEATHER_JWT_PROJECT_ID).toBe("qweather-project-id");
    expect(env.QWEATHER_JWT_PRIVATE_KEY_PATH).toBe(
      "docs/qweather/ed25519-private.pem",
    );
    expect(env.QWEATHER_WEATHER_NOW_PATH).toBe("/v7/weather/now");
    expect(env.QWEATHER_SUN_PATH).toBe("/v7/astronomy/sun");
    expect(env.QWEATHER_TIMEOUT_MS).toBe(2500);
  });

  it("rejects legacy QWeather API key config", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        QWEATHER_API_KEY: "qweather-service-api-key",
      }),
    ).toThrow("QWEATHER_API_KEY is no longer supported");
  });

  it("rejects QWeather JWT config without an account-specific API Host", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        QWEATHER_JWT_KEY_ID: "qweather-key-id",
        QWEATHER_JWT_PROJECT_ID: "qweather-project-id",
        QWEATHER_JWT_PRIVATE_KEY_PATH: "docs/qweather/ed25519-private.pem",
      }),
    ).toThrow("QWEATHER_API_HOST is required when QWeather is configured");
  });

  it("rejects legacy QWeather shared API hosts", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        QWEATHER_API_HOST: "api.qweather.com",
        QWEATHER_JWT_KEY_ID: "qweather-key-id",
        QWEATHER_JWT_PROJECT_ID: "qweather-project-id",
        QWEATHER_JWT_PRIVATE_KEY_PATH: "docs/qweather/ed25519-private.pem",
      }),
    ).toThrow("QWEATHER_API_HOST must be the account-specific API Host");
  });

  it("rejects incomplete QWeather JWT credentials", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        QWEATHER_API_HOST: "abcxyz.qweatherapi.com",
        QWEATHER_JWT_KEY_ID: "qweather-key-id",
        QWEATHER_JWT_PRIVATE_KEY_PATH: "docs/qweather/ed25519-private.pem",
      }),
    ).toThrow("QWEATHER_JWT_PROJECT_ID is required");
  });

  it("rejects production config with PAYMENT_MOCK_ENABLED=true", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "true",
        MACHINE_API_BASE_URL: "https://platform.example.com/api",
        PAYMENT_CONFIG_ENCRYPTION_KEY: productionPaymentConfigEncryptionKey,
        MQTT_USERNAME: "vem_service",
        MQTT_PASSWORD: "strong-password-for-mqtt",
      }),
    ).toThrow("PAYMENT_MOCK_ENABLED must be false in production");
  });

  it("rejects production config missing MQTT credentials", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "false",
        MACHINE_API_BASE_URL: "https://platform.example.com/api",
        PAYMENT_CONFIG_ENCRYPTION_KEY: productionPaymentConfigEncryptionKey,
        // no MQTT_USERNAME or MQTT_PASSWORD
      }),
    ).toThrow("MQTT_USERNAME and MQTT_PASSWORD are required in production");
  });

  it("accepts production config with mock disabled and MQTT creds", () => {
    const env = validateEnv({
      ...baseValidEnv,
      NODE_ENV: "production",
      PAYMENT_MOCK_ENABLED: "false",
      PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
      MACHINE_API_BASE_URL: "https://platform.example.com/api",
      PAYMENT_CONFIG_ENCRYPTION_KEY: productionPaymentConfigEncryptionKey,
      MQTT_USERNAME: "vem_service",
      MQTT_PASSWORD: "strong-password-for-mqtt",
    });
    expect(env.PAYMENT_MOCK_ENABLED).toBe(false);
    expect(env.MQTT_USERNAME).toBe("vem_service");
  });

  it("defaults PAYMENT_MOCK_ENABLED to false", () => {
    const { PAYMENT_MOCK_ENABLED: _, ...withoutMock } = baseValidEnv;
    const env = validateEnv(withoutMock);
    expect(env.PAYMENT_MOCK_ENABLED).toBe(false);
  });

  it("defaults Machine API base URL for local development", () => {
    const { MACHINE_API_BASE_URL: _, ...withoutMachineApiBase } = baseValidEnv;
    const env = validateEnv(withoutMachineApiBase);
    expect(env.MACHINE_API_BASE_URL).toBe("http://localhost:3000/api");
  });

  it("defaults Machine MQTT URL to the Service API broker URL", () => {
    const env = validateEnv(baseValidEnv);
    expect(env.MACHINE_MQTT_URL).toBe("mqtt://localhost:1883");
  });

  it("keeps Machine MQTT URL independent from the Service API broker URL", () => {
    const env = validateEnv({
      ...baseValidEnv,
      MACHINE_MQTT_URL: "mqtt://platform.example.com:18884",
    });
    expect(env.MQTT_URL).toBe("mqtt://localhost:1883");
    expect(env.MACHINE_MQTT_URL).toBe("mqtt://platform.example.com:18884");
  });

  it("keeps Machine API base URL independent from payment webhook base URL", () => {
    const env = validateEnv({
      ...baseValidEnv,
      PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com/webhooks",
      MACHINE_API_BASE_URL: "https://platform.example.com/api",
    });
    expect(env.PAYMENT_WEBHOOK_BASE_URL).toBe(
      "https://pay.example.com/webhooks",
    );
    expect(env.MACHINE_API_BASE_URL).toBe("https://platform.example.com/api");
  });

  it("defaults the machine claim lookup HMAC key outside production", () => {
    const { MACHINE_CLAIM_LOOKUP_HMAC_KEY: _, ...withoutKey } = baseValidEnv;
    const env = validateEnv(withoutKey);
    expect(env.MACHINE_CLAIM_LOOKUP_HMAC_KEY).toBe(
      "dev-machine-claim-lookup-hmac-key-change-me",
    );
  });

  it("rejects production config with the default machine claim lookup HMAC key", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
        MACHINE_API_BASE_URL: "https://platform.example.com/api",
        PAYMENT_CONFIG_ENCRYPTION_KEY: productionPaymentConfigEncryptionKey,
        MQTT_USERNAME: "u",
        MQTT_PASSWORD: "p",
        MACHINE_CLAIM_LOOKUP_HMAC_KEY:
          "dev-machine-claim-lookup-hmac-key-change-me",
      }),
    ).toThrow(
      "MACHINE_CLAIM_LOOKUP_HMAC_KEY must be set explicitly in production",
    );
  });

  it("rejects production config with the default payment config encryption key", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
        MACHINE_API_BASE_URL: "https://platform.example.com/api",
        MQTT_USERNAME: "u",
        MQTT_PASSWORD: "p",
        PAYMENT_CONFIG_ENCRYPTION_KEY:
          "dev-payment-config-encryption-key-change-me",
      }),
    ).toThrow(
      "PAYMENT_CONFIG_ENCRYPTION_KEY must be set explicitly in production",
    );
  });

  it("derives provider notify url when PAYMENT_WEBHOOK_BASE_URL is webhook prefix", () => {
    const env = validateEnv(baseValidEnv);
    expect(env.PAYMENT_WEBHOOK_BASE_URL).toBe(
      "http://localhost:3000/api/payments/webhooks",
    );
  });

  it("accepts PAYMENT_WEBHOOK_BASE_URL as service origin for deployments", () => {
    const env = validateEnv({
      ...baseValidEnv,
      PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
    });
    expect(env.PAYMENT_WEBHOOK_BASE_URL).toBe("https://pay.example.com");
  });

  it("rejects production config with http webhook base URL", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_WEBHOOK_BASE_URL: "http://pay.example.com",
        MACHINE_API_BASE_URL: "https://platform.example.com/api",
        PAYMENT_CONFIG_ENCRYPTION_KEY: productionPaymentConfigEncryptionKey,
        MQTT_USERNAME: "u",
        MQTT_PASSWORD: "p",
      }),
    ).toThrow("PAYMENT_WEBHOOK_BASE_URL must use https in production");
  });

  it("accepts production config with an HTTPS webhook", () => {
    const env = validateEnv({
      ...baseValidEnv,
      NODE_ENV: "production",
      PAYMENT_MOCK_ENABLED: "false",
      PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
      MACHINE_API_BASE_URL: "https://platform.example.com/api",
      PAYMENT_CONFIG_ENCRYPTION_KEY: productionPaymentConfigEncryptionKey,
      MQTT_USERNAME: "u",
      MQTT_PASSWORD: "p",
    });
    expect(env.NODE_ENV).toBe("production");
  });
});
