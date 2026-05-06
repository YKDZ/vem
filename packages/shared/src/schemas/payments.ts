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

export const paymentProviderConfigSchema = z.object({
  providerCode: z.string().min(1).max(64),
  type: paymentProviderTypeSchema,
  status: paymentProviderStatusSchema,
  merchantNo: z.string().max(128).optional(),
  appId: z.string().max(128).optional(),
  publicConfigJson: z.record(z.string(), z.unknown()).default({}),
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

export const paymentProviderConfigSecretStatusSchema = z.record(
  z.string(),
  z.object({ configured: z.boolean(), updatedAt: z.iso.datetime().nullable() }),
);

export const upsertPaymentProviderConfigSchema = z.object({
  providerCode: z.string().min(1).max(64),
  machineId: z.uuid().nullable().optional(),
  merchantNo: z.string().max(128).nullable().optional(),
  appId: z.string().max(128).nullable().optional(),
  publicConfigJson: z.record(z.string(), z.unknown()).optional(),
  sensitiveConfigJson: paymentProviderSensitiveConfigSchema.optional(),
  status: paymentProviderStatusSchema.optional(),
});

export type UpsertPaymentProviderConfigInput = z.infer<
  typeof upsertPaymentProviderConfigSchema
>;
