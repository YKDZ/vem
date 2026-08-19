const OBSERVATION_SCHEMA = "vem-runtime-testbed-observation-line/v1";

export interface BusinessAssertionRecord {
  schemaVersion: string;
  id: string;
  source: string;
  expected: unknown;
  observed: unknown;
  status: "passed" | "failed" | "skipped";
  reason: string | null;
}

export interface BusinessSetInput {
  name: string;
  assertions: BusinessAssertionRecord[];
  supportingEvidence?: unknown[];
}

export interface BusinessSetReport {
  name: string;
  status: "passed" | "failed" | "skipped";
  primaryFailure: BusinessAssertionRecord | null;
  assertionCount: number;
  supportingEvidence: unknown[];
}

export interface Observation {
  type: string;
  [key: string]: unknown;
}

function canonical(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * 一条业务断言：决定业务集成败的最小判定记录。
 */
export function businessAssertion({
  id,
  source,
  expected,
  observed,
  skipped = false,
}: {
  id: string;
  source: string;
  expected: unknown;
  observed: unknown;
  skipped?: boolean;
}): BusinessAssertionRecord {
  const record = {
    schemaVersion: "vem-runtime-testbed-business-assertion/v1",
    id: requireString(id, "assertion id"),
    source: requireString(source, "assertion source"),
    expected,
    observed,
  };
  if (skipped) {
    return { ...record, status: "skipped", reason: null };
  }
  const matches = canonical(expected) === canonical(observed);
  return {
    ...record,
    status: matches ? "passed" : "failed",
    reason: matches
      ? null
      : `expected ${canonical(expected)} observed ${canonical(observed)}`,
  };
}

/**
 * 汇总一个业务集内的断言，返回总体状态和第一条失败根因。
 */
export function summarizeAssertions(assertions: BusinessAssertionRecord[]): {
  status: "passed" | "failed" | "skipped";
  primaryFailure: BusinessAssertionRecord | null;
  assertionCount: number;
} {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new TypeError("assertions must be a non-empty array");
  }
  const failed = assertions.find((assertion) => assertion?.status === "failed");
  const skipped = assertions.every(
    (assertion) => assertion?.status === "skipped",
  );
  return {
    status: failed ? "failed" : skipped ? "skipped" : "passed",
    primaryFailure: failed ?? null,
    assertionCount: assertions.length,
  };
}

/**
 * 观测行序列化：每条观测一行稳定 JSON，失败根因可流式上卷。
 */
export function serializeObservation(observation: Observation): string {
  const line = JSON.stringify({
    schemaVersion: OBSERVATION_SCHEMA,
    at: new Date().toISOString(),
    ...observation,
  });
  return `${line}\n`;
}

export async function deserializeObservation(
  line: string,
): Promise<Observation> {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("invalid observation line: not JSON");
  }
  if (parsed?.schemaVersion !== OBSERVATION_SCHEMA) {
    throw new Error("invalid observation line: schema version mismatch");
  }
  if (typeof parsed.type !== "string" || parsed.type.length === 0) {
    throw new Error("invalid observation line: type is required");
  }
  return parsed;
}

/**
 * 内存观测流：追加观测并产生可上卷的 JSONL 文本。
 */
export function observationStream() {
  const lines: string[] = [];
  return {
    append(observation: Observation) {
      lines.push(serializeObservation(observation));
    },
    lines(): string[] {
      return [...lines];
    },
    clear() {
      lines.length = 0;
    },
  };
}
