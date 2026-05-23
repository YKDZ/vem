import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  eq,
  paymentProviderConfigs,
  paymentProviders,
  type DrizzleClient,
} from "@vem/db";
import type {
  MachinePaymentOption,
  MachinePaymentOptionsResponse,
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

@Injectable()
export class PaymentProviderConfigService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly secrets: PaymentConfigSecretService,
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

    return {
      id: selected.id,
      providerCode: selected.providerCode,
      providerId: selected.providerId,
      machineId: selected.machineId,
      merchantNo: selected.merchantNo,
      appId: selected.appId,
      publicConfigJson: this.withRuntimePublicConfig(
        selected.providerCode,
        selected.publicConfigJson,
      ),
      sensitiveConfigJson,
    };
  }

  async resolveForExistingPayment(input: {
    providerCode: string;
    providerConfigId: string | null;
    machineId: string;
  }): Promise<RuntimePaymentProviderConfig> {
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
    const candidates: Omit<MachinePaymentOption, "recommended">[] = [
      {
        providerCode: "alipay",
        method: "qr_code",
        displayName: "支付宝",
        description: "请使用支付宝扫码支付",
        icon: "alipay",
      },
      {
        providerCode: "wechat_pay",
        method: "qr_code",
        displayName: "微信支付",
        description: "请使用微信扫码支付",
        icon: "wechat",
      },
    ];

    const options: Omit<MachinePaymentOption, "recommended">[] = [];
    for (const candidate of candidates) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        await this.resolveForPayment({
          providerCode: candidate.providerCode,
          machineId,
        });
        options.push(candidate);
      } catch {
        // provider 未启用、配置缺失、机器级 disabled 都视为不可用。
      }
    }

    // Add mock option if available (dev/test environments)
    const mockAvailable = await this.isMockOptionAvailable();
    if (mockAvailable) {
      options.push({
        providerCode: "mock",
        method: "mock",
        displayName: "模拟支付",
        description: "测试环境专用，立即完成支付",
        icon: "mock",
      });
    }

    return {
      options: options.map((option, index) => ({
        ...option,
        recommended: index === 0,
      })),
      defaultProviderCode: options[0]?.providerCode ?? null,
      serverTime: new Date().toISOString(),
    };
  }
}
