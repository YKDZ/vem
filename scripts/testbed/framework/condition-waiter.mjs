import { setTimeout as sleep } from "node:timers/promises";

/**
 * 有界条件等待原语。
 *
 * 所有 VM 与 CDP 驱动都通过这个入口等待权威状态谓词，禁止各轨道复制自己的
 * 超时循环。超时错误始终携带最后一次观测值，宿主可以直接上卷而不需要再次埋点。
 */
export async function waitForCondition(
  name,
  predicate,
  {
    timeoutMs = 60_000,
    pollMs = 250,
    signal = undefined,
  } = {},
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError("pollMs must be a positive finite number");
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastObservation = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DOMException("condition wait aborted", "AbortError");
    }
    lastObservation = await predicate();
    if (lastObservation?.ok) return lastObservation.value;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  const durationMs = Date.now() - startedAt;
  throw new Error(
    `${name} did not become true in ${timeoutMs} ms (observed ${durationMs} ms): ${JSON.stringify(lastObservation?.value ?? null)}`,
  );
}

/**
 * 把旧的 predicate 结果形状统一为 `{ok, value}`。
 */
export function condition(ok, value = null) {
  return { ok: Boolean(ok), value };
}
