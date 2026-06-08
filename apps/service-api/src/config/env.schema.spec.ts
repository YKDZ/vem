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
  BOOTSTRAP_ADMIN_USERNAME: "admin",
  BOOTSTRAP_ADMIN_PASSWORD: "local-admin-password-12",
};

describe("validateEnv", () => {
  it("accepts valid development config with mock enabled", () => {
    const env = validateEnv(baseValidEnv);
    expect(env.PAYMENT_MOCK_ENABLED).toBe(true);
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects production config with PAYMENT_MOCK_ENABLED=true", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "true",
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
        // no MQTT_USERNAME or MQTT_PASSWORD
      }),
    ).toThrow("MQTT_USERNAME and MQTT_PASSWORD are required in production");
  });

  it("accepts production config with mock disabled and MQTT creds", () => {
    const env = validateEnv({
      ...baseValidEnv,
      NODE_ENV: "production",
      PAYMENT_MOCK_ENABLED: "false",
      PAYMENT_PRODUCTION_READINESS_REQUIRED: "true",
      PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
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
        PAYMENT_PRODUCTION_READINESS_REQUIRED: "true",
        PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
        MQTT_USERNAME: "u",
        MQTT_PASSWORD: "p",
        MACHINE_CLAIM_LOOKUP_HMAC_KEY:
          "dev-machine-claim-lookup-hmac-key-change-me",
      }),
    ).toThrow(
      "MACHINE_CLAIM_LOOKUP_HMAC_KEY must be set explicitly in production",
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

  it("rejects production config without PAYMENT_PRODUCTION_READINESS_REQUIRED=true", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PRODUCTION_READINESS_REQUIRED: "false",
        PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
        MQTT_USERNAME: "u",
        MQTT_PASSWORD: "p",
      }),
    ).toThrow(
      "PAYMENT_PRODUCTION_READINESS_REQUIRED must be true in production",
    );
  });

  it("rejects production config with http webhook base URL", () => {
    expect(() =>
      validateEnv({
        ...baseValidEnv,
        NODE_ENV: "production",
        PAYMENT_MOCK_ENABLED: "false",
        PAYMENT_PRODUCTION_READINESS_REQUIRED: "true",
        PAYMENT_WEBHOOK_BASE_URL: "http://pay.example.com",
        MQTT_USERNAME: "u",
        MQTT_PASSWORD: "p",
      }),
    ).toThrow("PAYMENT_WEBHOOK_BASE_URL must use https in production");
  });

  it("accepts production config with https webhook and readiness required=true", () => {
    const env = validateEnv({
      ...baseValidEnv,
      NODE_ENV: "production",
      PAYMENT_MOCK_ENABLED: "false",
      PAYMENT_PRODUCTION_READINESS_REQUIRED: "true",
      PAYMENT_WEBHOOK_BASE_URL: "https://pay.example.com",
      MQTT_USERNAME: "u",
      MQTT_PASSWORD: "p",
    });
    expect(env.PAYMENT_PRODUCTION_READINESS_REQUIRED).toBe(true);
    expect(env.NODE_ENV).toBe("production");
  });
});
