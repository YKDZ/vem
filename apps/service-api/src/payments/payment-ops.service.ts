import type {
  MachinePaymentOption,
  PaymentChannelKey,
  PaymentMachinePreflight,
  PaymentOpsCheck,
  PaymentOpsMetrics,
  PaymentOpsReadiness,
} from "@vem/shared";

import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  machineHeartbeats,
  machines,
  paymentCodeAttempts,
  paymentEvents,
  paymentProviderConfigs,
  paymentProviders,
  paymentReconciliationAttempts,
  paymentWebhookAttempts,
  payments,
  refunds,
  sql,
  type DrizzleClient,
} from "@vem/db";
import { alipayEffectiveEnvironmentSchema } from "@vem/shared";

import { AppConfigService } from "../config/app-config.service";
import { isEncryptedJson } from "../crypto/encrypted-json.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { PaymentChannelPolicyService } from "./payment-channel-policy.service";
import { PaymentConfigSecretService } from "./payment-config-secret.service";
import {
  PaymentProviderConfigService,
  type PaymentChannelProviderReadiness,
} from "./payment-provider-config.service";

type LatestMachineHeartbeat = {
  reportedAt: Date;
  receivedAt: Date;
  statusPayloadJson: unknown;
} | null;

type MachinePreflightRecord = {
  id: string;
  code: string;
  status: "online" | "offline" | "maintenance" | "disabled";
  lastSeenAt: Date | null;
};

type ProviderConfigInspection = {
  providerCode: string;
  providerStatus: string;
  configStatus: string;
  machineId: string | null;
  merchantNo: string | null;
  appId: string | null;
  publicConfig: Record<string, unknown>;
  sensitiveConfig: Record<string, unknown> | null;
};

type EnabledChannelProviderSetup = {
  channelKey: PaymentChannelKey;
  providerCode: "alipay" | "wechat_pay";
  method: "qr_code" | "payment_code";
  ready: boolean;
  missingCredentialKeys: string[];
  environments: Array<"sandbox" | "production">;
};

function readHeartbeatStringField(
  heartbeat: LatestMachineHeartbeat,
  field: string,
): string | null {
  const payload = heartbeat?.statusPayloadJson;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value: unknown = Reflect.get(payload, field);
  return typeof value === "string" ? value : null;
}

function readHeartbeatRecordField(
  heartbeat: LatestMachineHeartbeat,
  field: string,
): Record<string, unknown> | null {
  const payload = heartbeat?.statusPayloadJson;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const value: unknown = Reflect.get(payload, field);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function readStringFromRecord(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === "string" ? value : null;
}

function readBooleanFromRecord(
  record: Record<string, unknown> | null,
  field: string,
): boolean | null {
  const value = record?.[field];
  return typeof value === "boolean" ? value : null;
}

function isPaymentCodeScannerReady(heartbeat: LatestMachineHeartbeat): boolean {
  const scannerHealth = readHeartbeatRecordField(heartbeat, "scannerHealth");
  const status = readStringFromRecord(scannerHealth, "status");
  const online = readBooleanFromRecord(scannerHealth, "online");
  return status === "ready" || status === "online" || online === true;
}

function parsePaymentChannelKey(
  channelKey: PaymentChannelKey,
): ["qr_code" | "payment_code", "alipay" | "wechat_pay"] {
  if (channelKey === "qr_code:alipay") return ["qr_code", "alipay"];
  if (channelKey === "payment_code:alipay") {
    return ["payment_code", "alipay"];
  }
  if (channelKey === "qr_code:wechat_pay") return ["qr_code", "wechat_pay"];
  return ["payment_code", "wechat_pay"];
}

function hasNonEmptyString(
  source: Record<string, unknown>,
  key: string,
): boolean {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0;
}

function withRecommendedPaymentOptions(
  options: MachinePaymentOption[],
): MachinePaymentOption[] {
  return options.map((item, index) => ({ ...item, recommended: index === 0 }));
}

@Injectable()
export class PaymentOpsService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(AppConfigService)
    private readonly config: AppConfigService,
    @Inject(PaymentConfigSecretService)
    private readonly paymentConfigSecrets: PaymentConfigSecretService,
    @Inject(PaymentProviderConfigService)
    private readonly providerConfigs: PaymentProviderConfigService,
    @Inject(PaymentChannelPolicyService)
    private readonly channelPolicies: PaymentChannelPolicyService,
  ) {}

  async getReadiness(): Promise<PaymentOpsReadiness> {
    const channelPolicy = await this.channelPolicies.getPolicy();
    const enabledChannelKeys = channelPolicy.channels
      .filter((channel) => channel.enabled)
      .map((channel) => channel.channelKey);
    const checks: PaymentOpsCheck[] = [
      await this.checkMockProviderDisabled(),
      this.checkEnabledPaymentChannels(enabledChannelKeys),
      ...(await this.checkRealProviderConfigsPresent(enabledChannelKeys)),
      await this.checkMachineRealProviderOptionsAvailable(),
      await this.checkNotifyUrls(enabledChannelKeys),
      await this.checkCertificates(enabledChannelKeys),
      await this.checkRecentPaymentFailures(),
      await this.checkRecentWebhookFailures(),
      await this.checkRecentReconciliationFailures(),
      await this.checkRefundBacklog(),
    ];
    const criticalFailed = checks.some(
      (check) => check.severity === "critical" && !check.passed,
    );
    const environmentCheck = checks.find(
      (check) => check.code === "provider_environment.production_ready",
    );
    const sandboxProviders = Array.isArray(
      environmentCheck?.evidence["sandboxProviders"],
    )
      ? environmentCheck.evidence["sandboxProviders"]
      : [];
    const productionProviders = Array.isArray(
      environmentCheck?.evidence["productionProviders"],
    )
      ? environmentCheck.evidence["productionProviders"]
      : [];
    const hasSandboxProvider = sandboxProviders.length > 0;
    const hasProductionProvider = productionProviders.length > 0;
    const providerEnvironment =
      hasSandboxProvider && hasProductionProvider
        ? "mixed"
        : hasSandboxProvider
          ? "sandbox"
          : hasProductionProvider
            ? "production"
            : "unavailable";
    return {
      status: criticalFailed ? "blocked" : "ready",
      checkedAt: new Date().toISOString(),
      environment: this.config.nodeEnv,
      providerEnvironment: {
        environment: providerEnvironment,
        readiness:
          providerEnvironment === "sandbox" ||
          providerEnvironment === "production"
            ? "ready"
            : "blocked",
        errorCategory:
          providerEnvironment === "mixed"
            ? "mixed_environment"
            : providerEnvironment === "unavailable"
              ? "provider_unconfigured"
              : "none",
      },
      checks,
    };
  }

  async getMetrics(
    windowMinutes = this.config.paymentAlertWindowMinutes,
  ): Promise<PaymentOpsMetrics> {
    const measuredAt = new Date();
    const from = new Date(measuredAt.getTime() - windowMinutes * 60_000);

    const [paymentTotals] = await this.db
      .select({
        total: count(),
        failed: sql<number>`count(*) filter (where ${payments.status} = 'failed')`,
      })
      .from(payments)
      .where(sql`${payments.createdAt} >= ${from}`);

    const [webhookTotals] = await this.db
      .select({
        signatureInvalid: sql<number>`count(*) filter (where ${paymentWebhookAttempts.signatureValid} = false)`,
        businessInvalid: sql<number>`count(*) filter (where ${paymentWebhookAttempts.businessValid} = false)`,
      })
      .from(paymentWebhookAttempts)
      .where(sql`${paymentWebhookAttempts.createdAt} >= ${from}`);

    const [reconcileTotals] = await this.db
      .select({ total: count() })
      .from(paymentReconciliationAttempts)
      .innerJoin(
        payments,
        eq(payments.id, paymentReconciliationAttempts.paymentId),
      )
      .where(
        and(
          sql`${paymentReconciliationAttempts.createdAt} >= ${from}`,
          sql`${paymentReconciliationAttempts.status} in ('network_error', 'config_error', 'max_attempts_exceeded')`,
        ),
      );

    const [refundTotals] = await this.db
      .select({
        failed: sql<number>`count(*) filter (where ${refunds.status} = 'failed')`,
        overdue: sql<number>`count(*) filter (where ${refunds.status} = 'processing' and ${refunds.updatedAt} < ${new Date(measuredAt.getTime() - 30 * 60_000)})`,
      })
      .from(refunds)
      .where(sql`${refunds.createdAt} >= ${from}`);

    const [paymentCodeTotals] = await this.db
      .select({
        unknown: sql<number>`count(*) filter (where ${paymentCodeAttempts.status} in ('unknown', 'manual_handling'))`,
        reverseFailed: sql<number>`count(*) filter (where ${paymentCodeAttempts.status} = 'manual_handling' or ${paymentCodeAttempts.failureCode} like '%REVERSE%')`,
      })
      .from(paymentCodeAttempts)
      .innerJoin(payments, eq(payments.id, paymentCodeAttempts.paymentId))
      .where(and(sql`${paymentCodeAttempts.createdAt} >= ${from}`));

    const [paymentCodeDuplicateRejected] = await this.db
      .select({ total: count() })
      .from(paymentEvents)
      .where(
        and(
          sql`${paymentEvents.createdAt} >= ${from}`,
          eq(paymentEvents.eventType, "payment_code.duplicate_rejected"),
        ),
      );

    const paymentTotalCount = Number(paymentTotals.total);
    const paymentFailedCount = Number(paymentTotals.failed);

    return {
      measuredAt: measuredAt.toISOString(),
      windowMinutes,
      paymentFailureRate:
        paymentTotalCount === 0 ? 0 : paymentFailedCount / paymentTotalCount,
      paymentFailedCount,
      paymentTotalCount,
      webhookSignatureInvalidCount: Number(webhookTotals.signatureInvalid),
      webhookBusinessInvalidCount: Number(webhookTotals.businessInvalid),
      reconciliationErrorCount: Number(reconcileTotals.total),
      refundFailedCount: Number(refundTotals.failed),
      refundProcessingOverdueCount: Number(refundTotals.overdue),
      certificateExpiringCount:
        await this.countExpiringCertificates(measuredAt),
      paymentCodeUnknownCount: Number(paymentCodeTotals.unknown),
      paymentCodeReverseFailedCount: Number(paymentCodeTotals.reverseFailed),
      paymentCodeDuplicateRejectedCount: Number(
        paymentCodeDuplicateRejected.total,
      ),
      scannerOfflineMachineCount: 0,
    };
  }

  async getMachinePreflight(
    machineId: string,
  ): Promise<PaymentMachinePreflight> {
    const [machine] = await this.db
      .select({
        id: machines.id,
        code: machines.code,
        status: machines.status,
        lastSeenAt: machines.lastSeenAt,
      })
      .from(machines)
      .where(eq(machines.id, machineId))
      .limit(1);

    if (!machine) {
      return {
        machineId,
        machineCode: "",
        status: "blocked",
        availableProviders: [],
        defaultOptionKey: null,
        defaultProviderCode: null,
        checks: [
          {
            code: "machine_not_found",
            severity: "critical",
            passed: false,
            message: "Machine does not exist",
            evidence: { machineId },
          },
        ],
        checkedAt: new Date().toISOString(),
      };
    }

    const options =
      await this.providerConfigs.listMachinePaymentOptionsForMachine(
        machine.id,
      );
    const latestHeartbeat = await this.getLatestMachineHeartbeat(machine.id);
    const channelPolicy = await this.channelPolicies.getPolicy();
    const enabledChannelKeys = channelPolicy.channels
      .filter((channel) => channel.enabled)
      .map((channel) => channel.channelKey);
    const providerReadiness =
      await this.providerConfigs.listPaymentChannelProviderReadinessForMachine(
        machine.id,
      );
    const hasPaymentCodeOption = options.options.some(
      (item) => item.method === "payment_code",
    );
    const paymentCodeLocallyReady = isPaymentCodeScannerReady(latestHeartbeat);
    const availableProviders = withRecommendedPaymentOptions(
      options.options.filter((item) => {
        if (item.disabled) return false;
        return item.method !== "payment_code" || paymentCodeLocallyReady;
      }),
    );
    const defaultOption = availableProviders.find((item) => item.recommended);

    const checks: PaymentOpsCheck[] = [
      {
        code: "machine_online",
        severity: "critical",
        passed: machine.status === "online",
        message:
          machine.status === "online"
            ? "Machine is online"
            : "Machine is not online",
        evidence: { machineStatus: machine.status },
      },
      {
        code: "machine_real_provider_available",
        severity: "critical",
        passed: availableProviders.some((item) => item.providerCode !== "mock"),
        message:
          "At least one real payment provider is available for this machine",
        evidence: {
          providerCodes: availableProviders.map((item) => item.providerCode),
          filteredProviderCodes: options.options.map(
            (item) => item.providerCode,
          ),
        },
      },
      this.checkMachineEnabledChannelProviderSetup(
        enabledChannelKeys,
        providerReadiness,
      ),
      this.checkMachineHeartbeatFresh(machine, latestHeartbeat),
    ];
    checks.push(this.checkProductionDispensePath(latestHeartbeat));

    if (hasPaymentCodeOption) {
      checks.push(this.checkPaymentCodeScannerRuntime(latestHeartbeat));
    }

    const criticalFailed = checks.some(
      (check) => check.severity === "critical" && !check.passed,
    );

    return {
      machineId: machine.id,
      machineCode: machine.code,
      status: criticalFailed ? "blocked" : "ready",
      availableProviders,
      defaultOptionKey: defaultOption?.optionKey ?? null,
      defaultProviderCode: defaultOption?.providerCode ?? null,
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  private async getLatestMachineHeartbeat(
    machineId: string,
  ): Promise<LatestMachineHeartbeat> {
    const [heartbeat] = await this.db
      .select({
        reportedAt: machineHeartbeats.reportedAt,
        receivedAt: machineHeartbeats.createdAt,
        statusPayloadJson: machineHeartbeats.statusPayloadJson,
      })
      .from(machineHeartbeats)
      .where(eq(machineHeartbeats.machineId, machineId))
      .orderBy(desc(machineHeartbeats.createdAt))
      .limit(1);
    return heartbeat ?? null;
  }

  private checkMachineHeartbeatFresh(
    machine: MachinePreflightRecord,
    heartbeat: LatestMachineHeartbeat,
  ): PaymentOpsCheck {
    const timeoutSeconds = this.config.machineHeartbeatTimeoutSeconds;
    const lastSeenAt = machine.lastSeenAt;
    const ageSeconds = lastSeenAt
      ? Math.floor((Date.now() - lastSeenAt.getTime()) / 1_000)
      : null;
    const passed =
      heartbeat !== null && ageSeconds !== null && ageSeconds <= timeoutSeconds;
    const message = !heartbeat
      ? "Machine heartbeat is missing"
      : ageSeconds === null
        ? "Machine heartbeat receive time is missing"
        : passed
          ? "Machine heartbeat is fresh"
          : "Machine heartbeat timed out";

    return {
      code: "machine_heartbeat.fresh",
      severity: "critical",
      passed,
      message,
      evidence: {
        lastSeenAt: lastSeenAt?.toISOString() ?? null,
        reportedAt: heartbeat?.reportedAt?.toISOString() ?? null,
        heartbeatReceivedAt: heartbeat?.receivedAt?.toISOString() ?? null,
        timeoutSeconds,
        ageSeconds,
      },
    };
  }

  private checkMachineEnabledChannelProviderSetup(
    enabledChannelKeys: PaymentChannelKey[],
    providerReadiness: PaymentChannelProviderReadiness[],
  ): PaymentOpsCheck {
    const readinessByChannel = new Map(
      providerReadiness.map((item) => [item.channelKey, item]),
    );
    const blockedChannels = enabledChannelKeys
      .map((channelKey) => {
        const readiness = readinessByChannel.get(channelKey);
        if (readiness?.ready) return null;
        const [method, providerCode] = channelKey.split(":");
        return {
          channelKey,
          providerCode: readiness?.providerCode ?? providerCode,
          method: readiness?.method ?? method,
          missingCredentialKeys: readiness?.missingCredentialKeys ?? [
            "providerConfig",
          ],
        };
      })
      .filter((item) => item !== null);

    return {
      code: "enabled_channel_provider_setup",
      severity: "critical",
      passed: blockedChannels.length === 0 && enabledChannelKeys.length > 0,
      message:
        blockedChannels.length === 0 && enabledChannelKeys.length > 0
          ? "已启用支付渠道的商户配置可用"
          : "已启用支付渠道存在商户配置阻塞",
      evidence: {
        enabledChannelKeys,
        blockedChannels,
      },
    };
  }

  private checkProductionDispensePath(
    heartbeat: LatestMachineHeartbeat,
  ): PaymentOpsCheck {
    const isProduction = this.config.nodeEnv === "production";
    const hardwareAdapter = readHeartbeatStringField(
      heartbeat,
      "hardwareAdapter",
    );
    const hardwarePortPath = readHeartbeatStringField(
      heartbeat,
      "hardwarePortPath",
    );
    const hardwareStatus = readHeartbeatStringField(
      heartbeat,
      "hardwareStatus",
    );
    const hardwareMessage = readHeartbeatStringField(
      heartbeat,
      "hardwareMessage",
    );

    let code = "production_dispense_path.ready";
    let passed = true;
    let message = "Production dispense path is ready";
    if (isProduction && hardwareAdapter === "mock") {
      code = "production_dispense_path.mock";
      passed = false;
      message = "生产出货路径不能使用 mock hardwareAdapter";
    } else if (
      isProduction &&
      (!heartbeat || !hardwareAdapter || !hardwarePortPath)
    ) {
      code = "production_dispense_path.evidence_missing";
      passed = false;
      message = "生产出货路径缺少硬件心跳证据";
    } else if (
      isProduction &&
      hardwarePortPath !== null &&
      hardwarePortPath.trimStart().startsWith("tcp://")
    ) {
      code = "production_dispense_path.tcp_simulator";
      passed = false;
      message = "生产出货路径不能使用 tcp:// lower-controller simulator";
    }

    return {
      code,
      severity: isProduction ? "critical" : "warning",
      passed,
      message,
      evidence: {
        heartbeatReceivedAt: heartbeat?.receivedAt?.toISOString?.() ?? null,
        reportedAt: heartbeat?.reportedAt?.toISOString?.() ?? null,
        hardwareAdapter,
        hardwarePortPath,
        hardwareStatus,
        hardwareMessage,
      },
    };
  }

  private checkPaymentCodeScannerRuntime(
    heartbeat: LatestMachineHeartbeat,
  ): PaymentOpsCheck {
    const scannerHealth = readHeartbeatRecordField(heartbeat, "scannerHealth");
    const status = readStringFromRecord(scannerHealth, "status");
    const message = readStringFromRecord(scannerHealth, "message");
    const online = readBooleanFromRecord(scannerHealth, "online");
    const ready = isPaymentCodeScannerReady(heartbeat);
    const reported = scannerHealth !== null;
    const disabledReason = message;

    if (ready) {
      return {
        code: "payment_code.scanner_runtime.ready",
        severity: "info",
        passed: true,
        message: "付款码支付扫码模块健康证据已上报",
        evidence: {
          status,
          online,
          message,
        },
      };
    }

    return {
      code: reported
        ? "payment_code.scanner_runtime.degraded"
        : "payment_code.scanner_health_not_reported",
      severity: "warning",
      passed: false,
      message: disabledReason
        ? `付款码支付已启用，但扫码模块未就绪：${disabledReason}`
        : reported
          ? "付款码支付已启用，但扫码模块未就绪；二维码支付不受影响"
          : "付款码支付已启用，但服务端尚未收到扫码模块健康证据；二维码支付不受影响",
      evidence: {
        status,
        online,
        message,
      },
    };
  }

  private async checkMockProviderDisabled(): Promise<PaymentOpsCheck> {
    const [mockProvider] = await this.db
      .select({ status: paymentProviders.status })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, "mock"))
      .limit(1);

    const passed =
      !this.config.paymentMockEnabled && mockProvider?.status !== "enabled";

    return {
      code: "mock_provider_disabled",
      severity: this.config.nodeEnv === "production" ? "critical" : "warning",
      passed,
      message: passed ? "Mock payment is disabled" : "Mock payment is enabled",
      evidence: {
        envPaymentMockEnabled: this.config.paymentMockEnabled,
        mockProviderStatus: mockProvider?.status ?? null,
      },
    };
  }

  private checkEnabledPaymentChannels(
    enabledChannelKeys: PaymentChannelKey[],
  ): PaymentOpsCheck {
    return {
      code: "enabled_payment_channels_present",
      severity: "critical",
      passed: enabledChannelKeys.length > 0,
      message:
        enabledChannelKeys.length > 0
          ? "已启用支付渠道可用于上线评估"
          : "没有启用任何支付渠道",
      evidence: { enabledChannelKeys },
    };
  }

  private async checkRealProviderConfigsPresent(
    enabledChannelKeys: PaymentChannelKey[],
  ): Promise<PaymentOpsCheck[]> {
    const rows = await this.db
      .select({
        providerCode: paymentProviders.code,
        providerStatus: paymentProviders.status,
        configStatus: paymentProviderConfigs.status,
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
      .where(sql`${paymentProviders.code} in ('wechat_pay', 'alipay')`);

    const inspections: ProviderConfigInspection[] = rows.map((row) => {
      let sensitiveConfig: Record<string, unknown> | null = null;
      try {
        sensitiveConfig = isEncryptedJson(row.configEncryptedJson)
          ? this.paymentConfigSecrets.decrypt(row.configEncryptedJson)
          : null;
      } catch {
        sensitiveConfig = null;
      }
      const publicConfig =
        typeof row.publicConfigJson === "object" &&
        row.publicConfigJson !== null
          ? (row.publicConfigJson as Record<string, unknown>)
          : {};
      return {
        providerCode: row.providerCode,
        providerStatus: row.providerStatus,
        configStatus: row.configStatus,
        machineId: row.machineId,
        merchantNo: row.merchantNo,
        appId: row.appId,
        publicConfig,
        sensitiveConfig,
      };
    });

    const completeEnabledRows = inspections.filter((row) => {
      if (row.providerStatus !== "enabled") return false;
      if (row.configStatus !== "enabled") return false;
      if (!row.sensitiveConfig) return false;
      return (
        this.missingProviderConfigKeys(row, "qr_code").length === 0 ||
        this.missingProviderConfigKeys(row, "payment_code").length === 0
      );
    });

    const enabledGlobal = completeEnabledRows.filter(
      (row) => row.machineId === null,
    );
    const enabledMachineScoped = completeEnabledRows.filter(
      (row) => row.machineId !== null,
    );

    const enabledChannelReadiness = enabledChannelKeys.map((channelKey) =>
      this.evaluateEnabledChannelProviderSetup(channelKey, inspections),
    );
    const blockedChannels = enabledChannelReadiness.filter(
      (channel) => !channel.ready,
    );
    const readyEnabledChannels = enabledChannelReadiness.filter(
      (channel) => channel.ready,
    );
    const sandboxChannelRows = enabledChannelReadiness.filter((channel) =>
      channel.environments.includes("sandbox"),
    );
    const productionChannelRows = enabledChannelReadiness.filter((channel) =>
      channel.environments.includes("production"),
    );
    const sandboxProviders = [
      ...new Set(sandboxChannelRows.map((row) => row.providerCode)),
    ];
    const productionProviders = [
      ...new Set(productionChannelRows.map((row) => row.providerCode)),
    ];
    const productionEnvironmentReady =
      this.config.nodeEnv !== "production" || sandboxChannelRows.length === 0;

    return [
      {
        code: "enabled_channel_provider_setup",
        severity: "critical",
        passed: blockedChannels.length === 0 && enabledChannelKeys.length > 0,
        message:
          blockedChannels.length === 0 && enabledChannelKeys.length > 0
            ? "已启用支付渠道的商户配置可用"
            : "已启用支付渠道存在商户配置阻塞",
        evidence: {
          enabledChannelKeys,
          readyChannelKeys: readyEnabledChannels.map(
            (channel) => channel.channelKey,
          ),
          blockedChannels: blockedChannels.map((channel) => ({
            channelKey: channel.channelKey,
            providerCode: channel.providerCode,
            missingCredentialKeys: channel.missingCredentialKeys,
          })),
        },
      },
      {
        code: "real_provider_config_present",
        severity: "critical",
        passed: readyEnabledChannels.length > 0,
        message:
          readyEnabledChannels.length > 0
            ? "At least one real provider config is enabled for global or machine-level rollout"
            : "No real provider config is enabled",
        evidence: {
          completeEnabledGlobalProviders: enabledGlobal.map(
            (row) => row.providerCode,
          ),
          completeEnabledMachineScopedProviders: enabledMachineScoped.map(
            (row) => ({
              providerCode: row.providerCode,
              machineId: row.machineId,
            }),
          ),
          inspectedRows: rows.length,
          readyChannelKeys: readyEnabledChannels.map(
            (channel) => channel.channelKey,
          ),
        },
      },
      {
        code: "provider_environment.production_ready",
        severity: this.config.nodeEnv === "production" ? "critical" : "warning",
        passed: productionEnvironmentReady,
        message:
          this.config.nodeEnv === "production"
            ? productionEnvironmentReady
              ? "生产环境支付配置已使用正式环境"
              : "生产环境不能只使用沙箱支付配置"
            : sandboxProviders.length > 0
              ? "当前环境允许沙箱支付配置，仅用于测试验证"
              : "当前环境未发现沙箱支付配置",
        evidence: {
          sandboxProviders,
          productionProviders,
          sandboxChannelKeys: sandboxChannelRows.map(
            (channel) => channel.channelKey,
          ),
          environment: this.config.nodeEnv,
        },
      },
    ];
  }

  private async checkMachineRealProviderOptionsAvailable(): Promise<PaymentOpsCheck> {
    const machineRows = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(eq(machines.status, "online"));

    const blockedMachines: Array<{
      machineId: string;
      machineCode: string;
      providerCodes: string[];
      error: string | null;
    }> = [];

    for (const machine of machineRows) {
      try {
        const options =
          // oxlint-disable-next-line no-await-in-loop
          await this.providerConfigs.listMachinePaymentOptionsForMachine(
            machine.id,
          );
        const providerCodes = options.options.map(
          (option) => option.providerCode,
        );
        if (!providerCodes.some((code) => code !== "mock")) {
          blockedMachines.push({
            machineId: machine.id,
            machineCode: machine.code,
            providerCodes,
            error: null,
          });
        }
      } catch (error) {
        blockedMachines.push({
          machineId: machine.id,
          machineCode: machine.code,
          providerCodes: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      code: "machine_real_provider_options_available",
      severity: "critical",
      passed: blockedMachines.length === 0,
      message:
        blockedMachines.length === 0
          ? "Every online machine has at least one real payment option"
          : "Some online machines have no real payment option",
      evidence: {
        onlineMachineCount: machineRows.length,
        blockedMachines,
      },
    };
  }

  private evaluateEnabledChannelProviderSetup(
    channelKey: PaymentChannelKey,
    inspections: ProviderConfigInspection[],
  ): EnabledChannelProviderSetup {
    const [method, providerCode] = parsePaymentChannelKey(channelKey);
    const candidates = inspections.filter(
      (row) => row.providerCode === providerCode,
    );
    if (candidates.length === 0) {
      return {
        channelKey,
        providerCode,
        method,
        ready: false,
        missingCredentialKeys: ["providerConfig"],
        environments: [],
      };
    }

    const globalCandidates = candidates.filter(
      (candidate) => candidate.machineId === null,
    );
    const relevantMachineIds = [
      ...new Set(
        candidates.flatMap((candidate) =>
          candidate.machineId === null ? [] : [candidate.machineId],
        ),
      ),
    ];
    const effectiveCandidates = [
      ...globalCandidates,
      ...relevantMachineIds.flatMap((machineId) =>
        candidates.filter((candidate) => candidate.machineId === machineId),
      ),
    ];
    const candidateResults = effectiveCandidates.map((candidate) => ({
      candidate,
      missingCredentialKeys: this.missingProviderConfigKeys(candidate, method),
    }));
    const readyResults = candidateResults.filter(
      (result) => result.missingCredentialKeys.length === 0,
    );
    const blockedResults = candidateResults.filter(
      (result) => result.missingCredentialKeys.length > 0,
    );
    const bestAttempt = blockedResults.reduce<
      (typeof blockedResults)[number] | undefined
    >(
      (best, current) =>
        !best ||
        current.missingCredentialKeys.length < best.missingCredentialKeys.length
          ? current
          : best,
      undefined,
    );
    const ready =
      candidateResults.length > 0 &&
      readyResults.length === candidateResults.length;
    const environments = [
      ...new Set(
        readyResults.flatMap((result) => {
          const environment = this.providerEnvironment(
            providerCode,
            result.candidate.publicConfig,
          );
          return environment === null ? [] : [environment];
        }),
      ),
    ];

    return {
      channelKey,
      providerCode,
      method,
      ready,
      missingCredentialKeys: ready
        ? []
        : bestAttempt && bestAttempt.missingCredentialKeys.length > 0
          ? bestAttempt.missingCredentialKeys
          : ["providerConfig"],
      environments,
    };
  }

  private missingProviderConfigKeys(
    row: ProviderConfigInspection,
    method: "qr_code" | "payment_code",
  ): string[] {
    const missing: string[] = [];
    const sensitiveConfig = row.sensitiveConfig;
    if (row.providerStatus !== "enabled") missing.push("providerStatus");
    if (row.configStatus !== "enabled") missing.push("configStatus");
    if (!row.merchantNo) missing.push("merchantNo");
    if (!row.appId) missing.push("appId");
    if (!sensitiveConfig) {
      missing.push("sensitiveConfig");
      return missing;
    }

    if (row.providerCode === "alipay") {
      if (!hasNonEmptyString(row.publicConfig, "gatewayUrl")) {
        missing.push("gatewayUrl");
      }
      if (
        !alipayEffectiveEnvironmentSchema.safeParse(row.publicConfig).success
      ) {
        missing.push("effectiveProviderEnvironment");
      }
      if (!hasNonEmptyString(row.publicConfig, "keyType")) {
        missing.push("keyType");
      }
      for (const key of [
        "privateKeyPem",
        "appCertPem",
        "alipayPublicCertPem",
        "alipayRootCertPem",
      ]) {
        if (!hasNonEmptyString(sensitiveConfig, key)) missing.push(key);
      }
      return missing;
    }

    if (row.providerCode === "wechat_pay") {
      if (
        !hasNonEmptyString(row.publicConfig, "merchantCertificateSerialNo") &&
        !hasNonEmptyString(row.publicConfig, "certificateSerialNo")
      ) {
        missing.push("merchantCertificateSerialNo");
      }
      if (!hasNonEmptyString(row.publicConfig, "platformCertificateSerialNo")) {
        missing.push("platformCertificateSerialNo");
      }
      for (const key of ["apiV3Key", "privateKeyPem"]) {
        if (!hasNonEmptyString(sensitiveConfig, key)) missing.push(key);
      }
      if (
        !hasNonEmptyString(sensitiveConfig, "platformCertificatePem") &&
        !hasNonEmptyString(sensitiveConfig, "platformPublicKeyPem")
      ) {
        missing.push("platformCertificatePem");
      }
      if (method === "payment_code") {
        for (const key of [
          "apiV2Key",
          "merchantApiCertPem",
          "merchantApiKeyPem",
        ]) {
          if (!hasNonEmptyString(sensitiveConfig, key)) missing.push(key);
        }
      }
    }

    return missing;
  }

  private providerEnvironment(
    providerCode: "alipay" | "wechat_pay",
    publicConfig: Record<string, unknown>,
  ): "sandbox" | "production" | null {
    if (providerCode === "wechat_pay") return "production";
    const result = alipayEffectiveEnvironmentSchema.safeParse(publicConfig);
    return result.success ? result.data.mode : null;
  }

  private async checkNotifyUrls(
    enabledChannelKeys: PaymentChannelKey[],
  ): Promise<PaymentOpsCheck> {
    const enabledProviderCodes = [
      ...new Set(
        enabledChannelKeys.map((channelKey) => channelKey.split(":")[1]),
      ),
    ];
    const checks = await Promise.all(
      enabledProviderCodes.map(async (providerCode) => {
        const staticCheck =
          this.config.getPaymentNotifyUrlStaticCheck(providerCode);
        return {
          providerCode,
          ok:
            staticCheck.pathMatchesWebhookRoute &&
            (this.config.nodeEnv !== "production" || staticCheck.usesHttps) &&
            (this.config.nodeEnv !== "production" || !staticCheck.isLocalhost),
          staticCheck,
        };
      }),
    );

    return {
      code: "notify_url_static_check",
      severity: "critical",
      passed: checks.every((item) => item.ok),
      message:
        "Notify URL path, protocol and host are valid for the environment",
      evidence: { checks },
    };
  }

  private async checkCertificates(
    enabledChannelKeys: PaymentChannelKey[],
  ): Promise<PaymentOpsCheck> {
    const total = await this.countExpiringCertificates(
      new Date(),
      enabledChannelKeys,
    );
    return {
      code: "payment_certificate_not_expiring",
      severity: "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No configured payment certificate is expired or near expiry"
          : "At least one configured payment certificate is expired or near expiry",
      evidence: { certificateExpiringCount: total },
    };
  }

  private async checkRecentWebhookFailures(): Promise<PaymentOpsCheck> {
    const from = new Date(
      Date.now() - this.config.paymentAlertWindowMinutes * 60_000,
    );
    const [row] = await this.db
      .select({ total: count() })
      .from(paymentWebhookAttempts)
      .where(
        and(
          sql`${paymentWebhookAttempts.createdAt} >= ${from}`,
          sql`${paymentWebhookAttempts.signatureValid} = false or ${paymentWebhookAttempts.businessValid} = false`,
        ),
      );

    const total = Number(row.total);
    return {
      code: "recent_webhook_failures",
      severity: total === 0 ? "info" : "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No recent webhook verification failures"
          : "Recent webhook failures exist",
      evidence: {
        count: total,
        windowMinutes: this.config.paymentAlertWindowMinutes,
      },
    };
  }

  private async checkRecentPaymentFailures(): Promise<PaymentOpsCheck> {
    const from = new Date(
      Date.now() - this.config.paymentAlertWindowMinutes * 60_000,
    );
    const [row] = await this.db
      .select({ total: count() })
      .from(payments)
      .where(
        and(
          sql`${payments.createdAt} >= ${from}`,
          eq(payments.status, "failed"),
        ),
      );

    const total = Number(row.total);
    return {
      code: "recent_payment_failures",
      severity: total === 0 ? "info" : "critical",
      passed: total === 0,
      message: total === 0 ? "近期没有支付失败" : "近期存在支付失败",
      evidence: {
        count: total,
        windowMinutes: this.config.paymentAlertWindowMinutes,
      },
    };
  }

  private async checkRecentReconciliationFailures(): Promise<PaymentOpsCheck> {
    const from = new Date(
      Date.now() - this.config.paymentAlertWindowMinutes * 60_000,
    );
    const [row] = await this.db
      .select({ total: count() })
      .from(paymentReconciliationAttempts)
      .where(
        and(
          sql`${paymentReconciliationAttempts.createdAt} >= ${from}`,
          sql`${paymentReconciliationAttempts.status} in ('network_error', 'config_error', 'max_attempts_exceeded')`,
        ),
      );

    const total = Number(row.total);
    return {
      code: "recent_reconciliation_failures",
      severity: total === 0 ? "info" : "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No recent reconciliation failures"
          : "Recent reconciliation failures exist",
      evidence: {
        count: total,
        windowMinutes: this.config.paymentAlertWindowMinutes,
      },
    };
  }

  private async checkRefundBacklog(): Promise<PaymentOpsCheck> {
    const overdueBefore = new Date(Date.now() - 30 * 60_000);
    const [row] = await this.db
      .select({ total: count() })
      .from(refunds)
      .where(
        and(
          sql`${refunds.status} = 'failed' or (${refunds.status} = 'processing' and ${refunds.updatedAt} < ${overdueBefore})`,
        ),
      );

    const total = Number(row.total);
    return {
      code: "refund_backlog_clear",
      severity: total === 0 ? "info" : "critical",
      passed: total === 0,
      message:
        total === 0
          ? "No failed or overdue processing refunds"
          : "Refund backlog requires handling",
      evidence: { count: total },
    };
  }

  private async countExpiringCertificates(
    now: Date,
    enabledChannelKeys?: PaymentChannelKey[],
  ): Promise<number> {
    const warningAfter = new Date(
      now.getTime() +
        this.config.paymentCertificateExpiryWarningDays * 24 * 60 * 60 * 1000,
    );

    const rows = await this.db
      .select({
        providerCode: paymentProviders.code,
        providerStatus: paymentProviders.status,
        configStatus: paymentProviderConfigs.status,
        machineId: paymentProviderConfigs.machineId,
        merchantNo: paymentProviderConfigs.merchantNo,
        appId: paymentProviderConfigs.appId,
        publicConfigJson: paymentProviderConfigs.publicConfigJson,
        configEncryptedJson: paymentProviderConfigs.configEncryptedJson,
        updatedAt: paymentProviderConfigs.updatedAt,
      })
      .from(paymentProviderConfigs)
      .innerJoin(
        paymentProviders,
        eq(paymentProviders.id, paymentProviderConfigs.providerId),
      )
      .where(eq(paymentProviderConfigs.status, "enabled"));

    const enabledChannelsByProvider = new Map<
      "alipay" | "wechat_pay",
      Array<"qr_code" | "payment_code">
    >();
    for (const channelKey of enabledChannelKeys ?? []) {
      const [method, providerCode] = parsePaymentChannelKey(channelKey);
      enabledChannelsByProvider.set(providerCode, [
        ...(enabledChannelsByProvider.get(providerCode) ?? []),
        method,
      ]);
    }

    return rows.reduce((total, row) => {
      try {
        if (
          row.providerCode !== "alipay" &&
          row.providerCode !== "wechat_pay"
        ) {
          return total;
        }
        const enabledMethods = enabledChannelsByProvider.get(row.providerCode);
        if (enabledChannelKeys && !enabledMethods) {
          return total;
        }
        if (!isEncryptedJson(row.configEncryptedJson)) return total;
        const decrypted = this.paymentConfigSecrets.decrypt(
          row.configEncryptedJson,
        );
        if (enabledMethods) {
          const publicConfig =
            typeof row.publicConfigJson === "object" &&
            row.publicConfigJson !== null
              ? (row.publicConfigJson as Record<string, unknown>)
              : {};
          const inspection: ProviderConfigInspection = {
            providerCode: row.providerCode,
            providerStatus: row.providerStatus,
            configStatus: row.configStatus,
            machineId: row.machineId,
            merchantNo: row.merchantNo,
            appId: row.appId,
            publicConfig,
            sensitiveConfig: decrypted,
          };
          const configUsedByEnabledChannel = enabledMethods.some(
            (method) =>
              this.missingProviderConfigKeys(inspection, method).length === 0,
          );
          if (!configUsedByEnabledChannel) return total;
        }
        const summary = this.paymentConfigSecrets.summarize(
          decrypted,
          row.updatedAt,
        );
        const hasExpiring = Object.values(summary).some((item) => {
          if (!item.certificateExpiresAt) return false;
          return (
            new Date(item.certificateExpiresAt).getTime() <=
            warningAfter.getTime()
          );
        });
        return total + (hasExpiring ? 1 : 0);
      } catch {
        return total + 1;
      }
    }, 0);
  }
}
