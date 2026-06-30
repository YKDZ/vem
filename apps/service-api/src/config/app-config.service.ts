import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { ServiceEnv } from "./env.schema";

@Injectable()
export class AppConfigService {
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<ServiceEnv, true>,
  ) {}

  get servicePort(): number {
    return this.config.get("SERVICE_PORT", { infer: true });
  }

  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }

  get jwtSecret(): string {
    return this.config.get("JWT_SECRET", { infer: true });
  }

  get jwtRefreshSecret(): string {
    return this.config.get("JWT_REFRESH_SECRET", { infer: true });
  }

  get jwtAccessTtlSeconds(): number {
    return this.config.get("JWT_ACCESS_TTL_SECONDS", { infer: true });
  }

  get jwtRefreshTtlSeconds(): number {
    return this.config.get("JWT_REFRESH_TTL_SECONDS", { infer: true });
  }

  get machineJwtSecret(): string {
    return this.config.get("MACHINE_JWT_SECRET", { infer: true });
  }

  get machineCredentialEncryptionKey(): string {
    return this.config.get("MACHINE_CREDENTIAL_ENCRYPTION_KEY", {
      infer: true,
    });
  }

  get machineClaimLookupHmacKey(): string {
    return this.config.get("MACHINE_CLAIM_LOOKUP_HMAC_KEY", { infer: true });
  }

  get machineAccessTtlSeconds(): number {
    return this.config.get("MACHINE_ACCESS_TTL_SECONDS", { infer: true });
  }

  get corsOrigins(): string[] {
    return this.config
      .get("CORS_ORIGINS", { infer: true })
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  get mqttUrl(): string {
    return this.config.get("MQTT_URL", { infer: true });
  }

  get mqttUsername(): string | undefined {
    return this.config.get("MQTT_USERNAME", { infer: true });
  }

  get mqttPassword(): string | undefined {
    return this.config.get("MQTT_PASSWORD", { infer: true });
  }

  get mqttSignatureToleranceSeconds(): number {
    return this.config.get("MQTT_SIGNATURE_TOLERANCE_SECONDS", { infer: true });
  }

  get machineCommandTimeoutSeconds(): number {
    return this.config.get("MACHINE_COMMAND_TIMEOUT_SECONDS", { infer: true });
  }

  get machineHeartbeatTimeoutSeconds(): number {
    return this.config.get("MACHINE_HEARTBEAT_TIMEOUT_SECONDS", {
      infer: true,
    });
  }

  get machineClaimCodeTtlSeconds(): number {
    return this.config.get("MACHINE_CLAIM_CODE_TTL_SECONDS", { infer: true });
  }

  get nodeEnv(): ServiceEnv["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }

  get paymentMockEnabled(): boolean {
    return this.config.get("PAYMENT_MOCK_ENABLED", { infer: true });
  }

  get paymentWebhookBaseUrl(): string {
    return this.config.get("PAYMENT_WEBHOOK_BASE_URL", { infer: true });
  }

  get paymentConfigEncryptionKey(): string {
    return this.config.get("PAYMENT_CONFIG_ENCRYPTION_KEY", { infer: true });
  }

  get paymentReconcileIntervalSeconds(): number {
    return this.config.get("PAYMENT_RECONCILE_INTERVAL_SECONDS", {
      infer: true,
    });
  }

  get paymentProductionReadinessRequired(): boolean {
    return this.config.get("PAYMENT_PRODUCTION_READINESS_REQUIRED", {
      infer: true,
    });
  }

  get paymentAlertWindowMinutes(): number {
    return this.config.get("PAYMENT_ALERT_WINDOW_MINUTES", { infer: true });
  }

  get paymentCertificateExpiryWarningDays(): number {
    return this.config.get("PAYMENT_CERTIFICATE_EXPIRY_WARNING_DAYS", {
      infer: true,
    });
  }

  get qweatherApiKey(): string | undefined {
    return this.config.get("QWEATHER_API_KEY", { infer: true });
  }

  get qweatherApiHost(): string | undefined {
    return this.config.get("QWEATHER_API_HOST", { infer: true });
  }

  get qweatherWeatherNowPath(): string {
    return this.config.get("QWEATHER_WEATHER_NOW_PATH", { infer: true });
  }

  get qweatherSunPath(): string {
    return this.config.get("QWEATHER_SUN_PATH", { infer: true });
  }

  get qweatherTimeoutMs(): number {
    return this.config.get("QWEATHER_TIMEOUT_MS", { infer: true });
  }

  buildPaymentNotifyUrl(providerCode: string): string {
    const rawBase = this.paymentWebhookBaseUrl.replace(/\/+$/, "");
    const encodedProviderCode = encodeURIComponent(providerCode);
    if (rawBase.endsWith("/api/payments/webhooks")) {
      return `${rawBase}/${encodedProviderCode}`;
    }
    return `${rawBase}/api/payments/webhooks/${encodedProviderCode}`;
  }

  getPaymentNotifyUrlStaticCheck(providerCode: string) {
    const notifyUrl = this.buildPaymentNotifyUrl(providerCode);
    const parsed = new URL(notifyUrl);
    return {
      providerCode,
      notifyUrl,
      usesHttps: parsed.protocol === "https:",
      isLocalhost: ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname),
      pathMatchesWebhookRoute:
        parsed.pathname === `/api/payments/webhooks/${providerCode}`,
    };
  }

  get bootstrapAdminUsername(): string {
    return this.config.get("BOOTSTRAP_ADMIN_USERNAME", { infer: true });
  }

  get bootstrapAdminPassword(): string {
    return this.config.get("BOOTSTRAP_ADMIN_PASSWORD", { infer: true });
  }
}
