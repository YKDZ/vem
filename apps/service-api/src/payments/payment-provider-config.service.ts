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
  ) {}

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
      publicConfigJson: selected.publicConfigJson,
      sensitiveConfigJson,
    };
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

    return rows.map((row) => {
      const configEncryptedJson = row.configEncryptedJson;
      const sensitiveConfigJson = isEncryptedJson(configEncryptedJson)
        ? this.secrets.decrypt(configEncryptedJson)
        : {};
      return {
        id: row.id,
        providerCode: row.providerCode,
        providerId: row.providerId,
        machineId: row.machineId,
        merchantNo: row.merchantNo,
        appId: row.appId,
        publicConfigJson: row.publicConfigJson,
        sensitiveConfigJson,
      };
    });
  }
}
