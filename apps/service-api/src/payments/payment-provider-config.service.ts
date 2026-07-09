import type {
  PaymentChannelKey,
  MachinePaymentOption,
  MachinePaymentOptionsResponse,
} from "@vem/shared";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  paymentChannelPolicies,
  paymentProviderConfigs,
  paymentProviders,
  payments,
  type DrizzleClient,
} from "@vem/db";
import {
  supportedPaymentChannelKeys,
  type MachinePaymentProviderCode,
  type PaymentChannelPolicyResponse,
  type PaymentMethod,
  paymentChannelPolicyResponseSchema,
  type MachinePaymentOptionKey,
} from "@vem/shared";

import { AppConfigService } from "../config/app-config.service";
import { isEncryptedJson } from "../crypto/encrypted-json.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { PaymentConfigSecretService } from "./payment-config-secret.service";

export type RuntimePaymentProviderConfig = {
  id: string;
  providerCode: string;
  providerId: string;
  machineId: string | null;
  merchantNo: string | null;
  appId: string | null;
  publicConfigJson: Record<string, unknown>;
  sensitiveConfigJson: Record<string, unknown>;
};

type PaymentProviderConfigBindingSnapshot = {
  version: 1;
  id: string;
  providerId: string;
  providerCode: string;
  machineId: string | null;
  merchantNo: string | null;
  appId: string | null;
  publicConfigJson: Record<string, unknown>;
  sensitiveConfigEncryptedJson: unknown;
  boundAt: string;
};

export type ProductionPilotPaymentEvidence = {
  providerCode: string;
  method: "qr_code" | "payment_code";
  mode: string | null;
};

export type PaymentChannelProviderReadiness = {
  channelKey: PaymentChannelKey;
  providerCode: "alipay" | "wechat_pay";
  method: "qr_code" | "payment_code";
  ready: boolean;
  missingCredentialKeys: string[];
};

type PaymentChannelPolicyRow = {
  channelKey: string;
  enabled: boolean;
  rank: number;
  isDefault: boolean;
  updatedByAdminUserId: string | null;
  updatedAt: Date;
};

type MachinePaymentOptionMetadata = {
  providerCode: MachinePaymentProviderCode;
  method: PaymentMethod;
  displayName: string;
  description: string;
  icon: MachinePaymentOption["icon"];
};

function recordFromObject(value: object): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    record[key] = Reflect.get(value, key);
  }
  return record;
}

@Injectable()
export class PaymentProviderConfigService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(PaymentConfigSecretService)
    private readonly secrets: PaymentConfigSecretService,
    @Inject(AppConfigService)
    private readonly appConfig: AppConfigService,
  ) {}

  private withRuntimePublicConfig(
    providerCode: string,
    publicConfigJson: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...publicConfigJson,
      notifyUrl: this.appConfig.buildPaymentNotifyUrl(providerCode),
    };
  }

  private toRuntimeConfig(row: {
    id: string;
    providerId: string;
    providerCode: string;
    machineId: string | null;
    merchantNo: string | null;
    appId: string | null;
    publicConfigJson: Record<string, unknown>;
    configEncryptedJson: unknown;
  }): RuntimePaymentProviderConfig {
    const sensitiveConfigJson = isEncryptedJson(row.configEncryptedJson)
      ? this.secrets.decrypt(row.configEncryptedJson)
      : {};
    return {
      id: row.id,
      providerCode: row.providerCode,
      providerId: row.providerId,
      machineId: row.machineId,
      merchantNo: row.merchantNo,
      appId: row.appId,
      publicConfigJson: this.withRuntimePublicConfig(
        row.providerCode,
        row.publicConfigJson,
      ),
      sensitiveConfigJson,
    };
  }

  createBindingSnapshot(
    config: RuntimePaymentProviderConfig,
    boundAt = new Date(),
  ): PaymentProviderConfigBindingSnapshot {
    return {
      version: 1,
      id: config.id,
      providerId: config.providerId,
      providerCode: config.providerCode,
      machineId: config.machineId,
      merchantNo: config.merchantNo,
      appId: config.appId,
      publicConfigJson: this.withRuntimePublicConfig(
        config.providerCode,
        config.publicConfigJson,
      ),
      sensitiveConfigEncryptedJson: this.secrets.encrypt(
        config.sensitiveConfigJson,
      ),
      boundAt: boundAt.toISOString(),
    };
  }

  private toRuntimeConfigFromBindingSnapshot(
    snapshot: unknown,
    providerCode: string,
    providerConfigId: string | null,
  ): RuntimePaymentProviderConfig | null {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return null;
    }
    const record = recordFromObject(snapshot);
    if (record["providerCode"] !== providerCode) return null;
    if (
      providerConfigId &&
      typeof record["id"] === "string" &&
      record["id"] !== providerConfigId
    ) {
      return null;
    }
    const encrypted = record["sensitiveConfigEncryptedJson"];
    if (!isEncryptedJson(encrypted)) return null;
    const publicConfigSnapshot = record["publicConfigJson"];
    const publicConfigJson =
      publicConfigSnapshot &&
      typeof publicConfigSnapshot === "object" &&
      !Array.isArray(publicConfigSnapshot)
        ? recordFromObject(publicConfigSnapshot)
        : {};
    let sensitiveConfigJson: Record<string, unknown>;
    try {
      sensitiveConfigJson = this.secrets.decrypt(encrypted);
    } catch {
      return null;
    }
    return {
      id: typeof record["id"] === "string" ? record["id"] : "",
      providerCode,
      providerId:
        typeof record["providerId"] === "string" ? record["providerId"] : "",
      machineId:
        typeof record["machineId"] === "string" ? record["machineId"] : null,
      merchantNo:
        typeof record["merchantNo"] === "string" ? record["merchantNo"] : null,
      appId: typeof record["appId"] === "string" ? record["appId"] : null,
      publicConfigJson: this.withRuntimePublicConfig(
        providerCode,
        publicConfigJson,
      ),
      sensitiveConfigJson,
    };
  }

  async resolveForPayment(input: {
    providerCode: string;
    machineId: string;
  }): Promise<RuntimePaymentProviderConfig> {
    const rows = await this.db
      .select({
        id: paymentProviderConfigs.id,
        providerId: paymentProviders.id,
        providerCode: paymentProviders.code,
        machineId: paymentProviderConfigs.machineId,
        merchantNo: paymentProviderConfigs.merchantNo,
        appId: paymentProviderConfigs.appId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
        status: paymentProviderConfigs.status,
      })
      .from(paymentProviderConfigs)
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentProviderConfigs.providerId),
      )
      .where(
        and(
          eq(paymentProviders.code, input.providerCode),
          eq(paymentProviders.status, "enabled"),
        ),
      );

    const machineConfig = rows.find((row) => row.machineId === input.machineId);
    if (machineConfig && machineConfig.status !== "enabled") {
      throw new ConflictException(
        "Payment provider is disabled for this machine",
      );
    }
    const selected =
      machineConfig ??
      rows.find((row) => row.machineId === null && row.status === "enabled");
    if (!selected) {
      throw new NotFoundException("Payment provider config not found");
    }

    const configEncryptedJson = selected.configEncryptedJson;
    const sensitiveConfigJson = isEncryptedJson(configEncryptedJson)
      ? this.secrets.decrypt(configEncryptedJson)
      : {};
    const publicConfigJson = this.withRuntimePublicConfig(
      selected.providerCode,
      selected.publicConfigJson,
    );
    return {
      id: selected.id,
      providerCode: selected.providerCode,
      providerId: selected.providerId,
      machineId: selected.machineId,
      merchantNo: selected.merchantNo,
      appId: selected.appId,
      publicConfigJson,
      sensitiveConfigJson,
    };
  }

  async resolveForExistingPayment(input: {
    providerCode: string;
    providerConfigId: string | null;
    machineId: string;
    providerConfigSnapshotJson?: unknown;
  }): Promise<RuntimePaymentProviderConfig> {
    const boundConfig = this.toRuntimeConfigFromBindingSnapshot(
      input.providerConfigSnapshotJson,
      input.providerCode,
      input.providerConfigId,
    );
    if (boundConfig) return boundConfig;

    if (!input.providerConfigId) {
      return await this.resolveForPayment({
        providerCode: input.providerCode,
        machineId: input.machineId,
      });
    }

    const [row] = await this.db
      .select({
        id: paymentProviderConfigs.id,
        providerId: paymentProviders.id,
        providerCode: paymentProviders.code,
        machineId: paymentProviderConfigs.machineId,
        merchantNo: paymentProviderConfigs.merchantNo,
        appId: paymentProviderConfigs.appId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
      })
      .from(paymentProviderConfigs)
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentProviderConfigs.providerId),
      )
      .where(
        and(
          eq(paymentProviderConfigs.id, input.providerConfigId),
          eq(paymentProviders.code, input.providerCode),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Payment provider config not found");
    return this.toRuntimeConfig(row);
  }

  async listCandidateConfigsForProvider(
    providerCode: string,
  ): Promise<RuntimePaymentProviderConfig[]> {
    const rows = await this.db
      .select({
        id: paymentProviderConfigs.id,
        providerId: paymentProviders.id,
        providerCode: paymentProviders.code,
        machineId: paymentProviderConfigs.machineId,
        merchantNo: paymentProviderConfigs.merchantNo,
        appId: paymentProviderConfigs.appId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
        status: paymentProviderConfigs.status,
      })
      .from(paymentProviderConfigs)
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentProviderConfigs.providerId),
      )
      .where(
        and(
          eq(paymentProviders.code, providerCode),
          eq(paymentProviders.status, "enabled"),
          eq(paymentProviderConfigs.status, "enabled"),
        ),
      );

    return rows.map((row) => this.toRuntimeConfig(row));
  }

  async listWebhookCandidateConfigsForProvider(
    providerCode: string,
  ): Promise<RuntimePaymentProviderConfig[]> {
    const currentConfigs =
      await this.listCandidateConfigsForProvider(providerCode);
    const snapshotRows = await this.db
      .select({
        snapshot: payments.providerConfigSnapshotJson,
      })
      .from(payments)
      .innerJoin(paymentProviders, eq(paymentProviders.id, payments.providerId))
      .where(eq(paymentProviders.code, providerCode))
      .orderBy(desc(payments.createdAt))
      .limit(200);

    const configs = [...currentConfigs];
    const seen = new Set(
      currentConfigs.map((config) => `${config.id}:${config.providerCode}`),
    );
    for (const row of snapshotRows) {
      const config = this.toRuntimeConfigFromBindingSnapshot(
        row.snapshot,
        providerCode,
        null,
      );
      if (!config) continue;
      const key = `${config.id}:${config.providerCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      configs.push(config);
    }
    return configs;
  }

  private async isMockOptionAvailable(): Promise<boolean> {
    if (!this.appConfig.paymentMockEnabled) return false;
    const [mockProvider] = await this.db
      .select({ status: paymentProviders.status })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, "mock"))
      .limit(1);
    return mockProvider?.status === "enabled";
  }

  async listMachinePaymentOptionsForMachine(
    machineId: string,
  ): Promise<MachinePaymentOptionsResponse> {
    const policy = await this.getPaymentChannelPolicy();
    const providerReadiness =
      await this.listPaymentChannelProviderReadinessForMachine(machineId);
    const readinessByChannel = new Map(
      providerReadiness.map((readiness) => [readiness.channelKey, readiness]),
    );
    const options: Omit<MachinePaymentOption, "recommended">[] = [];

    for (const channel of policy.channels) {
      if (!channel.enabled) continue;
      const readiness = readinessByChannel.get(channel.channelKey);
      if (!readiness?.ready) continue;
      const metadata = this.machinePaymentOptionMetadata(channel.channelKey);
      if (!metadata) continue;
      options.push({
        optionKey: channel.channelKey as MachinePaymentOptionKey,
        providerCode: metadata.providerCode,
        method: metadata.method,
        displayName: metadata.displayName,
        description: metadata.description,
        icon: metadata.icon,
        disabled: false,
        disabledReason: null,
      });
    }

    // Add mock option if available (dev/test environments)
    const mockAvailable = await this.isMockOptionAvailable();
    if (mockAvailable) {
      options.push({
        optionKey: "mock:mock",
        providerCode: "mock",
        method: "mock",
        displayName: "模拟支付",
        description: "测试环境专用，立即完成支付",
        icon: "mock",
        disabled: false,
        disabledReason: null,
      });
    }

    const defaultOptionKey = options.some(
      (option) => option.optionKey === policy.defaultChannelKey,
    )
      ? policy.defaultChannelKey
      : (options[0]?.optionKey ?? null);
    const defaultProviderCode =
      options.find((option) => option.optionKey === defaultOptionKey)
        ?.providerCode ?? null;

    return {
      options: options.map((option) => ({
        ...option,
        recommended: option.optionKey === defaultOptionKey,
      })),
      defaultOptionKey,
      defaultProviderCode,
      serverTime: new Date().toISOString(),
    };
  }

  async assertMachinePaymentChannelAvailable(input: {
    machineId: string;
    providerCode: "alipay" | "wechat_pay";
    method: "qr_code" | "payment_code";
  }): Promise<void> {
    const optionKey = `${input.method}:${input.providerCode}` as const;
    const projection = await this.listMachinePaymentOptionsForMachine(
      input.machineId,
    );
    const available = projection.options.some(
      (option) => option.optionKey === optionKey && !option.disabled,
    );
    if (!available) {
      throw new ConflictException("Payment channel is not available");
    }
  }

  private async getPaymentChannelPolicy(): Promise<PaymentChannelPolicyResponse> {
    const rows = await this.db
      .select({
        channelKey: paymentChannelPolicies.channelKey,
        enabled: paymentChannelPolicies.enabled,
        rank: paymentChannelPolicies.rank,
        isDefault: paymentChannelPolicies.isDefault,
        updatedByAdminUserId: paymentChannelPolicies.updatedByAdminUserId,
        updatedAt: paymentChannelPolicies.updatedAt,
      })
      .from(paymentChannelPolicies)
      .orderBy(asc(paymentChannelPolicies.rank));

    return this.paymentChannelPolicyRowsToResponse(rows);
  }

  private paymentChannelPolicyRowsToResponse(
    rows: PaymentChannelPolicyRow[],
  ): PaymentChannelPolicyResponse {
    if (rows.length === 0) {
      return paymentChannelPolicyResponseSchema.parse({
        channels: supportedPaymentChannelKeys.map((channelKey, index) => ({
          channelKey,
          enabled: true,
          rank: index + 1,
        })),
        defaultChannelKey: "qr_code:alipay",
        updatedAt: null,
        updatedByAdminUserId: null,
      });
    }

    const orderedRows = [...rows].sort((a, b) => a.rank - b.rank);
    const defaultRow = orderedRows.find((row) => row.isDefault);
    const latestRow = orderedRows.reduce((latest, row) =>
      row.updatedAt > latest.updatedAt ? row : latest,
    );

    return paymentChannelPolicyResponseSchema.parse({
      channels: orderedRows.map((row) => ({
        channelKey: row.channelKey,
        enabled: row.enabled,
        rank: row.rank,
      })),
      defaultChannelKey: defaultRow?.channelKey ?? "qr_code:alipay",
      updatedAt: latestRow.updatedAt.toISOString(),
      updatedByAdminUserId: latestRow.updatedByAdminUserId,
    });
  }

  private machinePaymentOptionMetadata(
    channelKey: PaymentChannelKey,
  ): MachinePaymentOptionMetadata | null {
    switch (channelKey) {
      case "qr_code:alipay":
        return {
          providerCode: "alipay",
          method: "qr_code",
          displayName: "支付宝扫码",
          description: "请使用支付宝扫描屏幕二维码",
          icon: "alipay",
        };
      case "payment_code:alipay":
        return {
          providerCode: "alipay",
          method: "payment_code",
          displayName: "支付宝付款码",
          description: "请出示支付宝付款码",
          icon: "alipay",
        };
      case "qr_code:wechat_pay":
        return {
          providerCode: "wechat_pay",
          method: "qr_code",
          displayName: "微信扫码",
          description: "请使用微信扫描屏幕二维码",
          icon: "wechat",
        };
      case "payment_code:wechat_pay":
        return {
          providerCode: "wechat_pay",
          method: "payment_code",
          displayName: "微信付款码",
          description: "请出示微信付款码",
          icon: "wechat",
        };
      default:
        return null;
    }
  }

  async listPaymentChannelProviderReadinessForMachine(
    machineId: string,
  ): Promise<PaymentChannelProviderReadiness[]> {
    const readiness: PaymentChannelProviderReadiness[] = [];
    for (const providerCode of ["alipay", "wechat_pay"] as const) {
      let config: RuntimePaymentProviderConfig | null = null;
      try {
        // oxlint-disable-next-line no-await-in-loop
        config = await this.resolveForPayment({ providerCode, machineId });
      } catch {
        // Missing or disabled provider config blocks all channels for this provider.
      }

      const missingQrCredentialKeys = config
        ? this.missingProviderCredentialKeys(config, "qr_code")
        : ["providerConfig"];
      readiness.push({
        channelKey: `qr_code:${providerCode}`,
        providerCode,
        method: "qr_code",
        ready: config !== null && missingQrCredentialKeys.length === 0,
        missingCredentialKeys: missingQrCredentialKeys,
      });

      const missingPaymentCodeCredentialKeys = config
        ? this.missingProviderCredentialKeys(config, "payment_code")
        : ["providerConfig"];
      readiness.push({
        channelKey: `payment_code:${providerCode}`,
        providerCode,
        method: "payment_code",
        ready: config !== null && missingPaymentCodeCredentialKeys.length === 0,
        missingCredentialKeys: missingPaymentCodeCredentialKeys,
      });
    }
    return readiness;
  }

  private missingProviderCredentialKeys(
    config: RuntimePaymentProviderConfig,
    method: "qr_code" | "payment_code",
  ): string[] {
    const missing: string[] = [];
    const requireTopLevelString = (
      key: "merchantNo" | "appId",
      value: string | null,
    ) => {
      if (!this.hasNonBlankString(value)) missing.push(key);
    };
    const requirePublicString = (key: string) => {
      if (!this.hasNonBlankString(config.publicConfigJson[key])) {
        missing.push(key);
      }
    };
    const requireSensitiveString = (key: string) => {
      if (!this.hasNonBlankString(config.sensitiveConfigJson[key])) {
        missing.push(key);
      }
    };

    requireTopLevelString("merchantNo", config.merchantNo);
    requireTopLevelString("appId", config.appId);
    requirePublicString("notifyUrl");

    if (config.providerCode === "alipay") {
      requirePublicString("gatewayUrl");
      requirePublicString("keyType");
      requireSensitiveString("privateKeyPem");
      requireSensitiveString("appCertPem");
      requireSensitiveString("alipayPublicCertPem");
      requireSensitiveString("alipayRootCertPem");
      return missing;
    }

    if (config.providerCode === "wechat_pay") {
      if (
        !this.hasNonBlankString(
          config.publicConfigJson["merchantCertificateSerialNo"],
        ) &&
        !this.hasNonBlankString(config.publicConfigJson["certificateSerialNo"])
      ) {
        missing.push("merchantCertificateSerialNo");
      }
      requirePublicString("platformCertificateSerialNo");
      requireSensitiveString("apiV3Key");
      requireSensitiveString("privateKeyPem");
      if (
        !this.hasNonBlankString(
          config.sensitiveConfigJson["platformCertificatePem"],
        ) &&
        !this.hasNonBlankString(
          config.sensitiveConfigJson["platformPublicKeyPem"],
        )
      ) {
        missing.push("platformCertificatePem or platformPublicKeyPem");
      }
      if (method === "payment_code") {
        return [
          ...missing,
          ...this.missingWechatPaymentCodeCredentialKeys(config),
        ];
      }
    }

    return missing;
  }

  private missingWechatPaymentCodeCredentialKeys(
    config: RuntimePaymentProviderConfig,
  ): string[] {
    return ["apiV2Key", "merchantApiCertPem", "merchantApiKeyPem"].filter(
      (key) => !this.hasNonBlankString(config.sensitiveConfigJson[key]),
    );
  }

  private hasNonBlankString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }

  async listProductionPilotPaymentEvidenceForMachine(
    machineId: string,
  ): Promise<ProductionPilotPaymentEvidence[]> {
    const evidence: ProductionPilotPaymentEvidence[] = [];
    for (const providerCode of ["alipay", "wechat_pay"] as const) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        const config = await this.resolveForPayment({
          providerCode,
          machineId,
        });
        const mode = this.productionModeEvidence(
          providerCode,
          config.publicConfigJson,
        );
        evidence.push({ providerCode, method: "qr_code", mode });
      } catch {
        // Unavailable providers are not production pilot payment evidence.
      }
    }
    return evidence;
  }

  private productionModeEvidence(
    providerCode: "alipay" | "wechat_pay",
    publicConfigJson: Record<string, unknown>,
  ): string | null {
    if (providerCode === "alipay") {
      const mode = publicConfigJson["mode"];
      return typeof mode === "string" ? mode : null;
    }
    return "production";
  }
}
