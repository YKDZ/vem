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
import { createPageResultSchema, pageQuerySchema } from "./pagination";

export const supportedPaymentChannelKeys = [
  "qr_code:alipay",
  "payment_code:alipay",
  "qr_code:wechat_pay",
  "payment_code:wechat_pay",
] as const;

export const paymentChannelKeySchema = z.enum(supportedPaymentChannelKeys);

export const paymentChannelPolicyEntrySchema = z.strictObject({
  channelKey: paymentChannelKeySchema,
  enabled: z.boolean(),
  rank: z.int().min(1).max(supportedPaymentChannelKeys.length),
});

function refinePaymentChannelPolicy(
  value: { channels: Array<{ channelKey: string; rank: number }> },
  ctx: z.RefinementCtx,
): void {
  const channelKeys = new Set<string>();
  const ranks = new Set<number>();
  for (const channel of value.channels) {
    if (channelKeys.has(channel.channelKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["channels"],
        message: "payment channel policy contains duplicate channelKey",
      });
    }
    channelKeys.add(channel.channelKey);

    if (ranks.has(channel.rank)) {
      ctx.addIssue({
        code: "custom",
        path: ["channels"],
        message: "payment channel policy contains duplicate rank",
      });
    }
    ranks.add(channel.rank);
  }

  const missingChannel = supportedPaymentChannelKeys.find(
    (channelKey) => !channelKeys.has(channelKey),
  );
  if (missingChannel) {
    ctx.addIssue({
      code: "custom",
      path: ["channels"],
      message: `payment channel policy missing ${missingChannel}`,
    });
  }

  const expectedRanks = Array.from(
    { length: supportedPaymentChannelKeys.length },
    (_, index) => index + 1,
  );
  const actualRanks = [...ranks].sort((a, b) => a - b);
  if (
    actualRanks.length !== expectedRanks.length ||
    actualRanks.some((rank, index) => rank !== expectedRanks[index])
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["channels"],
      message: "payment channel policy ranks must be contiguous from 1",
    });
  }
}

export const updatePaymentChannelPolicySchema = z
  .strictObject({
    channels: z
      .array(paymentChannelPolicyEntrySchema)
      .length(supportedPaymentChannelKeys.length),
    defaultChannelKey: paymentChannelKeySchema,
  })
  .superRefine((value, ctx) => {
    refinePaymentChannelPolicy(value, ctx);
    if (
      !value.channels.some(
        (channel) => channel.channelKey === value.defaultChannelKey,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultChannelKey"],
        message: "defaultChannelKey must refer to a known payment channel",
      });
    }
  });

export const paymentChannelPolicyResponseSchema =
  updatePaymentChannelPolicySchema.and(
    z.strictObject({
      updatedAt: z.iso.datetime().nullable(),
      updatedByAdminUserId: z.uuid().nullable(),
    }),
  );

export type PaymentChannelKey = z.infer<typeof paymentChannelKeySchema>;
export type PaymentChannelPolicyEntry = z.infer<
  typeof paymentChannelPolicyEntrySchema
>;
export type UpdatePaymentChannelPolicyInput = z.infer<
  typeof updatePaymentChannelPolicySchema
>;
export type PaymentChannelPolicyResponse = z.infer<
  typeof paymentChannelPolicyResponseSchema
>;

export const paymentQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  paymentNo: z.string().max(64).optional(),
  providerCode: z.string().max(64).optional(),
  status: paymentStatusSchema.optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const paymentListQuerySchema = paymentQuerySchema.extend(
  pageQuerySchema.shape,
);

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

export const paymentEventListQuerySchema = paymentEventQuerySchema.extend(
  pageQuerySchema.shape,
);

export const paymentProviderSensitiveConfigSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

// Provider-specific timing config (shared across wechat_pay and alipay)
const paymentTimingConfigSchema = z.object({
  qrExpiresMinutes: z.int().min(1).max(60).default(15),
  timeoutCompensationSeconds: z.int().min(0).max(600).default(120),
});

const paymentTimingConfigPatchSchema = z.object({
  qrExpiresMinutes: z.int().min(1).max(60).optional(),
  timeoutCompensationSeconds: z.int().min(0).max(600).optional(),
});

const paymentCodeRuntimeConfigSchema = z.object({
  paymentCodePollIntervalSeconds: z.int().min(1).max(60).optional(),
  paymentCodeMaxConfirmSeconds: z.int().min(1).max(600).optional(),
  paymentCodeReverseDelaySeconds: z.int().min(0).max(600).optional(),
  paymentCodeReverseRetryIntervalSeconds: z.int().min(1).max(600).optional(),
  paymentCodeReverseMaxAttempts: z.int().min(1).max(10).optional(),
});

export const paymentProviderConfigScopeSchema = z.object({
  providerCode: z.enum(["wechat_pay", "alipay"]),
  machineId: z.uuid().nullable().optional(),
  status: paymentProviderStatusSchema.default("enabled"),
});

export const wechatPayPublicConfigSchema = paymentTimingConfigSchema
  .extend({
    mode: z.literal("direct_merchant").default("direct_merchant"),
    /** 商户 API 证书序列号，用于 Authorization serial_no 请求签名 */
    merchantCertificateSerialNo: z.string().min(1).max(128).optional(),
    /** @deprecated 旧别名，与 merchantCertificateSerialNo 等效；新配置请使用 merchantCertificateSerialNo */
    certificateSerialNo: z.string().min(1).max(128).optional(),
    /** 微信支付平台证书/公钥序列号，用于匹配 wechatpay-serial 响应/回调头 */
    platformCertificateSerialNo: z.string().min(1).max(128).optional(),
    paymentCodeSignType: z.enum(["MD5", "HMAC-SHA256"]).optional(),
    paymentCodeDeviceInfo: z.string().min(1).max(32).optional(),
  })
  .extend(paymentCodeRuntimeConfigSchema.shape)
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
  .extend({
    mode: z.enum(["sandbox", "production"]).default("sandbox"),
    gatewayUrl: z
      .url()
      .default("https://openapi-sandbox.dl.alipaydev.com/gateway.do"),
    keyType: z.enum(["PKCS8", "PKCS1"]).default("PKCS8"),
    storeId: z.string().min(1).max(32).optional(),
    terminalId: z.string().min(1).max(32).optional(),
  })
  .extend(paymentCodeRuntimeConfigSchema.shape)
  .strict();

export const alipaySensitiveConfigSchema = z.object({
  privateKeyPem: z.string().min(1).optional(),
  appCertPem: z.string().min(1).optional(),
  alipayPublicCertPem: z.string().min(1).optional(),
  alipayRootCertPem: z.string().min(1).optional(),
});

const wechatPayPublicConfigPatchSchema = paymentTimingConfigPatchSchema
  .extend({
    mode: z.literal("direct_merchant").optional(),
    merchantCertificateSerialNo: z.string().min(1).max(128).optional(),
    certificateSerialNo: z.string().min(1).max(128).optional(),
    platformCertificateSerialNo: z.string().min(1).max(128).optional(),
    paymentCodeSignType: z.enum(["MD5", "HMAC-SHA256"]).optional(),
    paymentCodeDeviceInfo: z.string().min(1).max(32).optional(),
  })
  .extend(paymentCodeRuntimeConfigSchema.shape)
  .strict();

const alipayPublicConfigPatchSchema = paymentTimingConfigPatchSchema
  .extend({
    mode: z.enum(["sandbox", "production"]).optional(),
    gatewayUrl: z.url().optional(),
    keyType: z.enum(["PKCS8", "PKCS1"]).optional(),
    storeId: z.string().min(1).max(32).optional(),
    terminalId: z.string().min(1).max(32).optional(),
  })
  .extend(paymentCodeRuntimeConfigSchema.shape)
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
      const pub = z
        .record(z.string(), z.unknown())
        .parse(value.publicConfigJson ?? {});
      const sensitive = z
        .record(z.string(), z.unknown())
        .parse(value.sensitiveConfigJson ?? {});

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

export const paymentWebhookAttemptListQuerySchema =
  paymentWebhookAttemptQuerySchema.extend(pageQuerySchema.shape);

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

export const paymentReconciliationAttemptListQuerySchema =
  paymentReconciliationAttemptQuerySchema.extend(pageQuerySchema.shape);

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

export const refundListQuerySchema = refundQuerySchema.extend(
  pageQuerySchema.shape,
);

export const paymentCodeAttemptQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  paymentNo: z.string().max(64).optional(),
  providerCode: z.enum(["wechat_pay", "alipay"]).optional(),
  status: paymentCodeAttemptStatusSchema.optional(),
  manualOnly: z.coerce.boolean().optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const paymentCodeAttemptListQuerySchema =
  paymentCodeAttemptQuerySchema.extend(pageQuerySchema.shape);

export const paymentAdminResponseSchema = z.strictObject({
  id: z.uuid(),
  paymentNo: z.string().min(1).max(64),
  orderId: z.uuid(),
  orderNo: z.string().min(1).max(64),
  providerCode: z.string().min(1).max(64),
  method: z.string().min(1).max(64),
  status: paymentStatusSchema,
  amountCents: z.int().nonnegative(),
  isDrill: z.boolean().optional(),
  isTest: z.boolean().optional(),
  scenario: z.string().nullable().optional(),
  paymentUrl: z.string().nullable().optional(),
  expiresAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
  failedReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const paymentAdminPageResponseSchema = createPageResultSchema(
  paymentAdminResponseSchema,
);

export const paymentProviderListResponseSchema = z.array(paymentProviderSchema);

export const paymentProviderConfigListResponseSchema = z.array(
  paymentProviderConfigSchema,
);

export const paymentProviderNotifyUrlCheckListResponseSchema = z.array(
  paymentProviderNotifyUrlCheckSchema,
);

export const paymentEventAdminResponseSchema = z.strictObject({
  id: z.uuid(),
  paymentId: z.uuid(),
  paymentNo: z.string().min(1).max(64),
  orderId: z.uuid(),
  orderNo: z.string().min(1).max(64),
  providerId: z.uuid(),
  providerCode: z.string().min(1).max(64),
  eventType: z.string().min(1).max(128),
  providerEventId: z.string().max(128).nullable(),
  signatureValid: z.boolean().nullable(),
  handledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const paymentEventAdminPageResponseSchema = createPageResultSchema(
  paymentEventAdminResponseSchema,
);

export const paymentWebhookAttemptAdminResponseSchema = z.strictObject({
  id: z.uuid(),
  orderId: z.uuid().nullable(),
  providerCode: z.string().max(64).nullable(),
  eventKind: z.enum(["payment", "refund", "unknown"]),
  eventType: z.string().max(128).nullable(),
  paymentNo: z.string().max(64).nullable(),
  refundNo: z.string().max(64).nullable(),
  orderNo: z.string().max(64).nullable(),
  signatureValid: z.boolean().nullable(),
  businessValid: z.boolean().nullable(),
  handled: z.boolean(),
  duplicate: z.boolean(),
  failureReason: z.string().max(128).nullable(),
  remoteIp: z.string().max(128).nullable(),
  httpStatus: z.int().nullable(),
  createdAt: z.iso.datetime(),
});

export const paymentWebhookAttemptAdminPageResponseSchema =
  createPageResultSchema(paymentWebhookAttemptAdminResponseSchema);

export const paymentReconciliationAttemptAdminResponseSchema = z.strictObject({
  id: z.uuid(),
  paymentId: z.uuid(),
  orderId: z.uuid(),
  orderNo: z.string().min(1).max(64),
  paymentNo: z.string().min(1).max(64),
  providerCode: z.string().min(1).max(64),
  trigger: z.string().min(1).max(64),
  attemptNo: z.int().positive(),
  status: z.string().min(1).max(64),
  providerPaymentStatus: z.string().max(64).nullable(),
  errorCode: z.string().max(128).nullable(),
  errorMessage: z.string().nullable(),
  nextRetryAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const paymentReconciliationAttemptAdminPageResponseSchema =
  createPageResultSchema(paymentReconciliationAttemptAdminResponseSchema);

export const refundReconciliationAttemptAdminResponseSchema = z.strictObject({
  trigger: z.string().min(1).max(64),
  attemptNo: z.int().positive(),
  status: z.string().min(1).max(64),
  providerRefundStatus: z.string().max(64).nullable(),
  providerRefundNo: z.string().max(128).nullable(),
  errorCode: z.string().max(128).nullable(),
  errorMessage: z.string().nullable(),
  nextRetryAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const refundAdminResponseSchema = z.strictObject({
  id: z.uuid(),
  refundNo: z.string().min(1).max(64),
  paymentId: z.uuid(),
  orderId: z.uuid(),
  paymentNo: z.string().min(1).max(64),
  orderNo: z.string().min(1).max(64),
  providerCode: z.string().min(1).max(64),
  status: refundStatusSchema,
  amountCents: z.int().nonnegative(),
  isDrill: z.boolean().optional(),
  isTest: z.boolean().optional(),
  scenario: z.string().nullable().optional(),
  reason: z.string().min(1).max(1000),
  providerRefundNo: z.string().max(128).nullable(),
  refundedAt: z.iso.datetime().nullable(),
  latestReconciliationStatus: z.string().max(64).nullable(),
  latestProviderRefundStatus: z.string().max(64).nullable(),
  latestReconciliationError: z.string().nullable(),
  latestReconciliationAt: z.iso.datetime().nullable(),
  reconciliationAttempts: z.array(
    refundReconciliationAttemptAdminResponseSchema,
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const refundAdminPageResponseSchema = createPageResultSchema(
  refundAdminResponseSchema,
);

export const paymentCodeAttemptAdminActionSchema = z.object({
  reason: z.string().trim().min(1).max(256),
});

export const paymentOperatorReasonSchema = paymentCodeAttemptAdminActionSchema;

export const paymentAdminActionResultSchema = z.strictObject({
  status: z.string().min(1).max(64),
  reconciled: z.boolean(),
  reason: z.string().min(1).max(128).optional(),
});

export const paymentIncidentActionNameSchema = z.enum([
  "query_payment",
  "close_or_reverse_uncertain_payment",
  "query_refund",
  "request_refund_handling",
  "mark_manual_handling",
]);

const paymentIncidentBaseActionRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});

export const paymentIncidentActionRequestSchema = z.discriminatedUnion(
  "action",
  [
    paymentIncidentBaseActionRequestSchema.extend({
      action: z.literal("query_payment"),
    }),
    paymentIncidentBaseActionRequestSchema.extend({
      action: z.literal("close_or_reverse_uncertain_payment"),
    }),
    paymentIncidentBaseActionRequestSchema.extend({
      action: z.literal("query_refund"),
      refundId: z.uuid(),
    }),
    paymentIncidentBaseActionRequestSchema.extend({
      action: z.literal("request_refund_handling"),
    }),
    paymentIncidentBaseActionRequestSchema.extend({
      action: z.literal("mark_manual_handling"),
    }),
  ],
);

export const paymentIncidentActionResponseSchema = z.strictObject({
  action: paymentIncidentActionNameSchema,
  status: z.string().min(1).max(64),
  handled: z.boolean(),
  message: z.string().min(1).max(200),
  protectedDiagnostics: z.record(z.string(), z.unknown()).default({}),
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

export const paymentCodeAttemptAdminPageResponseSchema = createPageResultSchema(
  paymentCodeAttemptAdminResponseSchema,
);

export type PaymentAdminResponse = z.infer<typeof paymentAdminResponseSchema>;
export type PaymentAdminPageResponse = z.infer<
  typeof paymentAdminPageResponseSchema
>;
export type PaymentProviderResponse = z.infer<typeof paymentProviderSchema>;
export type PaymentProviderConfigResponse = z.infer<
  typeof paymentProviderConfigSchema
>;
export type PaymentProviderNotifyUrlCheckResponse = z.infer<
  typeof paymentProviderNotifyUrlCheckSchema
>;
export type PaymentEventAdminResponse = z.infer<
  typeof paymentEventAdminResponseSchema
>;
export type PaymentWebhookAttemptAdminResponse = z.infer<
  typeof paymentWebhookAttemptAdminResponseSchema
>;
export type PaymentReconciliationAttemptAdminResponse = z.infer<
  typeof paymentReconciliationAttemptAdminResponseSchema
>;
export type RefundReconciliationAttemptAdminResponse = z.infer<
  typeof refundReconciliationAttemptAdminResponseSchema
>;
export type RefundAdminResponse = z.infer<typeof refundAdminResponseSchema>;
export type PaymentCodeAttemptAdminResponse = z.infer<
  typeof paymentCodeAttemptAdminResponseSchema
>;
export type PaymentIncidentActionName = z.infer<
  typeof paymentIncidentActionNameSchema
>;
export type PaymentIncidentActionRequest = z.infer<
  typeof paymentIncidentActionRequestSchema
>;
export type PaymentIncidentActionResponse = z.infer<
  typeof paymentIncidentActionResponseSchema
>;

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
