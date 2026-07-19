import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export const DAEMON_READY_PATH =
  "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json";

function readReadyFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validReady(value) {
  return (
    typeof value?.healthzUrl === "string" &&
    value.healthzUrl.endsWith("/healthz") &&
    typeof value?.ipcToken === "string" &&
    value.ipcToken.length > 0 &&
    typeof value?.generation === "string" &&
    value.generation.length > 0
  );
}

export async function waitForDaemonReadyRefresh(
  handoff,
  {
    timeoutMs = 30_000,
    pollMs = 250,
    stableMs = 1_500,
    readyPath = DAEMON_READY_PATH,
    readReady = readReadyFile,
    fetchHealth = (ready) =>
      fetch(ready.healthzUrl, {
        headers: { authorization: `Bearer ${ready.ipcToken}` },
        signal: AbortSignal.timeout(Math.min(2_000, timeoutMs)),
      }),
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let stableGeneration = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    try {
      const ready = readReady(readyPath);
      if (!validReady(ready)) throw new Error("daemon ready file is invalid");
      const response = await fetchHealth(ready);
      if (!response?.ok) {
        throw new Error(
          `daemon health returned HTTP ${response?.status ?? "unknown"}`,
        );
      }
      if (stableGeneration !== ready.generation) {
        stableGeneration = ready.generation;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince < stableMs) {
        await sleep(pollMs);
        continue;
      }
      handoff.daemon ??= {};
      handoff.daemon.ready = { ...ready };
      return handoff.daemon.ready;
    } catch (error) {
      lastError = error;
      stableGeneration = null;
      stableSince = 0;
      await sleep(pollMs);
    }
  }
  throw new Error(
    `daemon did not publish a reachable ready generation within ${timeoutMs} ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
