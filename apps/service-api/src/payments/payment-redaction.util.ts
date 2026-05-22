import { createHash } from "crypto";

type JsonObject = Record<string, unknown>;

// Constants for retention and excerpt settings
export const WEBHOOK_RETENTION_DAYS = 180;
export const WEBHOOK_EXCERPT_BYTES = 2048;
export const RECONCILE_MAX_ATTEMPTS = 8;
export const REFUND_RECONCILE_MAX_ATTEMPTS = 12;

// Sensitive key patterns that should be masked
const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /key/i,
  /secret/i,
  /certificate/i,
  /privateKey/i,
  /private_key/i,
  /sign(?!ature_valid)/i,
  /pem/i,
  /password/i,
  /passwd/i,
];

// Headers that are safe to keep (whitelist)
const SAFE_HEADER_KEYS = new Set([
  "content-type",
  "content-length",
  "wechatpay-serial",
  "wechatpay-timestamp",
  "wechatpay-nonce",
  "x-forwarded-for",
  "user-agent",
]);

// Headers that should be hashed (not dropped, not kept as-is)
const HASH_HEADER_KEYS = new Set(["wechatpay-signature"]);

/**
 * Compute SHA-256 hash of a string.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Compute SHA-256 hash of a buffer or string for raw body.
 */
export function rawBodySha256(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Build a redacted summary of headers.
 * - Whitelisted headers: kept as-is
 * - Hash-only headers: value replaced with sha256(value) prefix
 * - All others: dropped
 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(headers)) {
    const lkey = key.toLowerCase();
    if (SAFE_HEADER_KEYS.has(lkey)) {
      result[lkey] = Array.isArray(value) ? value.join(", ") : (value ?? null);
    } else if (HASH_HEADER_KEYS.has(lkey)) {
      const raw = Array.isArray(value) ? value.join("") : (value ?? "");
      result[lkey] = `sha256:${sha256Hex(raw).slice(0, 16)}...`;
    }
  }
  return result;
}

/**
 * Compute a hash of the headers summary (used for dedup / audit).
 */
export function headersHash(
  headers: Record<string, string | string[] | undefined>,
): string {
  const summary = redactHeaders(headers);
  return sha256Hex(JSON.stringify(summary));
}

/**
 * Check if a key looks sensitive.
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Redact a JSON object: mask sensitive fields.
 */
export function redactPayload(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (typeof obj === "number" || typeof obj === "boolean") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactPayload(item));
  }
  if (typeof obj === "object") {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      obj as JsonObject,
    )) {
      if (isSensitiveKey(key)) {
        if (typeof value === "string" && value.length > 0) {
          result[key] = `[REDACTED:${value.length}chars]`;
        } else {
          result[key] = "[REDACTED]";
        }
      } else {
        result[key] = redactPayload(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Get a truncated, redacted excerpt of the raw body text.
 * Max WEBHOOK_EXCERPT_BYTES characters, redacted sensitive fields if JSON.
 * Also supports URL-encoded form data.
 */
function tryParseUrlEncoded(input: string): JsonObject | null {
  if (!input.includes("=")) return null;
  const params = new URLSearchParams(input);
  const entries = [...params.entries()];
  if (entries.length === 0) return null;
  const result: JsonObject = {};
  for (const [key, value] of entries) {
    const existing = result[key];
    if (existing === undefined) {
      result[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      result[key] = [existing, value];
    }
  }
  return result;
}

export function buildRawBodyExcerpt(rawBodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBodyText);
    return JSON.stringify(redactPayload(parsed)).slice(
      0,
      WEBHOOK_EXCERPT_BYTES,
    );
  } catch {
    const parsedForm = tryParseUrlEncoded(rawBodyText);
    if (parsedForm) {
      return JSON.stringify(redactPayload(parsedForm)).slice(
        0,
        WEBHOOK_EXCERPT_BYTES,
      );
    }
    return rawBodyText.slice(0, WEBHOOK_EXCERPT_BYTES);
  }
}

export function buildStoredEventPayload(payload: unknown): JsonObject {
  const serialized = JSON.stringify(payload ?? {});
  return {
    payloadSha256: sha256Hex(serialized),
    payloadExcerpt: buildRawBodyExcerpt(serialized),
    redactedPayload: buildRedactedPayload(payload) ?? {},
  };
}

/**
 * Build a redacted JSON payload for storage from the parsed body.
 */
export function buildRedactedPayload(body: unknown): JsonObject | null {
  if (body === null || body === undefined) return null;
  try {
    const redacted = redactPayload(body);
    if (
      typeof redacted === "object" &&
      redacted !== null &&
      !Array.isArray(redacted)
    ) {
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return redacted as JsonObject;
    }
    return { _value: redacted };
  } catch {
    return null;
  }
}

/**
 * Calculate retention until date (default 180 days from now).
 */
export function retentionUntil(now = new Date()): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + WEBHOOK_RETENTION_DAYS);
  return d;
}

/**
 * Calculate backoff nextRetryAt for payment reconciliation.
 * attempt 1: +1min, 2: +2min, 3: +5min, 4: +10min, 5+: +30min
 */
export function reconcileBackoffMs(attemptNo: number): number {
  if (attemptNo <= 1) return 60_000;
  if (attemptNo === 2) return 2 * 60_000;
  if (attemptNo === 3) return 5 * 60_000;
  if (attemptNo === 4) return 10 * 60_000;
  return 30 * 60_000;
}

/**
 * Calculate backoff nextRetryAt for refund reconciliation.
 * attempt 1: +2min, 2: +5min, 3: +15min, 4+: +30min
 */
export function refundReconcileBackoffMs(attemptNo: number): number {
  if (attemptNo <= 1) return 2 * 60_000;
  if (attemptNo === 2) return 5 * 60_000;
  if (attemptNo === 3) return 15 * 60_000;
  return 30 * 60_000;
}
