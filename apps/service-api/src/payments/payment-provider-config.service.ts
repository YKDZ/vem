import type {
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
  eq,
  paymentProviderConfigs,
  paymentProviders,
  type DrizzleClient,
} from "@vem/db";

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

export type ProductionPilotPaymentEvidence = {
  providerCode: string;
  method: "qr_code" | "payment_code";
  mode: string | null;
};

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

  private assertRuntimeConfigComplete(
    providerCode: string,
    publicConfigJson: Record<string, unknown>,
    sensitiveConfigJson: Record<string, unknown>,
  ): void {
    if (
      providerCode !== "wechat_pay" ||
      publicConfigJson["paymentCodeEnabled"] !== true
    ) {
      return;
    }

    for (const key of ["apiV2Key", "merchantApiCertPem", "merchantApiKeyPem"]) {
      const value = sensitiveConfigJson[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new ConflictException(`wechat_pay payment_code requires ${key}`);
      }
    }
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
    const publicConfigJson = this.withRuntimePublicConfig(
      selected.providerCode,
      selected.publicConfigJson,
    );
    this.assertRuntimeConfigComplete(
      selected.providerCode,
      publicConfigJson,
      sensitiveConfigJson,
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
    const options: Omit<MachinePaymentOption, "recommended">[] = [];
    const realProviders: Array<{
      providerCode: "alipay" | "wechat_pay";
      icon: "alipay" | "wechat";
      qrDisplayName: string;
      codeDisplayName: string;
    }> = [
      {
        providerCode: "alipay",
        icon: "alipay",
        qrDisplayName: "支付宝扫码",
        codeDisplayName: "支付宝付款码",
      },
      {
        providerCode: "wechat_pay",
        icon: "wechat",
        qrDisplayName: "微信扫码",
        codeDisplayName: "微信付款码",
      },
    ];

    for (const provider of realProviders) {
      try {
        // oxlint-disable-next-line no-await-in-loop
        const config = await this.resolveForPayment({
          providerCode: provider.providerCode,
          machineId,
        });
        options.push({
          optionKey: `qr_code:${provider.providerCode}`,
          providerCode: provider.providerCode,
          method: "qr_code",
          displayName: provider.qrDisplayName,
          description:
            provider.providerCode === "alipay"
              ? "请使用支付宝扫描屏幕二维码"
              : "请使用微信扫描屏幕二维码",
          icon: provider.icon,
          disabled: false,
          disabledReason: null,
        });

        if (config.publicConfigJson["paymentCodeEnabled"] === true) {
          options.push({
            optionKey: `payment_code:${provider.providerCode}`,
            providerCode: provider.providerCode,
            method: "payment_code",
            displayName: provider.codeDisplayName,
            description:
              provider.providerCode === "alipay"
                ? "请出示支付宝付款码并靠近扫码窗口"
                : "请出示微信付款码并靠近扫码窗口",
            icon: provider.icon,
            disabled: false,
            disabledReason: null,
          });
        }
      } catch {
        // provider 未启用、配置缺失、机器级 disabled 都视为不可用。
      }
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

    return {
      options: options.map((option, index) => ({
        ...option,
        recommended: index === 0,
      })),
      defaultOptionKey: options[0]?.optionKey ?? null,
      defaultProviderCode: options[0]?.providerCode ?? null,
      serverTime: new Date().toISOString(),
    };
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
        if (config.publicConfigJson["paymentCodeEnabled"] === true) {
          evidence.push({ providerCode, method: "payment_code", mode });
        }
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
