import { z } from "zod";

import { orderStatusSchema } from "../enums/order-status";
import {
  paymentCodeAttemptStatusSchema,
  paymentMethodSchema,
  paymentStatusSchema,
} from "../enums/payment-status";
import { vendingCommandStatusSchema } from "../enums/vending";

export const orderQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  machineId: z.uuid().optional(),
  status: orderStatusSchema.optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const machineOrderItemSchema = z.object({
  inventoryId: z.uuid(),
  quantity: z.int().positive(),
});

export const machinePaymentProviderCodeSchema = z.enum([
  "mock",
  "wechat_pay",
  "alipay",
]);

const realPaymentProviderCodes = new Set(["wechat_pay", "alipay"]);

export const createMachineOrderSchema = z
  .object({
    machineCode: z.string().min(1).max(64),
    items: z.array(machineOrderItemSchema).min(1).max(10),
    paymentMethod: paymentMethodSchema,
    paymentProviderCode: machinePaymentProviderCodeSchema.optional(),
    profileSnapshot: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.paymentMethod === "mock") {
      if (
        value.paymentProviderCode !== undefined &&
        value.paymentProviderCode !== "mock"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["paymentProviderCode"],
          message: "mock payment method can only use mock provider",
        });
      }
      return;
    }

    if (
      value.paymentMethod === "qr_code" ||
      value.paymentMethod === "payment_code"
    ) {
      if (
        value.paymentProviderCode === undefined ||
        !realPaymentProviderCodes.has(value.paymentProviderCode)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["paymentProviderCode"],
          message: `${value.paymentMethod} payment method requires alipay or wechat_pay provider`,
        });
      }
      return;
    }

    ctx.addIssue({
      code: "custom",
      path: ["paymentMethod"],
      message: `${value.paymentMethod} is not supported by machine order creation`,
    });
  });

export const machineOrderStatusQuerySchema = z.object({
  machineCode: z.string().min(1).max(64),
});

export const machineOrderStatusNextActionSchema = z.enum([
  "wait_payment",
  "dispensing",
  "success",
  "payment_failed",
  "payment_expired",
  "dispense_failed",
  "refund_pending",
  "refunded",
  "manual_handling",
  "closed",
]);

export const machinePaymentOptionKeySchema = z
  .string()
  .regex(
    /^(mock:mock|qr_code:(wechat_pay|alipay)|payment_code:(wechat_pay|alipay))$/,
  );

export const paymentCodeSourceSchema = z.enum([
  "serial_text",
  "tauri_scanner",
  "browser_test",
  "manual_dev",
]);

export const paymentCodeSubmitSchema = z.object({
  machineCode: z.string().min(1).max(64),
  authCode: z.string().trim().min(6).max(128),
  idempotencyKey: z.string().trim().min(8).max(128),
  source: paymentCodeSourceSchema,
  scannerHealth: z
    .object({
      online: z.boolean(),
      adapter: z.string().min(1).max(64),
      port: z.string().max(256).nullable().optional(),
      message: z.string().max(256).nullable().optional(),
    })
    .optional(),
});

export const paymentCodeSubmitResponseSchema = z.object({
  orderNo: z.string().min(1).max(64),
  paymentNo: z.string().min(1).max(64),
  attemptNo: z.int().positive(),
  status: paymentCodeAttemptStatusSchema,
  nextAction: machineOrderStatusNextActionSchema,
  message: z.string().min(1).max(256),
  canRetry: z.boolean(),
  serverTime: z.iso.datetime(),
});

export const machinePaymentOptionSchema = z.object({
  optionKey: machinePaymentOptionKeySchema,
  providerCode: machinePaymentProviderCodeSchema,
  method: paymentMethodSchema,
  displayName: z.string().min(1).max(32),
  description: z.string().min(1).max(128),
  icon: z.enum(["mock", "wechat", "alipay"]),
  recommended: z.boolean().default(false),
  disabled: z.boolean().default(false),
  disabledReason: z.string().max(128).nullable().default(null),
});

export const machinePaymentOptionsResponseSchema = z.object({
  options: z.array(machinePaymentOptionSchema),
  defaultOptionKey: machinePaymentOptionKeySchema.nullable(),
  defaultProviderCode: machinePaymentProviderCodeSchema.nullable(),
  serverTime: z.iso.datetime(),
});

export type MachinePaymentProviderCode = z.infer<
  typeof machinePaymentProviderCodeSchema
>;
export type MachinePaymentOptionKey = z.infer<
  typeof machinePaymentOptionKeySchema
>;
export type MachinePaymentOption = z.infer<typeof machinePaymentOptionSchema>;
export type MachinePaymentOptionsResponse = z.infer<
  typeof machinePaymentOptionsResponseSchema
>;

export const machineOrderStatusResponseSchema = z.object({
  orderId: z.uuid(),
  orderNo: z.string().min(1).max(64),
  machineCode: z.string().min(1).max(64),
  orderStatus: orderStatusSchema,
  totalAmountCents: z.int().nonnegative(),
  payment: z.object({
    paymentNo: z.string().min(1).max(64),
    method: paymentMethodSchema,
    status: paymentStatusSchema,
    paymentUrl: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    paidAt: z.iso.datetime().nullable(),
    failedReason: z.string().nullable(),
    providerCode: machinePaymentProviderCodeSchema.nullable(),
  }),
  paymentCodeAttempt: z
    .object({
      attemptNo: z.int().positive(),
      status: paymentCodeAttemptStatusSchema,
      maskedAuthCode: z.string().max(32).nullable(),
      source: paymentCodeSourceSchema.nullable(),
      idempotencyKey: z.string().max(128).nullable(),
      submittedAt: z.iso.datetime().nullable(),
      lastCheckedAt: z.iso.datetime().nullable(),
      canRetry: z.boolean(),
      message: z.string().max(256).nullable(),
    })
    .nullable(),
  vending: z
    .object({
      commandNo: z.string().min(1).max(64),
      status: vendingCommandStatusSchema,
      sentAt: z.iso.datetime().nullable(),
      ackAt: z.iso.datetime().nullable(),
      resultAt: z.iso.datetime().nullable(),
      lastError: z.string().nullable(),
    })
    .nullable(),
  refund: z
    .object({
      refundNo: z.string().min(1).max(64),
      status: z.enum([
        "created",
        "processing",
        "succeeded",
        "failed",
        "canceled",
      ]),
      amountCents: z.int().nonnegative(),
      reason: z.string(),
      refundedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  nextAction: machineOrderStatusNextActionSchema,
  serverTime: z.iso.datetime(),
});

export type MachineOrderStatusResponse = z.infer<
  typeof machineOrderStatusResponseSchema
>;
export type MachineOrderStatusNextAction = z.infer<
  typeof machineOrderStatusNextActionSchema
>;
export type PaymentCodeSubmitInput = z.infer<typeof paymentCodeSubmitSchema>;
export type PaymentCodeSubmitResponse = z.infer<
  typeof paymentCodeSubmitResponseSchema
>;
export type PaymentCodeSource = z.infer<typeof paymentCodeSourceSchema>;
