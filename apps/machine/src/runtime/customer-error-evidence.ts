import {
  recordCustomerErrorEvidence as persistCustomerErrorEvidence,
  type TechnicalErrorEvidence,
} from "@/local/command-log";

import type { MachineRuntimeTrace } from "./machine-runtime-trace";

let installedTrace: MachineRuntimeTrace | null = null;

const TECHNICAL_MESSAGE_LIMIT = 512;
const TECHNICAL_RESPONSE_BODY_LIMIT = 2_048;
const TECHNICAL_CODE_LIMIT = 128;
const TRY_ON_CORRELATION_LIMIT = 128;

export function installCustomerErrorEvidenceTrace(
  trace: MachineRuntimeTrace | null,
): void {
  installedTrace = trace;
}

export function recordCustomerErrorEvidence(input: {
  stage: string;
  customerMessage: string;
  technicalError: unknown;
  operation: string;
  checkoutAttemptIdempotencyKey: string | null;
  orderId: string | null;
  paymentId: string | null;
  orderNo: string | null;
  tryOnSessionId?: string | null;
  tryOnCatalogKey?: string | null;
  tryOnVariantId?: string | null;
}): void {
  const {
    technicalError,
    tryOnSessionId,
    tryOnCatalogKey,
    tryOnVariantId,
    ...evidence
  } = input;
  const technical = serializeTechnicalError(technicalError);
  const record = {
    ...evidence,
    technical,
    tryOnSessionId: boundedText(tryOnSessionId, TRY_ON_CORRELATION_LIMIT),
    tryOnCatalogKey: boundedText(tryOnCatalogKey, TRY_ON_CORRELATION_LIMIT),
    tryOnVariantId: boundedText(tryOnVariantId, TRY_ON_CORRELATION_LIMIT),
  };
  try {
    installedTrace?.record({ type: "customer_error", ...record });
  } catch {
    // Runtime evidence is observational and must not alter customer control flow.
  }
  try {
    persistCustomerErrorEvidence(record);
  } catch {
    // localStorage is diagnostic-only and can be unavailable or quota-limited.
  }
}

export function serializeTechnicalError(
  error: unknown,
): TechnicalErrorEvidence {
  const record = isRecord(error) ? error : null;
  return {
    name: boundedText(
      error instanceof Error ? error.name : record?.name,
      TECHNICAL_CODE_LIMIT,
    ),
    message:
      boundedText(
        error instanceof Error ? error.message : (record?.message ?? error),
        TECHNICAL_MESSAGE_LIMIT,
      ) ?? "unknown error",
    statusCode: integerField(record?.statusCode),
    responseCode: boundedText(record?.responseCode, TECHNICAL_CODE_LIMIT),
    responseBody: boundedText(
      record?.responseBody,
      TECHNICAL_RESPONSE_BODY_LIMIT,
    ),
    cause: boundedText(record?.cause, TECHNICAL_MESSAGE_LIMIT),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integerField(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function boundedText(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (value instanceof Error) {
    text = value.message;
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      text = "unserializable value";
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
