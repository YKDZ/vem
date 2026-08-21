const SENSITIVE_KEY_SOURCE = String.raw`(?:[A-Za-z0-9_-]*(?:token|secret|password|credential|private[_-]?key|api[_-]?key)[A-Za-z0-9_-]*|database[_-]?url|connection[_-]?string|dsn|request[_-]?body|response[_-]?body)`;

const JSON_STRING_VALUE = new RegExp(
  `("(?:${SENSITIVE_KEY_SOURCE})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  "gi",
);
const SINGLE_QUOTED_VALUE = new RegExp(
  `('(?:${SENSITIVE_KEY_SOURCE})'\\s*:\\s*)'(?:\\\\.|[^'\\\\])*'`,
  "gi",
);
const UNTERMINATED_JSON_STRING_VALUE = new RegExp(
  `("(?:${SENSITIVE_KEY_SOURCE})"\\s*:\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*(?=\\r?$)`,
  "gim",
);
const UNTERMINATED_SINGLE_QUOTED_JSON_VALUE = new RegExp(
  `('(?:${SENSITIVE_KEY_SOURCE})'\\s*:\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*(?=\\r?$)`,
  "gim",
);
const UNTERMINATED_ASSIGNED_DOUBLE_VALUE = new RegExp(
  `\\b(${SENSITIVE_KEY_SOURCE}\\s*[=:]\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*(?=\\r?$)`,
  "gim",
);
const UNTERMINATED_ASSIGNED_SINGLE_VALUE = new RegExp(
  `\\b(${SENSITIVE_KEY_SOURCE}\\s*[=:]\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*(?=\\r?$)`,
  "gim",
);
const ASSIGNED_VALUE = new RegExp(
  `\\b(${SENSITIVE_KEY_SOURCE}\\s*[=:]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;&]+)`,
  "gi",
);
const QUERY_VALUE = new RegExp(`([?&]${SENSITIVE_KEY_SOURCE}=)[^&#\\s]+`, "gi");

export function isSensitiveEvidenceKey(key: unknown): boolean {
  const normalized = String(key ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("privatekey") ||
    normalized.includes("apikey") ||
    [
      "authorization",
      "proxyauthorization",
      "cookie",
      "setcookie",
      "databaseurl",
      "connectionstring",
      "dsn",
      "header",
      "headers",
      "requestbody",
      "responsebody",
      "body",
    ].includes(normalized)
  );
}

/**
 * 对进入失败证据 JSON 的普通对象递归脱敏，并保留原有业务字段形状。
 */
export function sanitizeSensitiveEvidenceValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") return redactSensitiveEvidenceText(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 16) return "[bounded]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        sanitizeSensitiveEvidenceValue(entry, depth + 1, seen),
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveEvidenceKey(key)
          ? "[REDACTED]"
          : sanitizeSensitiveEvidenceValue(entry, depth + 1, seen),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

/**
 * 对将进入 host-local 失败证据的纯文本做统一、轻量脱敏。
 * 这只是落盘边界的替换器，不承担凭据治理或业务日志解析职责。
 */
export function redactSensitiveEvidenceText(
  value: unknown,
  maxChars: number | null = null,
): string {
  const text = String(value ?? "");
  const bounded =
    Number.isInteger(maxChars) && (maxChars as number) >= 0
      ? text.slice(0, maxChars as number)
      : text;
  return bounded
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi,
      "$1: [REDACTED]",
    )
    .replace(UNTERMINATED_JSON_STRING_VALUE, '$1"[REDACTED]"')
    .replace(UNTERMINATED_SINGLE_QUOTED_JSON_VALUE, "$1'[REDACTED]'")
    .replace(UNTERMINATED_ASSIGNED_DOUBLE_VALUE, '$1"[REDACTED]"')
    .replace(UNTERMINATED_ASSIGNED_SINGLE_VALUE, "$1'[REDACTED]'")
    .replace(JSON_STRING_VALUE, '$1"[REDACTED]"')
    .replace(SINGLE_QUOTED_VALUE, "$1'[REDACTED]'")
    .replace(ASSIGNED_VALUE, "$1[REDACTED]")
    .replace(QUERY_VALUE, "$1[REDACTED]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
}
