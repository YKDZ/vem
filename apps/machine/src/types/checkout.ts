import {
  createMachineOrderSchema,
  machineOrderStatusResponseSchema,
  paymentCodeSubmitResponseSchema,
  paymentCodeSubmitSchema,
  type MachineOrderStatusNextAction,
  type MachinePaymentOption,
  type MachinePaymentOptionKey,
  type MachinePaymentOptionsResponse,
  type MachinePaymentProviderCode,
} from "@vem/shared";
import { z } from "zod";

import type { MachineCatalogItem } from "./catalog";

export const createMachineOrderResponseSchema = z.object({
  orderId: z.uuid(),
  orderNo: z.string().min(1),
  paymentNo: z.string().min(1),
  paymentUrl: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  totalAmountCents: z.int().nonnegative(),
  paymentProviderCode: z
    .enum(["mock", "wechat_pay", "alipay"])
    .nullable()
    .optional(),
});

export type CreateMachineOrderInput = z.infer<typeof createMachineOrderSchema>;
export type CreateMachineOrderResponse = z.infer<
  typeof createMachineOrderResponseSchema
>;
export type MachineOrderStatus = z.infer<
  typeof machineOrderStatusResponseSchema
>;
export type PaymentCodeSubmitInput = z.infer<typeof paymentCodeSubmitSchema>;
export type PaymentCodeSubmitResponse = z.infer<
  typeof paymentCodeSubmitResponseSchema
>;
export type CheckoutSelectedItem = MachineCatalogItem;

export type CheckoutResultKind = Extract<
  MachineOrderStatusNextAction,
  | "success"
  | "payment_failed"
  | "payment_expired"
  | "dispense_failed"
  | "refund_pending"
  | "refunded"
  | "manual_handling"
  | "closed"
>;

export type {
  MachinePaymentOption,
  MachinePaymentOptionKey,
  MachinePaymentOptionsResponse,
  MachinePaymentProviderCode,
};
