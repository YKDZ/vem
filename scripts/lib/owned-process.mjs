import { spawn } from "node:child_process";

const TERMINATE_GRACE_MS = 200;
const KILL_GRACE_MS = 500;
const POLL_MS = 10;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    if (!processGroupExists(processGroupId)) return true;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  return !processGroupExists(processGroupId);
}

async function terminateProcessGroup(processGroupId) {
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, TERMINATE_GRACE_MS)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
  if (await waitForProcessGroupExit(processGroupId, KILL_GRACE_MS)) return;
  throw new Error(`owned process group ${processGroupId} remained alive`);
}

export function startOwnedProcess(
  binary,
  args,
  { deadlineMs, stdio = ["ignore", "pipe", "pipe"] },
) {
  if (process.platform === "win32") {
    throw new Error(
      "owned external process execution is unavailable on Windows without a bounded tree owner",
    );
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error("owned process deadline must be a positive integer");
  }
  const child = spawn(binary, args, { detached: true, stdio });
  let deadlineExceeded = false;
  let termination;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (status, signal) => resolve({ signal, status }));
  });
  const terminate = () => {
    clearTimeout(timer);
    if (child.pid === undefined) return Promise.resolve();
    if (!termination) {
      termination = terminateProcessGroup(child.pid);
      termination.catch(() => undefined);
    }
    return termination;
  };
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    void terminate();
  }, deadlineMs);

  return {
    child,
    terminate,
    async wait() {
      const result = await exited;
      clearTimeout(timer);
      if (deadlineExceeded) {
        await terminate();
        throw new Error(`command exceeded its ${deadlineMs}ms deadline`);
      }
      if (result.error) throw result.error;
      if (child.pid !== undefined && processGroupExists(child.pid)) {
        await terminate();
        throw new Error("command left descendant processes running");
      }
      return result;
    },
  };
}

export async function runOwnedCommand(
  binary,
  args,
  { deadlineMs, input, maximumOutputBytes },
) {
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
    throw new Error("command output bound must be a positive integer");
  }
  const owned = startOwnedProcess(binary, args, {
    deadlineMs,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let outputExceeded = false;
  const collect = (chunks, kind) => (chunk) => {
    if (outputExceeded) return;
    if (kind === "stdout") stdoutSize += chunk.byteLength;
    else stderrSize += chunk.byteLength;
    if (stdoutSize > maximumOutputBytes || stderrSize > maximumOutputBytes) {
      outputExceeded = true;
      void owned.terminate();
      return;
    }
    chunks.push(Buffer.from(chunk));
  };
  owned.child.stdout.on("data", collect(stdout, "stdout"));
  owned.child.stderr.on("data", collect(stderr, "stderr"));
  if (input !== undefined) owned.child.stdin.end(input);

  let result;
  try {
    result = await owned.wait();
  } catch (error) {
    if (outputExceeded) throw new Error("command output exceeded its bound");
    throw error;
  }
  if (outputExceeded) throw new Error("command output exceeded its bound");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  if (result.status !== 0) {
    throw new Error(
      `command failed (${result.status ?? result.signal}): ${stderrText.trim()}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8").trim();
}
