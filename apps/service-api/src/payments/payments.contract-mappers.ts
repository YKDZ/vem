import type {
  UpsertPaymentProviderConfigInput,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
} from "@vem/shared";
import type { z } from "zod";

import {
  paymentEvents,
  paymentProviderConfigs,
  paymentProviders,
  paymentReconciliationAttempts,
} from "@vem/db";

type PaymentProviderUpdate = Partial<typeof paymentProviders.$inferInsert>;
type PaymentProviderConfigInsert = typeof paymentProviderConfigs.$inferInsert;
type PaymentProviderConfigUpdate = Partial<
  typeof paymentProviderConfigs.$inferInsert
>;
type PaymentEventInsert = typeof paymentEvents.$inferInsert;
type PaymentReconciliationAttemptInsert =
  typeof paymentReconciliationAttempts.$inferInsert;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;
type UpdatePaymentProviderInput = z.infer<typeof updatePaymentProviderSchema>;
type UpdatePaymentProviderConfigInput = z.infer<
  typeof updatePaymentProviderConfigSchema
>;

function hasOwnField<T extends object>(
  input: T,
  key: PropertyKey,
): key is keyof T {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function mapPaymentProviderDtoToPatch(
  input: UpdatePaymentProviderInput,
): PaymentProviderUpdate {
  const dto = {
    name: input.name,
    status: input.status,
    capabilities: input.capabilities,
  } satisfies ContractFieldCoverage<UpdatePaymentProviderInput>;

  const patch: PaymentProviderUpdate = {
    updatedAt: new Date(),
  };
  if (dto.name !== undefined) patch.name = dto.name;
  if (dto.status !== undefined) patch.status = dto.status;
  if (dto.capabilities !== undefined) patch.capabilities = dto.capabilities;
  return patch;
}

export function mapPaymentProviderConfigUpdateDtoToPatch(
  adminUserId: string,
  input: UpdatePaymentProviderConfigInput,
  context: {
    publicConfigJson: Record<string, unknown>;
    normalizedPublicConfigJson?: Record<string, unknown>;
  },
): PaymentProviderConfigUpdate {
  const dto = {
    merchantNo: input.merchantNo,
    appId: input.appId,
    publicConfigJson: input.publicConfigJson,
    status: input.status,
  } satisfies ContractFieldCoverage<UpdatePaymentProviderConfigInput>;

  const patch: PaymentProviderConfigUpdate = {
    updatedByAdminUserId: adminUserId,
    updatedAt: new Date(),
  };
  if (dto.merchantNo !== undefined) patch.merchantNo = dto.merchantNo;
  if (dto.appId !== undefined) patch.appId = dto.appId;
  if (dto.publicConfigJson !== undefined) {
    patch.publicConfigJson = context.normalizedPublicConfigJson ?? {
      ...context.publicConfigJson,
      ...dto.publicConfigJson,
    };
  }
  if (dto.status !== undefined) patch.status = dto.status;
  return patch;
}

export function mapPaymentProviderConfigUpsertDtoToInsert(
  providerId: string,
  adminUserId: string,
  input: UpsertPaymentProviderConfigInput,
  configEncryptedJson: Record<string, unknown>,
  publicConfigJson: Record<string, unknown> = input.publicConfigJson ?? {},
): PaymentProviderConfigInsert {
  const dto = {
    providerCode: input.providerCode,
    machineId: input.machineId,
    merchantNo: input.merchantNo,
    appId: input.appId,
    publicConfigJson: input.publicConfigJson,
    sensitiveConfigJson: input.sensitiveConfigJson,
    status: input.status,
  } satisfies ContractFieldCoverage<UpsertPaymentProviderConfigInput>;

  const insert = {
    providerId,
    machineId: dto.machineId ?? null,
    merchantNo: dto.merchantNo,
    appId: dto.appId,
    publicConfigJson,
    configEncryptedJson,
    status: dto.status,
    updatedByAdminUserId: adminUserId,
  } satisfies PaymentProviderConfigInsert;
  return insert;
}

export function mapPaymentProviderConfigUpsertDtoToPatch(
  adminUserId: string,
  input: UpsertPaymentProviderConfigInput,
  configEncryptedJson: Record<string, unknown>,
  publicConfigJson: Record<string, unknown>,
  existing: {
    merchantNo: string | null;
    appId: string | null;
    status: "enabled" | "disabled";
  },
): PaymentProviderConfigUpdate {
  const dto = {
    providerCode: input.providerCode,
    machineId: input.machineId,
    merchantNo: input.merchantNo,
    appId: input.appId,
    publicConfigJson: input.publicConfigJson,
    sensitiveConfigJson: input.sensitiveConfigJson,
    status: input.status,
  } satisfies ContractFieldCoverage<UpsertPaymentProviderConfigInput>;

  const patch = {
    merchantNo: hasOwnField(input, "merchantNo")
      ? dto.merchantNo
      : existing.merchantNo,
    appId: hasOwnField(input, "appId") ? dto.appId : existing.appId,
    publicConfigJson,
    configEncryptedJson,
    status: dto.status ?? existing.status,
    updatedByAdminUserId: adminUserId,
    updatedAt: new Date(),
  } satisfies PaymentProviderConfigUpdate;
  return patch;
}

export function mapMockPaymentEventToInsert(input: {
  paymentId: string;
  providerId: string;
  paymentNo: string;
  event: "succeed" | "fail";
  rawPayloadJson: Record<string, unknown>;
}): PaymentEventInsert {
  const insert = {
    paymentId: input.paymentId,
    providerId: input.providerId,
    eventType:
      input.event === "succeed"
        ? "mock.payment.succeeded"
        : "mock.payment.failed",
    providerEventId: `mock:${input.event}:${input.paymentNo}`,
    rawPayloadJson: input.rawPayloadJson,
    signatureValid: true,
    handledAt: new Date(),
  } satisfies PaymentEventInsert;
  return insert;
}

export function mapManualPaymentReconciliationAttemptToInsert(input: {
  paymentId: string;
  providerId: string;
  attemptNo: number;
  startedAt: Date;
}): PaymentReconciliationAttemptInsert {
  const insert = {
    paymentId: input.paymentId,
    providerId: input.providerId,
    trigger: "manual",
    attemptNo: input.attemptNo,
    status: "pending",
    startedAt: input.startedAt,
  } satisfies PaymentReconciliationAttemptInsert;
  return insert;
}
