import {
  createMachineOrderSchema,
  machineOrderStatusResponseSchema,
  machinePaymentOptionsResponseSchema,
  paymentCodeSubmitResponseSchema,
  paymentCodeSubmitSchema,
} from "@vem/shared";

import {
  createMachineOrderResponseSchema,
  type CreateMachineOrderInput,
  type CreateMachineOrderResponse,
  type MachineOrderStatus,
  type MachinePaymentOptionsResponse,
  type PaymentCodeSubmitInput,
  type PaymentCodeSubmitResponse,
} from "@/types/checkout";

import type { MachineApiClient } from "./request";

export async function getMachinePaymentOptions(
  client: MachineApiClient,
): Promise<MachinePaymentOptionsResponse> {
  const response = await client.get<unknown>("/machine-orders/payment-options");
  return machinePaymentOptionsResponseSchema.parse(response);
}

export async function createMachineOrder(
  client: MachineApiClient,
  input: CreateMachineOrderInput,
): Promise<CreateMachineOrderResponse> {
  const body = createMachineOrderSchema.parse(input);
  const response = await client.post<unknown, CreateMachineOrderInput>(
    "/machine-orders",
    body,
  );
  return createMachineOrderResponseSchema.parse(response);
}

export async function getMachineOrderStatus(
  client: MachineApiClient,
  input: { orderNo: string; machineCode: string },
): Promise<MachineOrderStatus> {
  const response = await client.get<unknown>(
    `/machine-orders/${encodeURIComponent(input.orderNo)}/status`,
    { params: { machineCode: input.machineCode } },
  );
  return machineOrderStatusResponseSchema.parse(response);
}

export async function submitPaymentCode(
  client: MachineApiClient,
  orderNo: string,
  input: PaymentCodeSubmitInput,
): Promise<PaymentCodeSubmitResponse> {
  const body = paymentCodeSubmitSchema.parse(input);
  const response = await client.post<unknown, PaymentCodeSubmitInput>(
    `/machine-orders/${encodeURIComponent(orderNo)}/payment-code/submit`,
    body,
  );
  return paymentCodeSubmitResponseSchema.parse(response);
}
