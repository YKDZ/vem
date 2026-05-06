import { z } from "zod";

import {
  paymentProviderStatusSchema,
  paymentProviderTypeSchema,
  paymentStatusSchema,
} from "../enums/payment-status";

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

export const updatePaymentProviderSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  status: paymentProviderStatusSchema.optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

export const updatePaymentProviderConfigSchema = z.object({
  merchantNo: z.string().max(128).nullable().optional(),
  appId: z.string().max(128).nullable().optional(),
  publicConfigJson: z.record(z.string(), z.unknown()).optional(),
  status: paymentProviderStatusSchema.optional(),
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

export const paymentProviderConfigScopeSchema = z.object({
  providerCode: z.enum(["wechat_pay", "alipay"]),
  machineId: z.uuid().nullable().optional(),
  status: paymentProviderStatusSchema.default("enabled"),
});

export const wechatPayPublicConfigSchema = paymentTimingConfigSchema.extend({
  mode: z.literal("direct_merchant").default("direct_merchant"),
  certificateSerialNo: z.string().min(1).max(128),
});

export const wechatPaySensitiveConfigSchema = z.object({
  apiV3Key: z.string().min(32).max(128).optional(),
  privateKeyPem: z.string().min(1).optional(),
  platformPublicKeyPem: z.string().min(1).optional(),
});

export const alipayPublicConfigSchema = paymentTimingConfigSchema.extend({
  mode: z.enum(["sandbox", "production"]).default("sandbox"),
  gatewayUrl: z.url().default("https://openapi-sandbox.dl.alipaydev.com/gateway.do"),
  keyType: z.enum(["PKCS8", "PKCS1"]).default("PKCS8"),
});

export const alipaySensitiveConfigSchema = z.object({
  privateKeyPem: z.string().min(1).optional(),
  appCertPem: z.string().min(1).optional(),
  alipayPublicCertPem: z.string().min(1).optional(),
  alipayRootCertPem: z.string().min(1).optional(),
});

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

export const paymentProviderNotifyUrlCheckSchema = z.object({
  providerCode: z.enum(["wechat_pay", "alipay"]),
  notifyUrl: z.url(),
  usesHttps: z.boolean(),
  isLocalhost: z.boolean(),
  pathMatchesWebhookRoute: z.boolean(),
  reachable: z.boolean(),
  statusCode: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});

export const upsertPaymentProviderConfigSchema = paymentProviderConfigScopeSchema
  .extend({
    merchantNo: z.string().max(128).nullable().optional(),
    appId: z.string().max(128).nullable().optional(),
    publicConfigJson: z.record(z.string(), z.unknown()).optional(),
    sensitiveConfigJson: paymentProviderSensitiveConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "disabled") return;
    const timing = value.publicConfigJson ?? {};
    const timingResult = paymentTimingConfigSchema.safeParse(timing);
    if (!timingResult.success) {
      ctx.addIssue({
        code: "custom",
        path: ["publicConfigJson"],
        message: "qrExpiresMinutes must be 1-60 and timeoutCompensationSeconds must be 0-600",
      });
    }
    if (value.providerCode === "wechat_pay") {
      const result = wechatPayPublicConfigSchema.partial().safeParse(value.publicConfigJson ?? {});
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["publicConfigJson"],
          message: "wechat_pay public config is invalid",
        });
      }
    }
    if (value.providerCode === "alipay") {
      const result = alipayPublicConfigSchema.partial().safeParse(value.publicConfigJson ?? {});
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          path: ["publicConfigJson"],
          message: "alipay public config is invalid",
        });
      }
    }
  });

export const paymentProviderConfigSchema = z.object({
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
