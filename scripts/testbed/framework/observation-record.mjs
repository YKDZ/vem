const OBSERVATION_SCHEMA = "vem-runtime-testbed-observation-line/v1";

function canonical(value) {
  return JSON.stringify(value ?? null);
}

function requireString(value, label) {
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
}) {
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
export function summarizeAssertions(assertions) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new TypeError("assertions must be a non-empty array");
  }
  const failed = assertions.find((assertion) => assertion?.status === "failed");
  const skipped = assertions.every((assertion) => assertion?.status === "skipped");
  return {
    status: failed ? "failed" : skipped ? "skipped" : "passed",
    primaryFailure: failed ?? null,
    assertionCount: assertions.length,
  };
}

/**
 * 观测行序列化：每条观测一行稳定 JSON，失败根因可流式上卷。
 */
export function serializeObservation(observation) {
  const line = JSON.stringify({
    schemaVersion: OBSERVATION_SCHEMA,
    at: new Date().toISOString(),
    ...observation,
  });
  return `${line}\n`;
}

export async function deserializeObservation(line) {
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
  const lines = [];
  return {
    append(observation) {
      lines.push(serializeObservation(observation));
    },
    lines() {
      return [...lines];
    },
    clear() {
      lines.length = 0;
    },
  };
}
