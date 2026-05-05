import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { ServiceEnv } from "./env.schema";

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<ServiceEnv, true>) {}

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

  get machineSharedSecret(): string {
    return this.config.get("MACHINE_SHARED_SECRET", { infer: true });
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

  get paymentMockEnabled(): boolean {
    return this.config.get("PAYMENT_MOCK_ENABLED", { infer: true });
  }

  get paymentWebhookBaseUrl(): string {
    return this.config.get("PAYMENT_WEBHOOK_BASE_URL", { infer: true });
  }

  get bootstrapAdminUsername(): string {
    return this.config.get("BOOTSTRAP_ADMIN_USERNAME", { infer: true });
  }

  get bootstrapAdminPassword(): string {
    return this.config.get("BOOTSTRAP_ADMIN_PASSWORD", { infer: true });
  }
}
