import { z } from "zod";

import { defineAdminEndpointContract } from "../admin-api-contract";
import { vendingCommandStatusSchema } from "../enums/vending";
import { manualDispenseResolutionSchema } from "./mqtt";
import { createPageResultSchema, pageQuerySchema } from "./pagination";

const noPathParamsSchema = z.strictObject({});
const noQuerySchema = z.strictObject({});

export const vendingCommandItemResponseSchema = z.strictObject({
  id: z.uuid(),
  commandNo: z.string().min(1).max(64),
  orderId: z.uuid(),
  machineId: z.uuid(),
  machineCode: z.string().min(1).max(64),
  slotId: z.uuid(),
  orderItemId: z.uuid().nullable(),
  status: vendingCommandStatusSchema,
  retryCount: z.int().nonnegative(),
  sentAt: z.iso.datetime().nullable(),
  ackAt: z.iso.datetime().nullable(),
  resultAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const vendingCommandPageResponseSchema = createPageResultSchema(
  vendingCommandItemResponseSchema,
);

export const manualDispenseResolveResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      commandId: z.uuid(),
      status: z.literal("succeeded"),
      stockMovementStatus: z.enum(["accepted", "already_accepted"]),
    }),
    z.strictObject({
      commandId: z.uuid(),
      status: z.literal("failed"),
    }),
  ],
);

export const adminListVendingCommandsContract = defineAdminEndpointContract({
  method: "GET",
  path: "/vending-commands",
  pathParamsSchema: noPathParamsSchema,
  querySchema: pageQuerySchema,
  bodySchema: z.strictObject({}),
  responseSchema: vendingCommandPageResponseSchema,
});

export const adminResolveVendingCommandContract = defineAdminEndpointContract({
  method: "POST",
  path: "/vending-commands/:id/resolve",
  pathParamsSchema: z.strictObject({ id: z.uuid() }),
  querySchema: noQuerySchema,
  bodySchema: manualDispenseResolutionSchema,
  responseSchema: manualDispenseResolveResponseSchema,
});

export type VendingCommandItemResponse = z.infer<
  typeof vendingCommandItemResponseSchema
>;
export type VendingCommandPageResponse = z.infer<
  typeof vendingCommandPageResponseSchema
>;
