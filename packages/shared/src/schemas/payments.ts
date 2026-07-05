import { z } from "zod";

import {
  paymentCodeAttemptStatusSchema,
  paymentProviderStatusSchema,
  paymentProviderTypeSchema,
  paymentStatusSchema,
  refundStatusSchema,
} from "../enums/payment-status";
import {
  machinePaymentOptionKeySchema,
  machinePaymentOptionSchema,
  machinePaymentProviderCodeSchema,
} from "./orders";

export const paymentQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  paymentNo: z.string().max(64).optional(),
  providerCode: z.string().max(64).optional(),
  status: paymentStatusSchema.optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const paymentProviderQuerySchema = z.object({
  code: z.string().max(64).optional(),
  type: paymentProviderTypeSchema.optional(),
  status: paymentProviderStatusSchema.optional(),
});

export const updatePaymentProviderSchema = z.strictObject({
  name: z.string().min(1).max(128).optional(),
  status: paymentProviderStatusSchema.optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

export const paymentEventQuerySchema = z.object({
  paymentNo: z.string().max(64).optional(),
  providerCode: z.string().max(64).optional(),
  eventType: z.string().max(128).optional(),
  signatureValid: z.coerce.boolean().optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const paymentProviderSensitiveConfigSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

// Provider-specific timing config (shared across wechat_pay and alipay)
const paymentTimingConfigSchema = z.object({
  qrExpiresMinutes: z.int().min(1).max(60).default(15),
  timeoutCompensationSeconds: z.int().min(0).max(600).default(120),
});

const paymentCodeTimingConfigSchema = z.object({
  paymentCodeEnabled: z.boolean().default(false),
  paymentCodePollIntervalSeconds: z.int().min(1).max(10).default(3),
  paymentCodeMaxConfirmSeconds: z.int().min(10).max(120).default(30),
  paymentCodeReverseDelaySeconds: z.int().min(0).max(30).default(0),
});

const paymentTimingConfigPatchSchema = z.object({
  qrExpiresMinutes: z.int().min(1).max(60).optional(),
  timeoutCompensationSeconds: z.int().min(0).max(600).optional(),
});

const paymentCodeTimingConfigPatchSchema = z.object({
  paymentCodeEnabled: z.boolean().optional(),
  paymentCodePollIntervalSeconds: z.int().min(1).max(10).optional(),
  paymentCodeMaxConfirmSeconds: z.int().min(10).max(120).optional(),
  paymentCodeReverseDelaySeconds: z.int().min(0).max(30).optional(),
});

export const paymentProviderConfigScopeSchema = z.object({
  providerCode: z.enum(["wechat_pay", "alipay"]),
  machineId: z.uuid().nullable().optional(),
  status: paymentProviderStatusSchema.default("enabled"),
});

export const wechatPayPublicConfigSchema = paymentTimingConfigSchema
  .extend(paymentCodeTimingConfigSchema.shape)
  .extend({
    mode: z.literal("direct_merchant").default("direct_merchant"),
    /** 商户 API 证书序列号，用于 Authorization serial_no 请求签名 */
    merchantCertificateSerialNo: z.string().min(1).max(128).optional(),
    /** @deprecated 旧别名，与 merchantCertificateSerialNo 等效；新配置请使用 merchantCertificateSerialNo */
    certificateSerialNo: z.string().min(1).max(128).optional(),
    /** 微信支付平台证书/公钥序列号，用于匹配 wechatpay-serial 响应/回调头 */
    platformCertificateSerialNo: z.string().min(1).max(128).optional(),
    paymentCodeSignType: z.enum(["MD5", "HMAC-SHA256"]).default("HMAC-SHA256"),
    paymentCodeDeviceInfo: z.string().min(1).max(32).optional(),
  })
  .strict();

export const wechatPaySensitiveConfigSchema = z.object({
  apiV3Key: z.string().min(32).max(128).optional(),
  privateKeyPem: z.string().min(1).optional(),
  /** 微信支付平台证书 PEM（推荐），可提取公钥并展示过期时间 */
  platformCertificatePem: z.string().min(1).optional(),
  /** 微信支付平台公钥 PEM（兼容字段），无法判断证书有效期 */
  platformPublicKeyPem: z.string().min(1).optional(),
  apiV2Key: z.string().min(32).max(128).optional(),
  merchantApiCertPem: z.string().min(1).optional(),
  merchantApiKeyPem: z.string().min(1).optional(),
});

export const alipayPublicConfigSchema = paymentTimingConfigSchema
  .extend(paymentCodeTimingConfigSchema.shape)
  .extend({
    mode: z.enum(["sandbox", "production"]).default("sandbox"),
    gatewayUrl: z
      .url()
      .default("https://openapi-sandbox.dl.alipaydev.com/gateway.do"),
    keyType: z.enum(["PKCS8", "PKCS1"]).default("PKCS8"),
    storeId: z.string().min(1).max(32).optional(),
    terminalId: z.string().min(1).max(32).optional(),
  })
  .strict();

export const alipaySensitiveConfigSchema = z.object({
  privateKeyPem: z.string().min(1).optional(),
  appCertPem: z.string().min(1).optional(),
  alipayPublicCertPem: z.string().min(1).optional(),
  alipayRootCertPem: z.string().min(1).optional(),
});

const wechatPayPublicConfigPatchSchema = paymentTimingConfigPatchSchema
  .extend(paymentCodeTimingConfigPatchSchema.shape)
  .extend({
    mode: z.literal("direct_merchant").optional(),
    merchantCertificateSerialNo: z.string().min(1).max(128).optional(),
    certificateSerialNo: z.string().min(1).max(128).optional(),
    platformCertificateSerialNo: z.string().min(1).max(128).optional(),
    paymentCodeSignType: z.enum(["MD5", "HMAC-SHA256"]).optional(),
    paymentCodeDeviceInfo: z.string().min(1).max(32).optional(),
  })
  .strict();

const alipayPublicConfigPatchSchema = paymentTimingConfigPatchSchema
  .extend(paymentCodeTimingConfigPatchSchema.shape)
  .extend({
    mode: z.enum(["sandbox", "production"]).optional(),
    gatewayUrl: z.url().optional(),
    keyType: z.enum(["PKCS8", "PKCS1"]).optional(),
    storeId: z.string().min(1).max(32).optional(),
    terminalId: z.string().min(1).max(32).optional(),
  })
  .strict();

export const providerSecretStatusValueSchema = z.object({
  configured: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
  fingerprintSha256: z.string().nullable().optional(),
  certificateExpiresAt: z.iso.datetime().nullable().optional(),
  errorCode: z.string().nullable().optional(),
});

export const paymentProviderConfigSecretStatusSchema = z.record(
  z.string(),
  providerSecretStatusValueSchema,
);

export const paymentProviderNotifyUrlCheckSchema = z
  .object({
    providerCode: z.enum(["wechat_pay", "alipay"]),
    notifyUrl: z.url(),
    usesHttps: z.boolean(),
    isLocalhost: z.boolean(),
    pathMatchesWebhookRoute: z.boolean(),
    reachable: z.boolean(),
    statusCode: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    checkedAt: z.iso.datetime(),
  })
  .strict();

const paymentProviderPublicConfigPatchSchema = z.union([
  wechatPayPublicConfigPatchSchema,
  alipayPublicConfigPatchSchema,
]);

export const updatePaymentProviderConfigSchema = z.strictObject({
  merchantNo: z.string().max(128).nullable().optional(),
  appId: z.string().max(128).nullable().optional(),
  publicConfigJson: paymentProviderPublicConfigPatchSchema.optional(),
  status: paymentProviderStatusSchema.optional(),
});

export const upsertPaymentProviderConfigSchema = z
  .discriminatedUnion("providerCode", [
    paymentProviderConfigScopeSchema.extend({
      providerCode: z.literal("wechat_pay"),
      merchantNo: z.string().max(128).nullable().optional(),
      appId: z.string().max(128).nullable().optional(),
      publicConfigJson: wechatPayPublicConfigSchema.partial().optional(),
      sensitiveConfigJson: paymentProviderSensitiveConfigSchema.optional(),
    }),
    paymentProviderConfigScopeSchema.extend({
      providerCode: z.literal("alipay"),
      merchantNo: z.string().max(128).nullable().optional(),
      appId: z.string().max(128).nullable().optional(),
      publicConfigJson: alipayPublicConfigSchema.partial().optional(),
      sensitiveConfigJson: paymentProviderSensitiveConfigSchema.optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.status === "disabled") return;
    const timing = value.publicConfigJson ?? {};
    const timingResult = paymentTimingConfigSchema.safeParse(timing);
    if (!timingResult.success) {
      ctx.addIssue({
        code: "custom",
        path: ["publicConfigJson"],
        message:
          "qrExpiresMinutes must be 1-60 and timeoutCompensationSeconds must be 0-600",
      });
    }
    if (value.providerCode === "wechat_pay") {
      const pub = value.publicConfigJson ?? {};
      const sensitive = (value.sensitiveConfigJson ?? {}) as Record<
        string,
        unknown
      >;

      // merchantCertificateSerialNo or deprecated certificateSerialNo must be present
      const hasMerchantSerial =
        (typeof pub["merchantCertificateSerialNo"] === "string" &&
          pub["merchantCertificateSerialNo"].length > 0) ||
        (typeof pub["certificateSerialNo"] === "string" &&
          pub["certificateSerialNo"].length > 0);
      if (!hasMerchantSerial) {
        ctx.addIssue({
          code: "custom",
          path: ["publicConfigJson", "merchantCertificateSerialNo"],
          message:
            "wechat_pay requires merchantCertificateSerialNo (or deprecated certificateSerialNo)",
        });
      }

      // platformCertificateSerialNo is required for enabled configs
      if (
        typeof pub["platformCertificateSerialNo"] !== "string" ||
        pub["platformCertificateSerialNo"].length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["publicConfigJson", "platformCertificateSerialNo"],
          message: "wechat_pay requires platformCertificateSerialNo",
        });
      }

      // platformCertificatePem or platformPublicKeyPem must be present
      const hasPlatformKey =
        (typeof sensitive["platformCertificatePem"] === "string" &&
          sensitive["platformCertificatePem"].length > 0) ||
        (typeof sensitive["platformPublicKeyPem"] === "string" &&
          sensitive["platformPublicKeyPem"].length > 0);
      if (!hasPlatformKey) {
        ctx.addIssue({
          code: "custom",
          path: ["sensitiveConfigJson"],
          message:
            "wechat_pay requires platformCertificatePem or platformPublicKeyPem",
        });
      }

      const result = wechatPayPublicConfigSchema.partial().safeParse(pub);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["publicConfigJson"],
          message: "wechat_pay public config is invalid",
        });
      }

      const paymentCodeEnabled = pub["paymentCodeEnabled"] === true;
      if (paymentCodeEnabled) {
        if (
          typeof sensitive["apiV2Key"] !== "string" ||
          sensitive["apiV2Key"].length < 32
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["sensitiveConfigJson", "apiV2Key"],
            message: "wechat_pay payment_code requires apiV2Key",
          });
        }
        if (
          typeof sensitive["merchantApiCertPem"] !== "string" ||
          sensitive["merchantApiCertPem"].length === 0 ||
          typeof sensitive["merchantApiKeyPem"] !== "string" ||
          sensitive["merchantApiKeyPem"].length === 0
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["sensitiveConfigJson"],
            message:
              "wechat_pay payment_code requires merchantApiCertPem and merchantApiKeyPem for reverse/refund",
          });
        }
      }
    }
    if (value.providerCode === "alipay") {
      const result = alipayPublicConfigSchema
        .partial()
        .safeParse(value.publicConfigJson ?? {});
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["publicConfigJson"],
          message: "alipay public config is invalid",
        });
      }
    }
  });

export const paymentProviderSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  type: paymentProviderTypeSchema,
  status: paymentProviderStatusSchema,
  capabilities: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
});

export const paymentProviderConfigSchema = z.strictObject({
  id: z.uuid(),
  providerId: z.uuid(),
  providerCode: z.enum(["wechat_pay", "alipay", "mock"]),
  providerName: z.string().max(128),
  machineId: z.uuid().nullable(),
  merchantNo: z.string().max(128).nullable(),
  appId: z.string().max(128).nullable(),
  publicConfigJson: z.record(z.string(), z.unknown()).default({}),
  derivedNotifyUrl: z.url().nullable(),
  secretStatusJson: paymentProviderConfigSecretStatusSchema.default({}),
  status: paymentProviderStatusSchema,
  updatedByAdminUserId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type UpsertPaymentProviderConfigInput = z.infer<
  typeof upsertPaymentProviderConfigSchema
>;

export const paymentWebhookAttemptQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  paymentNo: z.string().max(64).optional(),
  refundNo: z.string().max(64).optional(),
  providerCode: z.string().max(64).optional(),
  eventKind: z.enum(["payment", "refund", "unknown"]).optional(),
  signatureValid: z.coerce.boolean().optional(),
  businessValid: z.coerce.boolean().optional(),
  failureReason: z.string().max(128).optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const paymentReconciliationAttemptQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  paymentNo: z.string().max(64).optional(),
  providerCode: z.string().max(64).optional(),
  trigger: z
    .enum(["scheduled", "expire_compensation", "machine_status_poll", "manual"])
    .optional(),
  status: z.string().max(32).optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const refundQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  paymentNo: z.string().max(64).optional(),
  refundNo: z.string().max(64).optional(),
  providerCode: z.string().max(64).optional(),
  status: refundStatusSchema.optional(),
  reason: z.string().max(128).optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const paymentCodeAttemptQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  paymentNo: z.string().max(64).optional(),
  providerCode: z.enum(["wechat_pay", "alipay"]).optional(),
  status: paymentCodeAttemptStatusSchema.optional(),
  manualOnly: z.coerce.boolean().optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const paymentCodeAttemptAdminActionSchema = z.object({
  reason: z.string().trim().min(1).max(256),
});

export const paymentOperatorReasonSchema = paymentCodeAttemptAdminActionSchema;

export const paymentAdminActionResultSchema = z.strictObject({
  status: z.string().min(1).max(64),
  reconciled: z.boolean(),
  reason: z.string().min(1).max(128).optional(),
});

export const paymentAdminNoBodySchema = z.strictObject({});

export const paymentMockAdminActionResponseSchema = z.strictObject({
  paymentNo: z.string().min(1).max(64),
  paymentId: z.string().min(1),
  status: z.string().min(1).max(64),
  orderId: z.string().min(1),
  alreadyHandled: z.boolean(),
});

export const paymentCodeAttemptAdminResponseSchema = z.strictObject({
  id: z.string().min(1),
  orderId: z.string().min(1),
  orderNo: z.string().min(1),
  paymentNo: z.string().min(1),
  providerCode: z.enum(["wechat_pay", "alipay"]),
  attemptNo: z.int().positive(),
  providerPaymentNo: z.string().min(1),
  status: paymentCodeAttemptStatusSchema,
  authCodeMasked: z.string().min(1),
  source: z.string().min(1),
  providerTradeNo: z.string().nullable(),
  providerStatus: z.string().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  manualReason: z.string().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  reversedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const protectedPaymentDrillScenarioSchema = z.enum([
  "payment_code_unknown",
  "user_confirming_timeout",
  "query_failed_then_reversed",
  "qr_reconcile_failed",
  "refund_required",
  "manual_handling",
]);

export type ProtectedPaymentDrillScenario = z.infer<
  typeof protectedPaymentDrillScenarioSchema
>;

export const createProtectedPaymentDrillSchema = z.strictObject({
  machineId: z.uuid(),
  scenario: protectedPaymentDrillScenarioSchema,
  reason: z.string().trim().min(1).max(500),
});

export const protectedPaymentDrillRecoveryActionSchema = z.strictObject({
  action: z.enum([
    "query_payment_code",
    "reverse_payment_code",
    "reconcile_qr",
    "request_refund",
    "mark_manual_handling",
  ]),
  reason: z.string().trim().min(1).max(500),
});

export type CreateProtectedPaymentDrillInput = z.infer<
  typeof createProtectedPaymentDrillSchema
>;
export type ProtectedPaymentDrillRecoveryAction = z.infer<
  typeof protectedPaymentDrillRecoveryActionSchema
>;

// ---- Payment Ops / Readiness / Preflight -----------------------------------

export const paymentOpsCheckSeveritySchema = z.enum([
  "info",
  "warning",
  "critical",
]);

export const paymentOpsCheckSchema = z.object({
  code: z.string().min(1).max(128),
  severity: paymentOpsCheckSeveritySchema,
  passed: z.boolean(),
  message: z.string().min(1).max(512),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

export const paymentOpsReadinessSchema = z.object({
  status: z.enum(["ready", "blocked"]),
  checkedAt: z.iso.datetime(),
  environment: z.enum(["development", "test", "production"]),
  checks: z.array(paymentOpsCheckSchema),
});

export const paymentOpsMetricsSchema = z.object({
  measuredAt: z.iso.datetime(),
  windowMinutes: z.int().positive(),
  paymentFailureRate: z.number().min(0),
  paymentFailedCount: z.int().nonnegative(),
  paymentTotalCount: z.int().nonnegative(),
  webhookSignatureInvalidCount: z.int().nonnegative(),
  webhookBusinessInvalidCount: z.int().nonnegative(),
  reconciliationErrorCount: z.int().nonnegative(),
  refundFailedCount: z.int().nonnegative(),
  refundProcessingOverdueCount: z.int().nonnegative(),
  certificateExpiringCount: z.int().nonnegative(),
  paymentCodeUnknownCount: z.int().nonnegative(),
  paymentCodeReverseFailedCount: z.int().nonnegative(),
  paymentCodeDuplicateRejectedCount: z.int().nonnegative(),
  scannerOfflineMachineCount: z.int().nonnegative(),
});

export const paymentMachinePreflightSchema = z.object({
  machineId: z.uuid(),
  machineCode: z.string().min(1).max(64),
  status: z.enum(["ready", "blocked"]),
  availableProviders: z.array(machinePaymentOptionSchema),
  defaultOptionKey: machinePaymentOptionKeySchema.nullable(),
  defaultProviderCode: machinePaymentProviderCodeSchema.nullable(),
  checks: z.array(paymentOpsCheckSchema),
  checkedAt: z.iso.datetime(),
});

export type PaymentOpsReadiness = z.infer<typeof paymentOpsReadinessSchema>;
export type PaymentOpsCheck = z.infer<typeof paymentOpsCheckSchema>;
export type PaymentOpsMetrics = z.infer<typeof paymentOpsMetricsSchema>;
export type PaymentMachinePreflight = z.infer<
  typeof paymentMachinePreflightSchema
>;
