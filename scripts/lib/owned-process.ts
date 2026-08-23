import { spawn } from "node:child_process";

const TERMINATE_GRACE_MS = 200;
const KILL_GRACE_MS = 500;
const POLL_MS = 10;

type StreamMode = "ignore" | "pipe";

export interface StartOwnedProcessOptions {
  deadlineMs: number;
  env?: NodeJS.ProcessEnv;
  stdio?: [StreamMode, StreamMode, StreamMode];
}

type ExitOutcome =
  | { error: Error }
  | { status: number | null; signal: NodeJS.Signals | null };

export interface OwnedProcess {
  child: ReturnType<typeof spawn>;
  terminate: () => Promise<void>;
  wait: () => Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ESRCH")) return false;
    throw error;
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ESRCH")) throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function waitForProcessGroupExit(
  processGroupId: number,
  milliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  do {
    if (!processGroupExists(processGroupId)) return true;
    await sleep(POLL_MS);
  } while (Date.now() < deadline);
  return !processGroupExists(processGroupId);
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  signalProcessGroup(processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, TERMINATE_GRACE_MS)) return;
  signalProcessGroup(processGroupId, "SIGKILL");
  if (await waitForProcessGroupExit(processGroupId, KILL_GRACE_MS)) return;
  throw new Error(`owned process group ${processGroupId} remained alive`);
}

export function startOwnedProcess(
  binary: string,
  args: readonly string[],
  {
    deadlineMs,
    env,
    stdio = ["ignore", "pipe", "pipe"],
  }: StartOwnedProcessOptions,
): OwnedProcess {
  if (process.platform === "win32") {
    throw new Error(
      "owned external process execution is unavailable on Windows without a bounded tree owner",
    );
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error("owned process deadline must be a positive integer");
  }
  const child = spawn(binary, args, { detached: true, env, stdio });
  let deadlineExceeded = false;
  let termination: Promise<void> | undefined;
  const exited = new Promise<ExitOutcome>((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (status, signal) => resolve({ status, signal }));
  });
  const terminate = (): Promise<void> => {
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
      if ("error" in result) throw result.error;
      if (child.pid !== undefined && processGroupExists(child.pid)) {
        await terminate();
        throw new Error("command left descendant processes running");
      }
      return result;
    },
  };
}

export interface RunOwnedCommandOptions {
  deadlineMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maximumOutputBytes: number;
}

export async function runOwnedCommand(
  binary: string,
  args: readonly string[],
  { deadlineMs, env, input, maximumOutputBytes }: RunOwnedCommandOptions,
): Promise<string> {
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes <= 0) {
    throw new Error("command output bound must be a positive integer");
  }
  const owned = startOwnedProcess(binary, args, {
    deadlineMs,
    env,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let outputExceeded = false;
  const collect =
    (chunks: Buffer[], kind: "stdout" | "stderr") =>
    (chunk: Buffer): void => {
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
  if (owned.child.stdout === null || owned.child.stderr === null) {
    owned.terminate();
    throw new Error("owned command did not expose stdout or stderr pipes");
  }
  owned.child.stdout.on("data", collect(stdout, "stdout"));
  owned.child.stderr.on("data", collect(stderr, "stderr"));
  if (input !== undefined && owned.child.stdin !== null) {
    owned.child.stdin.end(input);
  }

  let result: Awaited<ReturnType<OwnedProcess["wait"]>>;
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
