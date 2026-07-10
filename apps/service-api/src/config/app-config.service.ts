import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

import type { ServiceEnv } from "./env.schema";

import {
  parseGithubOidcJwks,
  parseGithubOidcTrustPolicy,
  type GithubOidcTrustPolicy,
} from "../maintenance-access/github-actions-oidc";
import {
  parseMaintenanceAddressPools,
  type MaintenanceAddressPools,
} from "../maintenance-access/maintenance-address-pools";
import { parseMaintenanceSshTargetPolicy } from "../maintenance-access/maintenance-ssh-target-policy";

@Injectable()
export class AppConfigService {
  private readonly parsedMaintenanceAddressPools: MaintenanceAddressPools;

  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<ServiceEnv, true>,
  ) {
    this.parsedMaintenanceAddressPools = parseMaintenanceAddressPools({
      relay: this.config.get("MAINTENANCE_RELAY_ADDRESS_POOL", {
        infer: true,
      }),
      runner: this.config.get("MAINTENANCE_RUNNER_ADDRESS_POOL", {
        infer: true,
      }),
      maintainer: this.config.get("MAINTENANCE_MAINTAINER_ADDRESS_POOL", {
        infer: true,
      }),
      machine: this.config.get("MAINTENANCE_MACHINE_ADDRESS_POOL", {
        infer: true,
      }),
    });
  }

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

  get machineProvisioningProfile(): "production" | "testbed" {
    return this.config.get("MACHINE_PROVISIONING_PROFILE", { infer: true });
  }

  get maintenanceAddressPools(): MaintenanceAddressPools {
    return this.parsedMaintenanceAddressPools;
  }

  get maintenanceRelayPeerId(): string {
    return this.config.get("MAINTENANCE_RELAY_PEER_ID", { infer: true });
  }

  get maintenanceRelayEndpoint(): string {
    return this.config.get("MAINTENANCE_RELAY_ENDPOINT", { infer: true });
  }

  get maintenanceRelayPublicKey(): string {
    return this.config.get("MAINTENANCE_RELAY_PUBLIC_KEY", { infer: true });
  }

  get maintenanceRelayTunnelAddress(): string {
    return this.config.get("MAINTENANCE_RELAY_TUNNEL_ADDRESS", { infer: true });
  }

  get maintenanceRelayCredential(): string {
    return this.config.get("MAINTENANCE_RELAY_CREDENTIAL", { infer: true });
  }

  get maintenanceRelayJwtSecret(): string {
    return this.config.get("MAINTENANCE_RELAY_JWT_SECRET", { infer: true });
  }

  get maintenanceRelayTokenTtlSeconds(): number {
    return this.config.get("MAINTENANCE_RELAY_TOKEN_TTL_SECONDS", {
      infer: true,
    });
  }

  get githubOidcTrustPolicy(): GithubOidcTrustPolicy {
    const path = this.config.get("MAINTENANCE_GITHUB_OIDC_TRUST_POLICY_PATH", {
      infer: true,
    });
    if (!path) throw new Error("GitHub OIDC trust policy is not configured");
    return parseGithubOidcTrustPolicy(readDeploymentFile(path));
  }

  get githubOidcJwks(): unknown {
    const path = this.config.get("MAINTENANCE_GITHUB_OIDC_JWKS_PATH", {
      infer: true,
    });
    return path ? parseGithubOidcJwks(readDeploymentFile(path)) : undefined;
  }

  get maintenanceAutomationJwtSecret(): string {
    const path = this.config.get("MAINTENANCE_AUTOMATION_JWT_SECRET_PATH", {
      infer: true,
    });
    if (!path) {
      throw new Error(
        "MAINTENANCE_AUTOMATION_JWT_SECRET_PATH is required for automation exchange",
      );
    }
    const secret = readDeploymentFile(path).trim();
    if (secret.length < 32) {
      throw new Error("Maintenance automation JWT secret is too short");
    }
    return secret;
  }

  get maintenanceSshCa(): {
    caPrivateKeyPath: string;
    expectedCaFingerprint: string;
    profile: "testbed" | "production";
    requireReadOnlyMount: boolean;
    allowedTargetMachineCodes: string[];
  } {
    const caPrivateKeyPath = this.config.get(
      "MAINTENANCE_SSH_CA_PRIVATE_KEY_PATH",
      { infer: true },
    );
    const expectedCaFingerprint = this.config.get(
      "MAINTENANCE_SSH_CA_PUBLIC_KEY_FINGERPRINT",
      { infer: true },
    );
    const profile = this.config.get("MAINTENANCE_SSH_PROFILE", {
      infer: true,
    });
    const targetPolicyPath = this.config.get(
      "MAINTENANCE_SSH_TARGET_POLICY_PATH",
      { infer: true },
    );
    if (
      !caPrivateKeyPath ||
      !expectedCaFingerprint ||
      !profile ||
      !targetPolicyPath
    ) {
      throw new Error("Maintenance SSH CA is not configured");
    }
    const targetPolicy = parseMaintenanceSshTargetPolicy(
      readDeploymentFile(targetPolicyPath),
    );
    if (targetPolicy.profile !== profile) {
      throw new Error(
        "Maintenance SSH target policy profile does not match the configured CA profile",
      );
    }
    return {
      caPrivateKeyPath,
      expectedCaFingerprint,
      profile,
      requireReadOnlyMount: this.nodeEnv === "production",
      allowedTargetMachineCodes: targetPolicy.targetMachineCodes,
    };
  }

  get maintenanceSshCaConfigured(): boolean {
    const path = this.config.get<string>("MAINTENANCE_SSH_CA_PRIVATE_KEY_PATH");
    return typeof path === "string" && path.length > 0;
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

  get machineApiBaseUrl(): string {
    return this.config
      .get("MACHINE_API_BASE_URL", { infer: true })
      .replace(/\/+$/, "");
  }

  get mediaAssetStorageRoot(): string {
    return this.config.get("MEDIA_ASSET_STORAGE_ROOT", { infer: true });
  }

  get mediaAssetPublicBaseUrl(): string | undefined {
    return this.config.get("MEDIA_ASSET_PUBLIC_BASE_URL", { infer: true });
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

  get qweatherApiHost(): string | undefined {
    return this.config.get("QWEATHER_API_HOST", { infer: true });
  }

  get qweatherJwtKeyId(): string | undefined {
    return this.config.get("QWEATHER_JWT_KEY_ID", { infer: true });
  }

  get qweatherJwtProjectId(): string | undefined {
    return this.config.get("QWEATHER_JWT_PROJECT_ID", { infer: true });
  }

  get qweatherJwtPrivateKey(): string | undefined {
    return this.config.get("QWEATHER_JWT_PRIVATE_KEY", { infer: true });
  }

  get qweatherJwtPrivateKeyPath(): string | undefined {
    return this.config.get("QWEATHER_JWT_PRIVATE_KEY_PATH", { infer: true });
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

function readDeploymentFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`Deployment configuration path is not a file: ${path}`);
    }
    if ((stat.mode & 0o222) !== 0) {
      throw new Error(
        `Deployment configuration file must be read-only: ${path}`,
      );
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
