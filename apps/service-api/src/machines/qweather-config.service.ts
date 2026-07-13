import { Inject, Injectable } from "@nestjs/common";
import { eq, qweatherConfigs, type DrizzleClient } from "@vem/db";
import {
  qweatherConfigResponseSchema,
  type QweatherConfigResponse,
  type UpdateQweatherConfigInput,
} from "@vem/shared";

import { AuditService } from "../audit/audit.service";
import { AppConfigService } from "../config/app-config.service";
import {
  decryptJson,
  encryptJson,
  isEncryptedJson,
} from "../crypto/encrypted-json.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";

export type QweatherRuntimeConfig = {
  apiHost?: string;
  jwtKeyId?: string;
  jwtProjectId?: string;
  jwtPrivateKey?: string;
  jwtPrivateKeyPath?: string;
  weatherNowPath: string;
  sunPath: string;
  timeoutMs: number;
};

type QweatherConfigRow = typeof qweatherConfigs.$inferSelect;

@Injectable()
export class QweatherConfigService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(AppConfigService) private readonly environment: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  async getAdminConfig(): Promise<QweatherConfigResponse> {
    const row = await this.findRow();
    if (row) {
      return qweatherConfigResponseSchema.parse({
        source: "database",
        enabled: row.enabled,
        apiHost: row.apiHost,
        jwtKeyId: row.jwtKeyId,
        jwtProjectId: row.jwtProjectId,
        privateKeyConfigured:
          isEncryptedJson(row.privateKeyEncryptedJson) ||
          this.environmentPrivateKeyConfigured(),
        weatherNowPath: row.weatherNowPath,
        sunPath: row.sunPath,
        timeoutMs: row.timeoutMs,
        updatedAt: row.updatedAt.toISOString(),
      });
    }

    const configured = Boolean(
      this.environment.qweatherApiHost &&
      this.environment.qweatherJwtKeyId &&
      this.environment.qweatherJwtProjectId &&
      this.environmentPrivateKeyConfigured(),
    );
    return qweatherConfigResponseSchema.parse({
      source: configured ? "environment" : "unconfigured",
      enabled: configured,
      apiHost: this.environment.qweatherApiHost ?? "",
      jwtKeyId: this.environment.qweatherJwtKeyId ?? "",
      jwtProjectId: this.environment.qweatherJwtProjectId ?? "",
      privateKeyConfigured: this.environmentPrivateKeyConfigured(),
      weatherNowPath: this.environment.qweatherWeatherNowPath,
      sunPath: this.environment.qweatherSunPath,
      timeoutMs: this.environment.qweatherTimeoutMs,
      updatedAt: null,
    });
  }

  async update(
    adminUserId: string,
    input: UpdateQweatherConfigInput,
  ): Promise<QweatherConfigResponse> {
    const existing = await this.findRow();
    const privateKeyEncryptedJson = input.privateKey
      ? encryptJson(
          { privateKey: input.privateKey },
          this.environment.paymentConfigEncryptionKey,
        )
      : (existing?.privateKeyEncryptedJson ?? null);

    const [saved] = await this.db
      .insert(qweatherConfigs)
      .values({
        providerCode: "qweather",
        enabled: input.enabled,
        apiHost: input.apiHost,
        jwtKeyId: input.jwtKeyId,
        jwtProjectId: input.jwtProjectId,
        privateKeyEncryptedJson,
        weatherNowPath: input.weatherNowPath,
        sunPath: input.sunPath,
        timeoutMs: input.timeoutMs,
        updatedByAdminUserId: adminUserId,
      })
      .onConflictDoUpdate({
        target: qweatherConfigs.providerCode,
        set: {
          enabled: input.enabled,
          apiHost: input.apiHost,
          jwtKeyId: input.jwtKeyId,
          jwtProjectId: input.jwtProjectId,
          privateKeyEncryptedJson,
          weatherNowPath: input.weatherNowPath,
          sunPath: input.sunPath,
          timeoutMs: input.timeoutMs,
          updatedByAdminUserId: adminUserId,
          updatedAt: new Date(),
        },
      })
      .returning({ id: qweatherConfigs.id });

    await this.audit.record({
      adminUserId,
      action: existing ? "qweather.config.update" : "qweather.config.create",
      resourceType: "qweather_config",
      resourceId: saved.id,
      beforeJson: existing ? this.auditSnapshot(existing) : undefined,
      afterJson: {
        enabled: input.enabled,
        apiHost: input.apiHost,
        jwtKeyId: input.jwtKeyId,
        jwtProjectId: input.jwtProjectId,
        privateKeyConfigured:
          isEncryptedJson(privateKeyEncryptedJson) ||
          this.environmentPrivateKeyConfigured(),
        weatherNowPath: input.weatherNowPath,
        sunPath: input.sunPath,
        timeoutMs: input.timeoutMs,
      },
    });
    return await this.getAdminConfig();
  }

  async resolveRuntimeConfig(): Promise<QweatherRuntimeConfig> {
    const row = await this.findRow();
    if (!row) return this.environmentRuntimeConfig();
    if (!row.enabled) {
      return {
        weatherNowPath: row.weatherNowPath,
        sunPath: row.sunPath,
        timeoutMs: row.timeoutMs,
      };
    }

    let jwtPrivateKey: string | undefined;
    if (isEncryptedJson(row.privateKeyEncryptedJson)) {
      const decrypted = decryptJson(
        row.privateKeyEncryptedJson,
        this.environment.paymentConfigEncryptionKey,
      );
      if (typeof decrypted.privateKey === "string") {
        jwtPrivateKey = decrypted.privateKey;
      }
    }
    return {
      apiHost: row.apiHost,
      jwtKeyId: row.jwtKeyId,
      jwtProjectId: row.jwtProjectId,
      jwtPrivateKey: jwtPrivateKey ?? this.environment.qweatherJwtPrivateKey,
      jwtPrivateKeyPath: jwtPrivateKey
        ? undefined
        : this.environment.qweatherJwtPrivateKeyPath,
      weatherNowPath: row.weatherNowPath,
      sunPath: row.sunPath,
      timeoutMs: row.timeoutMs,
    };
  }

  private async findRow(): Promise<QweatherConfigRow | undefined> {
    const [row] = await this.db
      .select()
      .from(qweatherConfigs)
      .where(eq(qweatherConfigs.providerCode, "qweather"))
      .limit(1);
    return row;
  }

  private environmentPrivateKeyConfigured(): boolean {
    return Boolean(
      this.environment.qweatherJwtPrivateKey ||
      this.environment.qweatherJwtPrivateKeyPath,
    );
  }

  private environmentRuntimeConfig(): QweatherRuntimeConfig {
    return {
      apiHost: this.environment.qweatherApiHost,
      jwtKeyId: this.environment.qweatherJwtKeyId,
      jwtProjectId: this.environment.qweatherJwtProjectId,
      jwtPrivateKey: this.environment.qweatherJwtPrivateKey,
      jwtPrivateKeyPath: this.environment.qweatherJwtPrivateKeyPath,
      weatherNowPath: this.environment.qweatherWeatherNowPath,
      sunPath: this.environment.qweatherSunPath,
      timeoutMs: this.environment.qweatherTimeoutMs,
    };
  }

  private auditSnapshot(row: QweatherConfigRow) {
    return {
      enabled: row.enabled,
      apiHost: row.apiHost,
      jwtKeyId: row.jwtKeyId,
      jwtProjectId: row.jwtProjectId,
      privateKeyConfigured: isEncryptedJson(row.privateKeyEncryptedJson),
      weatherNowPath: row.weatherNowPath,
      sunPath: row.sunPath,
      timeoutMs: row.timeoutMs,
    };
  }
}
