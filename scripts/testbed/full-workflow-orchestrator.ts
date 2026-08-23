#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUSINESS_CHECK_REGISTRY,
  selectBusinessChecks,
} from "./business-check-registry.ts";
import { waitForDaemonReadyRefresh } from "./daemon-ready-refresh.ts";
import {
  redactSensitiveEvidenceText,
  sanitizeSensitiveEvidenceValue,
} from "./failure-evidence-redaction.ts";
import {
  buildFullWorkflowEvidenceManifest,
  EVIDENCE_LIMITS,
  validateFullWorkflowEvidenceManifest,
} from "./full-workflow-evidence-manifest.ts";
import {
  buildFullWorkflowAggregate,
  validateBusinessCheckReport,
} from "./full-workflow-validator.ts";
import {
  activateVisibleSelector,
  CdpClient,
  discoverCanonicalMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  readCdpLocationHash,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";

type JsonRecord = Record<string, unknown>;
import { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";
import {
  isActiveTransaction,
  captureTrackTerminalFacts,
  recoverTrackHandoff,
} from "./track-handoff-recovery.ts";

export { replaceSerialSessionAndUpdateHandoff } from "./serial-session-handoff.ts";

const PAYMENT_CANCEL_SELECTOR = '[data-test="payment-cancel"]:not(:disabled)';
const CHECKOUT_EMPTY_RETURN_SELECTOR =
  '[data-test="checkout-empty-return-catalog"]:not(:disabled)';
const CHECKOUT_BACK_PRODUCT_SELECTOR =
  '[data-test="checkout-back-product"]:not(:disabled), .checkout-back';
const PRODUCT_DETAIL_RETURN_SELECTOR =
  '[data-test="product-detail-return-catalog"]:not(:disabled), .detail-back-button';
const PAYMENT_RETURN_WAIT_MS = 30_000;
const CONTROL_PLANE_TIMEOUT_MS = 10_000;
const CHILD_OUTPUT_CAPTURE_BYTES = 512 * 1024;
const CHILD_OUTPUT_EDGE_BYTES = 255 * 1024;
const DAEMON_READY_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json";
const STOCK_READY_TIMEOUT_MS = 30_000;
const PLATFORM_STOCK_READY_TIMEOUT_MS = 30_000;
const STOCK_ATTESTATION_READY_TIMEOUT_MS = 180_000;
const HARDWARE_READY_TIMEOUT_MS = 30_000;
const RUNTIME_BARRIER_TIMEOUT_MS = 60_000;
const RUNTIME_BARRIER_POLL_MS = 1_000;

// This is the one canonical registry for business acceptance.
export const FULL_WORKFLOW_TRACK_DESCRIPTORS = BUSINESS_CHECK_REGISTRY;

interface TrackRunner {
  kind?: string;
  script?: string;
  args?: string[];
  reportFileName?: string;
  artifactDirectory?: string;
}

interface Track {
  name: string;
  key: string;
  core?: boolean;
  fullRequired?: boolean;
  fixtureKey?: string;
  runner: TrackRunner | null;
  validator?: unknown;
  blockedReason?: string | null;
  allowActiveTransactionHandoff?: boolean;
  restoreFixtureStock?: boolean;
  reportPath: string | null;
  artifactRoot: string | null;
  command: string[] | null;
  result?: {
    businessStatus?: string;
    error?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface OutputCapture {
  text: string;
  observedBytes: number;
  truncated: boolean;
}

interface TrackChild {
  status: string;
  exitCode: number | null;
  stdout?: string | null;
  stderr?: string | null;
  stdoutCapture?: OutputCapture;
  stderrCapture?: OutputCapture;
  report?: unknown;
  reportPath?: string | null;
  artifactRoot?: string | null;
  [key: string]: unknown;
}

interface FixtureAllocationEntry {
  inventoryId?: unknown;
  slotId?: unknown;
  rowNo?: unknown;
  cellNo?: unknown;
  sku?: unknown;
  onHandQty?: unknown;
  [key: string]: unknown;
}

type FixtureAllocation = Record<string, FixtureAllocationEntry>;

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  if (index === -1) throw new Error(`--${name} is required`);
  return required(args[index + 1], name);
}

function repeatableOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    values.push(required(args[index + 1], name));
    index += 1;
  }
  return values;
}

function parseArgs(args: string[]): {
  mode: string;
  focus: string[];
  commit: string | null;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
} {
  const mode = option(args, "mode");
  if (!["fast", "full"].includes(mode))
    throw new Error("--mode must be fast or full");
  const commit = args.includes("--commit") ? option(args, "commit") : null;
  if (commit && !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("--commit must be a full 40-character Git SHA");
  }
  return {
    mode,
    focus: repeatableOption(args, "focus"),
    commit: commit?.toLowerCase() ?? null,
    guestInputPath: option(args, "guest-input"),
    handoffPath: option(args, "handoff"),
    outPath: option(args, "out"),
  };
}

function boundedOutputCapture(): {
  append: (chunk: unknown) => void;
  finish: () => OutputCapture;
} {
  let complete = Buffer.alloc(0);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let totalBytes = 0;
  let truncated = false;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += bytes.byteLength;
      if (
        !truncated &&
        complete.byteLength + bytes.byteLength <= CHILD_OUTPUT_CAPTURE_BYTES
      ) {
        complete = Buffer.concat([complete, bytes]);
        return;
      }
      if (!truncated) {
        const combined = Buffer.concat([complete, bytes]);
        head = combined.subarray(0, CHILD_OUTPUT_EDGE_BYTES);
        tail = combined.subarray(-CHILD_OUTPUT_EDGE_BYTES);
        complete = Buffer.alloc(0);
        truncated = true;
        return;
      }
      tail = Buffer.concat([tail, bytes]).subarray(-CHILD_OUTPUT_EDGE_BYTES);
    },
    finish() {
      const marker = truncated
        ? Buffer.from(
            `\n...[bounded child output truncated; observedBytes=${totalBytes}]...\n`,
          )
        : Buffer.alloc(0);
      const headLineEnd = head.lastIndexOf(0x0a);
      const tailLineStart = tail.indexOf(0x0a);
      const completeHead =
        headLineEnd >= 0 ? head.subarray(0, headLineEnd + 1) : Buffer.alloc(0);
      const completeTail =
        tailLineStart >= 0 ? tail.subarray(tailLineStart + 1) : Buffer.alloc(0);
      const captured = truncated
        ? Buffer.concat([completeHead, marker, completeTail])
        : complete;
      return {
        text: redactSensitiveEvidenceText(captured.toString("utf8")),
        observedBytes: totalBytes,
        truncated,
      };
    },
  };
}

function normalizedOutputCapture(value: unknown): OutputCapture {
  const record = value as Record<string, unknown> | null | undefined;
  if (
    record &&
    typeof record.text === "string" &&
    typeof record.observedBytes === "number" &&
    Number.isInteger(record.observedBytes) &&
    typeof record.truncated === "boolean"
  ) {
    return {
      text: redactSensitiveEvidenceText(record.text),
      observedBytes: record.observedBytes,
      truncated: record.truncated,
    };
  }
  const capture = boundedOutputCapture();
  capture.append(value ?? "");
  return capture.finish();
}

function persistTrackChildEvidence(
  track: Track,
  child: TrackChild,
  { artifactRootTrusted = true }: { artifactRootTrusted?: boolean } = {},
): TrackChild {
  const stdout = normalizedOutputCapture(child.stdoutCapture ?? child.stdout);
  const stderr = normalizedOutputCapture(child.stderrCapture ?? child.stderr);
  const artifactRoot =
    artifactRootTrusted && track?.artifactRoot
      ? resolve(track.artifactRoot)
      : null;
  let childEvidence = null;
  if (artifactRoot) {
    const stdoutPath = join(artifactRoot, "child-stdout.log");
    const stderrPath = join(artifactRoot, "child-stderr.log");
    const processPath = join(artifactRoot, "child-process.json");
    try {
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(stdoutPath, stdout.text, "utf8");
      writeFileSync(stderrPath, stderr.text, "utf8");
      writeJson(processPath, {
        schemaVersion: "vem-testbed-child-process/v1",
        track: track.key,
        status: child.status,
        exitCode: child.exitCode ?? null,
        streams: {
          stdout: {
            path: stdoutPath,
            observedBytes: stdout.observedBytes,
            capturedBytes: Buffer.byteLength(stdout.text),
            truncated: stdout.truncated,
          },
          stderr: {
            path: stderrPath,
            observedBytes: stderr.observedBytes,
            capturedBytes: Buffer.byteLength(stderr.text),
            truncated: stderr.truncated,
          },
        },
      });
      childEvidence = { stdoutPath, stderrPath, processPath };
    } catch {
      // 支持证据只做尽力采集，绝不替换子进程或前置检查的业务失败。
      // 下方控制台短摘要仍使用已经有界并脱敏的内存文本。
    }
  }
  return {
    ...child,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutCapture: stdout,
    stderrCapture: stderr,
    childEvidence,
  };
}

function runTrack(command: string[], label: string): Promise<TrackChild> {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = boundedOutputCapture();
    const stderr = boundedOutputCapture();
    let settled = false;
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    const finish = (result: TrackChild) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    child.once("error", (error: Error) =>
      finish({
        label,
        command,
        exitCode: 1,
        status: "failed",
        stdoutCapture: stdout.finish(),
        stderrCapture: normalizedOutputCapture(error.message),
      }),
    );
    child.once("close", (code) =>
      finish({
        label,
        command,
        exitCode: code ?? 1,
        status: code === 0 ? "passed" : "failed",
        stdoutCapture: stdout.finish(),
        stderrCapture: stderr.finish(),
      }),
    );
  });
}

function jsonIfPresent(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function clearTrackReport(path: unknown): void {
  if (typeof path !== "string" || path.trim() === "") return;
  rmSync(path, { force: true });
}

function clearTrackArtifacts(path: unknown): void {
  if (typeof path !== "string" || path.trim() === "") return;
  rmSync(path, { recursive: true, force: true });
}

function workflowIdentity(
  guestInputPath: string,
  commit: string | null = null,
): unknown {
  const identity =
    (jsonIfPresent(guestInputPath) as Record<string, unknown> | null)
      ?.workflowIdentity ?? null;
  return commit ? { ...identity, githubSha: commit } : identity;
}

function supportingEvidenceFailure(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}: ${redactSensitiveEvidenceText(message, 1_024)}`;
}

function unavailableEvidenceManifest({
  tracks,
  reason,
}: {
  tracks: Track[];
  reason: string;
}): Record<string, unknown> {
  const evidenceTracks = tracks.map((track) => {
    const result = track.result ?? null;
    const resultRecord = result as Record<string, unknown> | null;
    const businessStatus =
      resultRecord?.businessStatus === "passed" ? "passed" : "failed";
    return {
      key: track.key,
      businessStatus,
      evidencePolicy: null,
      report: null,
      machineRuntimeTrace: null,
      logs: [],
      screenshots: [],
      primaryReason:
        businessStatus === "failed"
          ? (resultRecord?.error ?? "supporting evidence is unavailable")
          : null,
      diagnostics: [],
    };
  });
  return {
    schemaVersion: "vem-local-testbed-full-workflow-evidence-manifest/v2",
    ok: false,
    limits: EVIDENCE_LIMITS,
    requiredKinds: ["machineRuntimeTrace", "logs"],
    totals: {
      byteLength: 0,
      tracks: evidenceTracks.length,
      reports: 0,
      machineRuntimeTrace: 0,
      logs: 0,
      screenshots: 0,
    },
    tracks: evidenceTracks,
    files: [],
    sections: [],
    warnings: [],
    failures: [reason],
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function refreshDaemonReadyHandoff({
  handoffPath,
  readyPath = DAEMON_READY_FILE,
  handoff = jsonIfPresent(handoffPath) as Record<string, unknown> | null,
}: {
  handoffPath: string;
  readyPath?: string;
  handoff?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const ready = jsonIfPresent(readyPath) as Record<string, unknown> | null;
  if (!handoff || typeof handoff !== "object" || !handoff.daemon || !ready) {
    throw new Error("daemon ready handoff inputs are unavailable");
  }
  for (const key of ["healthzUrl", "readyzUrl", "ipcToken", "generation"]) {
    required(ready[key], `daemon ready ${key}`);
  }
  (handoff as Record<string, unknown>).daemon = {
    ...(handoff.daemon as Record<string, unknown>),
    ready: { ...(ready as Record<string, unknown>) },
  };
  writeJson(handoffPath, handoff);
  return handoff;
}

export function reloadRuntimeHandoff(
  handoffPath: string,
  handoff: Record<string, unknown>,
): Record<string, unknown> {
  const current = jsonIfPresent(handoffPath);
  if (!current) throw new Error("runtime handoff is unavailable");
  Object.assign(handoff, current);
  return handoff;
}

export async function waitForInstalledRuntimeBarrier(
  handoff: { cdp?: { endpoint?: unknown } } | null | undefined,
  {
    discoverTarget = discoverCanonicalMachineUiTarget,
    timeoutMs = RUNTIME_BARRIER_TIMEOUT_MS,
    pollMs = RUNTIME_BARRIER_POLL_MS,
  }: {
    discoverTarget?: (
      options: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const endpoint = handoff?.cdp?.endpoint ?? "http://127.0.0.1:9222";
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const target = await discoverTarget({
        endpoint,
        timeoutMs: Math.min(5_000, Math.max(250, deadline - Date.now())),
      });
      return target;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }
  throw (
    lastError ??
    new Error("Machine UI CDP target did not become available before the track")
  );
}

function commandForTrack(
  track: Track,
  {
    mode,
    guestInputPath,
    handoffPath,
  }: { mode: string; guestInputPath: string; handoffPath: string },
): string[] | null {
  if (!track.runner) return null;
  if (track.runner.kind === "powershell") {
    return [
      "pwsh",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      required(track.runner.script, "runner script"),
      "-GuestInputPath",
      guestInputPath,
      "-HandoffPath",
      handoffPath,
      "-OutPath",
      required(track.reportPath, "track report path"),
      "-FixtureKey",
      required(track.fixtureKey, "track fixture key"),
    ];
  }
  return [
    process.execPath,
    required(track.runner.script, "runner script"),
    ...(track.runner.args && track.runner.args.length
      ? track.runner.args
      : ["--mode", mode]),
    "--guest-input",
    guestInputPath,
    "--handoff",
    handoffPath,
    "--out",
    required(track.reportPath, "track report path"),
    "--fixture-key",
    required(track.fixtureKey, "track fixture key"),
  ];
}

export function buildWorkflowTrackCommands({
  mode,
  focus = [],
  guestInputPath,
  handoffPath,
  outPath,
}: {
  mode: string;
  focus?: string[];
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
}): { tracks: Track[] } {
  const root = dirname(resolve(outPath));
  const tracks = (
    selectBusinessChecks({ mode, focus }) as unknown as Track[]
  ).map((descriptor) => {
    const descriptorTrack = descriptor as unknown as Track;
    const runner = descriptorTrack.runner;
    const track: Track = {
      ...descriptorTrack,
      key: descriptor.name,
      reportPath: runner
        ? join(root, required(runner.reportFileName, "report file name"))
        : null,
      artifactRoot: runner
        ? join(root, required(runner.artifactDirectory, "artifact directory"))
        : null,
    };
    return {
      ...track,
      command: commandForTrack(track, { mode, guestInputPath, handoffPath }),
    };
  });
  return { tracks };
}

function shortError(result: { stderr?: unknown }): string | null {
  return (
    String(result.stderr ?? "")
      .trim()
      .replaceAll(/\s+/g, " ")
      .slice(-500) || null
  );
}

function redactedOptionalError(value: unknown): string | null {
  if (value == null) return null;
  const redacted = redactSensitiveEvidenceText(value).trim();
  return redacted || null;
}

export async function runSerialTrackLifecycle({
  tracks,
  runTrack: executeTrack,
  captureTerminal,
  recover,
  beforeTrack = () => undefined,
  haltOnRecoveryFailure = false,
  emitTrackProgress = () => undefined,
  now = () => new Date(),
  clearReport = clearTrackReport,
  clearArtifacts = clearTrackArtifacts,
}: {
  tracks: Track[];
  runTrack: (track: Track) => Promise<TrackChild>;
  captureTerminal: (
    track: Track,
    context: { child: TrackChild; report: unknown },
  ) => Promise<Record<string, unknown>>;
  recover: (
    track: Track,
    context: { child: TrackChild; report: unknown; terminal: unknown },
  ) => Promise<Record<string, unknown>>;
  beforeTrack?: (track: Track) => unknown;
  haltOnRecoveryFailure?: boolean;
  emitTrackProgress?: (event: Record<string, unknown>) => unknown;
  now?: () => Date;
  clearReport?: (path: string | null, track: Track) => void;
  clearArtifacts?: (path: string | null, track: Track) => void;
}): Promise<Array<Record<string, unknown>>> {
  const executed: Array<Record<string, unknown>> = [];
  for (const track of tracks) {
    const startedAt = now().toISOString();
    emitTrackProgress({ type: "started", track, startedAt });
    let child: TrackChild;
    const evidenceTrust = { report: false, artifactRoot: false };
    try {
      if (!track.runner) {
        child = {
          status: "blocked",
          exitCode: null,
          stderr: track.blockedReason,
          report: null,
        };
      } else {
        const cleanupErrors: string[] = [];
        try {
          clearReport(track.reportPath, track);
          evidenceTrust.report = true;
        } catch (error) {
          cleanupErrors.push(
            `report cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          clearArtifacts(track.artifactRoot, track);
          evidenceTrust.artifactRoot = true;
        } catch (error) {
          cleanupErrors.push(
            `artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (cleanupErrors.length > 0) {
          throw new Error(cleanupErrors.join("; "));
        }
        await beforeTrack(track);
        child = await executeTrack(track);
      }
    } catch (error) {
      child = {
        status: "failed",
        exitCode: 1,
        stderr: `track preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    child = persistTrackChildEvidence(track, child, {
      artifactRootTrusted: evidenceTrust.artifactRoot,
    });
    const report = evidenceTrust.report
      ? (child.report ?? jsonIfPresent(track.reportPath ?? ""))
      : null;
    let terminal;
    try {
      terminal = await captureTerminal(track, { child, report });
    } catch (error) {
      terminal = {
        ok: false,
        facts: null,
        reason: `terminal capture failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const finishedAt = now().toISOString();
    const validation = validateBusinessCheckReport(
      track,
      report as JsonRecord | null | undefined,
      track.reportPath ?? "",
      {
        artifactRoot: evidenceTrust.artifactRoot ? track.artifactRoot : null,
        visionBaseUrl: process.env.VISION_BASE_URL ?? "http://127.0.0.1:27892",
      },
    );
    const childFailed =
      child.status !== "passed" || validation.status !== "passed";
    const terminalFailed = terminal?.ok !== true;
    const recoveryStartedAt = now().toISOString();
    let recovery;
    try {
      recovery = await recover(track, { child, report, terminal });
    } catch (error) {
      recovery = {
        ok: false,
        actions: [],
        errors: [
          `handoff recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    const recoveryFinishedAt = now().toISOString();
    const recoveryFailed = recovery?.ok !== true;
    const entry = {
      key: track.key,
      reportPath: track.reportPath,
      status:
        child.status === "blocked"
          ? "blocked"
          : childFailed || terminalFailed || recoveryFailed
            ? "failed"
            : "passed",
      businessStatus:
        child.status === "blocked"
          ? "blocked"
          : childFailed || terminalFailed || recoveryFailed
            ? "failed"
            : "passed",
      exitCode: child.exitCode,
      reportOk: (report as Record<string, unknown> | null)?.ok ?? null,
      evidenceTrust,
      validator: validation,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      failureStage: childFailed
        ? "child"
        : terminalFailed
          ? "terminal-state"
          : recoveryFailed
            ? "handoff-recovery"
            : null,
      error: childFailed
        ? child.stderr?.startsWith("track preflight failed:")
          ? shortError(child)
          : (shortError(child) ?? validation.reason)
        : terminalFailed
          ? redactedOptionalError(
              (terminal as Record<string, unknown>).reason ??
                "terminal facts are incomplete",
            )
          : recoveryFailed
            ? redactedOptionalError(
                (recovery.errors as string[] | undefined)?.join("; ") ??
                  "handoff recovery failed",
              )
            : null,
      terminal: sanitizeSensitiveEvidenceValue(terminal),
      handoffRecovery: sanitizeSensitiveEvidenceValue({
        ...recovery,
        startedAt: recoveryStartedAt,
        finishedAt: recoveryFinishedAt,
        durationMs:
          Date.parse(recoveryFinishedAt) - Date.parse(recoveryStartedAt),
      }),
    };
    executed.push(entry);
    emitTrackProgress({ type: "finished", track, result: entry });
    if (recoveryFailed && haltOnRecoveryFailure) break;
  }
  return executed;
}

async function boundedFetch(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs = CONTROL_PLANE_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (
      (error as { name?: unknown })?.name === "TimeoutError" ||
      (error as { name?: unknown })?.name === "AbortError"
    ) {
      throw new Error(`request timed out after ${timeoutMs} ms: ${url}`);
    }
    throw error;
  }
}

function sleepMs(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function isTransientBoundaryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof TypeError ||
    /fetch failed|timed out|ECONNRESET|ECONNREFUSED|socket hang up|CDP WebSocket failed to open/i.test(
      message,
    )
  );
}

async function retryTransientBoundary(
  label: string,
  operation: () => Promise<unknown>,
  {
    timeoutMs = 10_000,
    pollMs = 250,
  }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientBoundaryError(error) || Date.now() >= deadline) break;
      await sleepMs(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() < deadline);
  throw new Error(
    `${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

function controlPlaneRequest(
  guestInput: Record<string, unknown> | null | undefined,
  path: string,
  body: unknown = {},
): Promise<unknown> {
  const controlPlane = guestInput?.hostControlPlane as
    | Record<string, unknown>
    | undefined;
  if (!controlPlane?.endpoint || !controlPlane?.token) {
    throw new Error(
      "guest input is missing hostControlPlane endpoint and token",
    );
  }
  return retryTransientBoundary(`host control-plane ${path}`, () =>
    boundedFetch(`${controlPlane.endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controlPlane.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          `${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
        );
      return payload;
    }),
  );
}

function daemonGet(
  handoff: Record<string, unknown> | null | undefined,
  path: string,
): Promise<unknown> {
  const ready = (handoff?.daemon as Record<string, unknown> | undefined)
    ?.ready as Record<string, unknown> | undefined;
  const healthz = required(ready?.healthzUrl, "daemon healthzUrl");
  const baseUrl = healthz.endsWith("/healthz")
    ? healthz.slice(0, -"/healthz".length)
    : healthz;
  return retryTransientBoundary(`daemon GET ${path}`, () =>
    boundedFetch(`${baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
      },
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          `${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
        );
      return payload;
    }),
  );
}

function daemonPost(
  handoff: Record<string, unknown> | null | undefined,
  path: string,
  body: unknown,
): Promise<unknown> {
  const ready = (handoff?.daemon as Record<string, unknown> | undefined)
    ?.ready as Record<string, unknown> | undefined;
  const healthz = required(ready?.healthzUrl, "daemon healthzUrl");
  const baseUrl = healthz.endsWith("/healthz")
    ? healthz.slice(0, -"/healthz".length)
    : healthz;
  return retryTransientBoundary(`daemon POST ${path}`, () =>
    boundedFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(ready?.ipcToken, "daemon ipcToken")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          `${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
        );
      return payload;
    }),
  );
}

function unwrapServiceApiEnvelope(payload: unknown): unknown {
  const record = payload as Record<string, unknown> | null | undefined;
  if (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    record.code === 0 &&
    Object.hasOwn(record, "data")
  ) {
    return record.data;
  }
  return payload;
}

async function serviceApiRequest(
  guestInput: Record<string, unknown> | null | undefined,
  path: string,
  options: { method?: unknown; token?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const baseUrl = required(
    (guestInput?.runtimeBootstrap as Record<string, unknown> | undefined)
      ?.provisioningApiBaseUrl,
    "runtime bootstrap provisioning API base URL",
  ).replace(/\/+$/, "");
  const response = await boundedFetch(`${baseUrl}${path}`, {
    method: String(options.method ?? "GET"),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || (payload as Record<string, unknown> | null)?.code !== 0) {
    throw new Error(
      `${options.method ?? "GET"} ${path} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return unwrapServiceApiEnvelope(payload);
}

export async function waitForPlatformFixtureStock({
  guestInput,
  fixtureAllocation,
  request = serviceApiRequest,
  timeoutMs = PLATFORM_STOCK_READY_TIMEOUT_MS,
  pollMs = 250,
}: {
  guestInput: Record<string, unknown> | null | undefined;
  fixtureAllocation: FixtureAllocation | null | undefined;
  request?: (
    guestInput: Record<string, unknown> | null | undefined,
    path: string,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{ inventories: Array<Record<string, unknown>> }> {
  const fixtures = Object.values(fixtureAllocation ?? {});
  if (fixtures.length === 0) {
    throw new Error("platform fixture stock wait requires allocated slots");
  }
  const guest = guestInput as Record<string, unknown> | null | undefined;
  const login = (await request(guest, "/auth/login", {
    method: "POST",
    body: {
      username: required(
        (guest?.serviceApi as Record<string, unknown> | undefined)
          ?.adminUsername,
        "service API admin username",
      ),
      password: required(
        (guest?.serviceApi as Record<string, unknown> | undefined)
          ?.adminPassword,
        "service API admin password",
      ),
    },
  })) as { accessToken?: unknown } | null;
  const token = required(login?.accessToken, "service API access token");
  const deadline = Date.now() + timeoutMs;
  let last: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    const page = (await request(guest, "/inventories?page=1&pageSize=100", {
      token,
    })) as { items?: Array<Record<string, unknown>> } | null;
    last = fixtures.map((fixture) => {
      const inventory = (page?.items ?? []).find(
        (entry) => entry?.id === fixture.inventoryId,
      );
      return {
        inventoryId: fixture.inventoryId,
        expectedOnHandQty: fixture.onHandQty,
        onHandQty: inventory?.onHandQty ?? null,
        reservedQty: inventory?.reservedQty ?? null,
      };
    });
    if (
      last.every(
        (entry) =>
          entry.onHandQty === entry.expectedOnHandQty &&
          entry.reservedQty === 0,
      )
    ) {
      return { inventories: last };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(
    `platform fixture stock did not settle before business assertions: ${JSON.stringify(last)}`,
  );
}

export async function ensureFixtureStockReady({
  fixtureAllocation,
  daemonGet: get,
  daemonPost: post,
  timeoutMs = STOCK_READY_TIMEOUT_MS,
  pollMs = 500,
}: {
  fixtureAllocation: FixtureAllocation | null | undefined;
  daemonGet: (path: string) => Promise<unknown>;
  daemonPost: (path: string, body: unknown) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<Record<string, unknown>> {
  const fixtures = Object.values(fixtureAllocation ?? {});
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const getRecord = async (
    path: string,
  ): Promise<Record<string, unknown> | null> => asRecord(await get(path));
  const hasCoordinateIdentity = (fixture: FixtureAllocationEntry): boolean =>
    typeof fixture?.rowNo === "number" &&
    Number.isInteger(fixture.rowNo) &&
    typeof fixture?.cellNo === "number" &&
    Number.isInteger(fixture.cellNo) &&
    typeof fixture?.sku === "string" &&
    fixture.sku !== "";
  const fixtureKey = (fixture: FixtureAllocationEntry): string =>
    hasCoordinateIdentity(fixture)
      ? `${fixture.rowNo}:${fixture.cellNo}:${fixture.sku}`
      : `slot:${fixture.slotId}`;
  const itemMatchesFixture = (
    item: Record<string, unknown>,
    fixture: FixtureAllocationEntry,
  ): boolean =>
    hasCoordinateIdentity(fixture)
      ? item?.rowNo === fixture.rowNo &&
        item?.cellNo === fixture.cellNo &&
        item?.sku === fixture.sku
      : item?.slotId === fixture.slotId;
  const itemForFixture = (
    saleView: Record<string, unknown> | null,
    fixture: FixtureAllocationEntry,
  ): Record<string, unknown> | undefined =>
    (Array.isArray(saleView?.items) ? saleView.items : []).find((item) =>
      itemMatchesFixture(item as Record<string, unknown>, fixture),
    ) as Record<string, unknown> | undefined;
  const desiredByFixtureKey = new Map<string, unknown>(
    fixtures.map((fixture): [string, unknown] => [
      fixtureKey(fixture),
      fixture.onHandQty,
    ]),
  );
  if (
    desiredByFixtureKey.size === 0 ||
    fixtures.some(
      (fixture) =>
        (!hasCoordinateIdentity(fixture) &&
          (typeof fixture?.slotId !== "string" || fixture.slotId === "")) ||
        typeof fixture?.onHandQty !== "number" ||
        !Number.isInteger(fixture.onHandQty),
    )
  ) {
    throw new Error("fixture stock preflight requires allocated slots");
  }

  const targetIsReady = (saleView: Record<string, unknown> | null): boolean => {
    return fixtures.every((fixture) => {
      const item = itemForFixture(saleView, fixture);
      const desired = desiredByFixtureKey.get(fixtureKey(fixture));
      return (
        item?.slotSalesState === "sale_ready" &&
        item.saleableStock === desired &&
        item.physicalStock === desired
      );
    });
  };
  const attestationStatusSummary = (
    status: Record<string, unknown> | null,
  ): Record<string, unknown> | null =>
    status
      ? {
          status: status.status,
          code: status.code,
          attestationId: status.attestationId,
          planogramVersion: status.planogramVersion,
          inconsistentSlots: status.inconsistentSlots,
        }
      : null;
  const waitForAttestationReady = async (
    attestationId: unknown,
  ): Promise<Record<string, unknown> | null> => {
    const attestationDeadline =
      Date.now() + Math.max(timeoutMs, STOCK_ATTESTATION_READY_TIMEOUT_MS);
    let status: Record<string, unknown> | null = null;
    while (Date.now() < attestationDeadline) {
      status = await getRecord("/v1/stock/attestation");
      if (
        status?.status === "ready" &&
        status?.attestationId === attestationId &&
        (Array.isArray(status?.inconsistentSlots)
          ? status.inconsistentSlots
          : []
        ).length === 0
      ) {
        return status;
      }
      if (
        ["failed", "rejected", "inconsistent", "stale"].includes(
          String(status?.status),
        )
      ) {
        throw new Error(
          `fixture stock attestation did not complete: ${JSON.stringify(
            attestationStatusSummary(status),
          )}`,
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
    throw new Error(
      `fixture stock attestation did not become ready: ${JSON.stringify(
        attestationStatusSummary(status),
      )}`,
    );
  };
  const fixtureReadinessSnapshot = (
    saleView: Record<string, unknown> | null,
  ): Array<Record<string, unknown>> =>
    fixtures.map((fixture) => {
      const item = itemForFixture(saleView, fixture);
      const desired = desiredByFixtureKey.get(fixtureKey(fixture));
      return {
        fixture: {
          slotId: fixture.slotId,
          rowNo: fixture.rowNo,
          cellNo: fixture.cellNo,
          sku: fixture.sku,
          onHandQty: fixture.onHandQty,
        },
        matched: item
          ? {
              slotId: item.slotId,
              inventoryId: item.inventoryId,
              rowNo: item.rowNo,
              cellNo: item.cellNo,
              sku: item.sku,
              slotDisplayLabel: item.slotDisplayLabel,
              slotSalesState: item.slotSalesState,
              saleableStock: item.saleableStock,
              physicalStock: item.physicalStock,
            }
          : null,
        desired,
        ready:
          item?.slotSalesState === "sale_ready" &&
          item.saleableStock === desired &&
          item.physicalStock === desired,
      };
    });
  const deadline = Date.now() + timeoutMs;
  let initialSaleView: Record<string, unknown> | null = null;
  let task: Record<string, unknown> | null = null;
  let taskError = null;
  while (Date.now() < deadline) {
    initialSaleView = await getRecord("/v1/sale-view");
    try {
      task = await getRecord("/v1/stock/maintenance-task");
      if (
        targetIsReady(initialSaleView) &&
        !["initial_count", "recovery_count"].includes(String(task?.mode))
      ) {
        return { changed: false };
      }
      break;
    } catch (error) {
      taskError = error;
      if (targetIsReady(initialSaleView)) return { changed: false };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  if (!task) {
    throw new Error(
      `fixture stock maintenance task did not become available: ${
        taskError instanceof Error ? taskError.message : String(taskError)
      }`,
    );
  }
  if (
    !["initial_count", "recovery_count", "routine_refill"].includes(
      String(task?.mode),
    )
  ) {
    throw new Error(
      `fixture stock requires a maintenance task, received ${task?.mode ?? "missing"}`,
    );
  }
  const initialFixtureItems = fixtures.map((fixture) => ({
    fixture,
    item: itemForFixture(initialSaleView, fixture),
  }));
  if (initialFixtureItems.some(({ item }) => !item?.slotId)) {
    throw new Error(
      `fixture stock preflight could not resolve current sale-view slots: ${JSON.stringify(
        fixtures.map((fixture) => ({
          rowNo: fixture.rowNo,
          cellNo: fixture.cellNo,
          sku: fixture.sku,
          slotId: fixture.slotId,
        })),
      )}`,
    );
  }
  const desiredByCurrentSlotId = new Map<string, unknown>(
    initialFixtureItems.map(({ fixture, item }) => [
      String(item?.slotId),
      fixture.onHandQty,
    ]),
  );
  const activeAttestationSlots = (
    Array.isArray(initialSaleView?.items) ? initialSaleView.items : []
  )
    .filter((item) => {
      const record = item as Record<string, unknown>;
      return (
        typeof record?.slotId === "string" &&
        record.slotId !== "" &&
        typeof record?.sku === "string" &&
        record.sku !== ""
      );
    })
    .map((item) => {
      const record = item as Record<string, unknown>;
      return {
        slotId: record.slotId,
        sku: record.sku,
        quantity:
          desiredByCurrentSlotId.get(String(record.slotId)) ??
          record.physicalStock,
        enabled:
          desiredByCurrentSlotId.has(String(record.slotId)) ||
          record.slotSalesState !== "frozen",
      };
    });
  const taskSlotsById = new Map<string, Record<string, unknown>>(
    (Array.isArray(task?.slots) ? task.slots : []).map((slot) => [
      String((slot as Record<string, unknown>)?.slotId),
      slot as Record<string, unknown>,
    ]),
  );
  const fixtureTaskSlots = fixtures.map((fixture) => {
    const currentItem = initialFixtureItems.find(
      (entry) => entry.fixture === fixture,
    )?.item;
    const taskSlot = taskSlotsById.get(String(currentItem?.slotId));
    if (!taskSlot) {
      throw new Error(
        `fixture stock ${task.mode} task does not contain fixture slot R${fixture.rowNo}C${fixture.cellNo}`,
      );
    }
    return { fixture, taskSlot };
  });
  const routineRefillSlots = fixtureTaskSlots.map(({ fixture, taskSlot }) => {
    if (
      typeof taskSlot.currentQuantity !== "number" ||
      !Number.isInteger(taskSlot.currentQuantity)
    ) {
      throw new Error(
        `fixture stock routine_refill task has invalid current quantity for ${fixture.slotId}`,
      );
    }
    return {
      slotId: fixture.slotId,
      addition: Math.max(
        0,
        Number(fixture.onHandQty) - Number(taskSlot.currentQuantity),
      ),
    };
  });
  const requiresAttestation = initialFixtureItems.some(({ fixture, item }) => {
    const desired = desiredByFixtureKey.get(fixtureKey(fixture));
    return (
      item?.slotSalesState !== "sale_ready" ||
      Number(item?.saleableStock) > Number(desired) ||
      Number(item?.physicalStock) > Number(desired)
    );
  });
  let requiresFreshAttestation = false;
  if (
    task.mode === "routine_refill" &&
    (!requiresAttestation ||
      ["pending", "complete"].includes(String(task.status))) &&
    routineRefillSlots.every((slot) => slot.addition === 0)
  ) {
    let projection: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      projection = await getRecord(
        `/v1/stock/maintenance-tasks/${encodeURIComponent(String(task.taskId))}/projection`,
      );
      if (
        projection?.taskId === task.taskId &&
        projection?.mode === "routine_refill"
      ) {
        const projectedSlots = new Map(
          (Array.isArray(projection?.slots) ? projection.slots : []).map(
            (slot) => [
              String((slot as Record<string, unknown>)?.slotId),
              slot as Record<string, unknown>,
            ],
          ),
        );
        const projectionStillNotSubmitted = fixtures.every((fixture) => {
          const currentItem = initialFixtureItems.find(
            (entry) => entry.fixture === fixture,
          )?.item;
          const slot = projectedSlots.get(String(currentItem?.slotId));
          return (
            slot?.syncStatus === "not_submitted" &&
            (slot?.previewQuantity === fixture.onHandQty ||
              slot?.previewQuantity === null) &&
            (slot?.submittedAddition === 0 ||
              slot?.submittedAddition === null) &&
            (slot?.platformRawMovementId === null ||
              slot?.platformRawMovementId === undefined)
          );
        });
        if (projectionStillNotSubmitted) {
          requiresFreshAttestation = true;
          break;
        }
      }
      if (projection?.status === "complete") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
    if (!requiresFreshAttestation) {
      const projectedSlots = new Map(
        (Array.isArray(projection?.slots) ? projection.slots : []).map(
          (slot) => [
            String((slot as Record<string, unknown>)?.slotId),
            slot as Record<string, unknown>,
          ],
        ),
      );
      const projectionMatchesFixtures =
        projection?.taskId === task.taskId &&
        projection?.mode === "routine_refill" &&
        projection?.status === "complete" &&
        fixtures.every((fixture) => {
          const currentItem = initialFixtureItems.find(
            (entry) => entry.fixture === fixture,
          )?.item;
          const slot = projectedSlots.get(String(currentItem?.slotId));
          return (
            slot?.syncStatus === "accepted" &&
            slot?.previewQuantity === fixture.onHandQty &&
            typeof slot?.submittedAddition === "number" &&
            Number.isInteger(slot.submittedAddition) &&
            slot.submittedAddition >= 0
          );
        });
      if (!projectionMatchesFixtures) {
        throw new Error(
          `fixture stock routine_refill projection does not satisfy allocated fixtures: ${JSON.stringify(projection)}`,
        );
      }
      let projectedSaleView = initialSaleView;
      while (Date.now() < deadline) {
        projectedSaleView = await getRecord("/v1/sale-view");
        if (targetIsReady(projectedSaleView)) {
          return {
            changed: false,
            taskId: task.taskId,
            mode: task.mode,
            projection,
          };
        }
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, pollMs),
        );
      }
      throw new Error(
        `fixture stock routine_refill projection did not become sale-ready without a positive addition: ${JSON.stringify(
          (Array.isArray(projectedSaleView?.items)
            ? projectedSaleView.items
            : []
          ).filter((item) =>
            desiredByCurrentSlotId.has(
              String((item as Record<string, unknown>)?.slotId),
            ),
          ),
        )}`,
      );
    }
  }
  let operationMode = task.mode;
  let operationId = task.taskId;
  if (
    task.mode === "routine_refill" &&
    (requiresAttestation || requiresFreshAttestation)
  ) {
    operationMode = "physical_stock_attestation";
    operationId = `testbed-stock-recovery-${Date.now()}`;
    const slots = activeAttestationSlots;
    if (
      !initialSaleView?.planogramVersion ||
      slots.length === 0 ||
      slots.some(
        (slot) => !slot.slotId || !slot.sku || !Number.isInteger(slot.quantity),
      )
    ) {
      throw new Error("fixture stock attestation inputs are incomplete");
    }
    await post("/v1/stock/attestation", {
      attestationId: operationId,
      planogramVersion: initialSaleView.planogramVersion,
      operatorId: "testbed-orchestrator",
      slots,
    });
    await waitForAttestationReady(operationId);
  } else {
    const slots =
      task.mode === "routine_refill"
        ? routineRefillSlots.filter((slot) => slot.addition > 0)
        : (Array.isArray(task?.slots) ? task.slots : []).map((slot) => {
            const record = slot as Record<string, unknown>;
            return {
              slotId: record.slotId,
              quantity:
                desiredByCurrentSlotId.get(String(record.slotId)) ??
                record.currentQuantity,
            };
          });
    if (slots.length === 0) {
      throw new Error(`fixture stock ${task.mode} task has no restoring slots`);
    }
    await post("/v1/stock/maintenance-task", {
      taskId: task.taskId,
      mode: task.mode,
      slots,
    });
  }

  let saleView = initialSaleView;
  while (Date.now() < deadline) {
    saleView = await getRecord("/v1/sale-view");
    if (targetIsReady(saleView)) {
      return { changed: true, taskId: operationId, mode: operationMode };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(
    `fixture stock did not become sale-ready after ${operationMode}: ${JSON.stringify(fixtureReadinessSnapshot(saleView))}`,
  );
}

export function fixtureAllocationForTrack(
  fixtureAllocation: FixtureAllocation | null | undefined,
  track: Track,
): FixtureAllocation | null {
  const key = String(track?.fixtureKey ?? track.key);
  const fixture = fixtureAllocation?.[key];
  return fixture ? { [key]: fixture } : null;
}

export async function clearWholeMachineLockIfPresent({
  daemonGet: get,
  daemonPost: post,
}: {
  daemonGet: (path: string) => Promise<unknown>;
  daemonPost: (path: string, body: unknown) => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const capability = asRecord(await get("/v1/sale-start-capability"));
  const blockers = Array.isArray(capability?.blockers)
    ? (capability.blockers as Array<Record<string, unknown>>)
    : [];
  const locked = blockers.some(
    (blocker) => blocker?.code === "WHOLE_MACHINE_LOCKED",
  );
  if (!locked) return { cleared: false };
  await post("/v1/hardware/self-check", {});
  const result = await post("/v1/maintenance/whole-machine-lock/clear", {
    operatorNote: "testbed business-set handoff recovery",
  });
  const refreshed = asRecord(await get("/v1/sale-start-capability"));
  const refreshedBlockers = Array.isArray(refreshed?.blockers)
    ? (refreshed.blockers as Array<Record<string, unknown>>)
    : [];
  if (
    refreshedBlockers.some(
      (blocker) => blocker?.code === "WHOLE_MACHINE_LOCKED",
    )
  ) {
    throw new Error("whole-machine lock remained after production recovery");
  }
  return { cleared: true, result };
}

export async function waitForBusinessHardwareReady({
  daemonGet: get,
  timeoutMs = HARDWARE_READY_TIMEOUT_MS,
  pollMs = 250,
}: {
  daemonGet: (path: string) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<Record<string, unknown>> {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const [bindings, capability] = await Promise.all([
      get("/v1/hardware-bindings").catch(() => null),
      get("/v1/sale-start-capability").catch(() => null),
    ]);
    const bindingsRecord = asRecord(bindings);
    const capabilityRecord = asRecord(capability);
    const roles = Array.isArray(bindingsRecord?.roles)
      ? (bindingsRecord.roles as Array<Record<string, unknown>>)
      : [];
    const lower = roles.find((role) => role?.role === "lower_controller");
    last = { lower: lower ?? null, capability: capabilityRecord };
    if (lower?.ready === true && capabilityRecord?.canStartSale === true) {
      return last;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  }
  throw new Error(
    `business hardware did not become ready: ${JSON.stringify(last)}`,
  );
}

export async function replaceUnavailableTestbedLowerController({
  capability,
  sessionId,
  replaceSerialSession,
}: {
  capability: Record<string, unknown> | null | undefined;
  sessionId: unknown;
  replaceSerialSession: (sessionId: unknown) => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const blockers = Array.isArray(capability?.blockers)
    ? (capability.blockers as Array<Record<string, unknown>>)
    : [];
  const unavailable = blockers.some(
    (blocker) => blocker?.code === "LOWER_CONTROLLER_UNAVAILABLE",
  );
  if (!unavailable) return { replaced: false };
  if (!sessionId) {
    throw new Error(
      "testbed lower controller is unavailable without a serial session",
    );
  }
  const replacement = await replaceSerialSession(sessionId);
  return { replaced: true, replacement };
}

export async function returnToCatalogFromClient({
  client,
  evaluateExpressionFn = evaluateExpression,
  waitForRouteFn = waitForRoute,
  activateVisibleSelectorFn = activateVisibleSelector,
  settleRouteTimeoutMs = 10_000,
}: {
  client: CdpClient;
  evaluateExpressionFn?: typeof evaluateExpression;
  waitForRouteFn?: typeof waitForRoute;
  activateVisibleSelectorFn?: typeof activateVisibleSelector;
  settleRouteTimeoutMs?: number;
}): Promise<string> {
  const routeValue = (result: unknown): string =>
    String((result as { route?: unknown } | null | undefined)?.route ?? "");
  const waitForRouteWithTimeout = (
    expected: string | RegExp | ((route: string) => boolean),
    timeoutMs = settleRouteTimeoutMs,
  ) =>
    waitForRouteFn(client, expected, {
      timeoutMs,
      pollMs: 250,
    });
  const activateUnlessAlreadyCatalog = async (
    selector: string,
    options: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      await activateVisibleSelectorFn(client, selector, options);
      return true;
    } catch (error) {
      if (
        (await evaluateExpressionFn(client, "location.hash")) === "#/catalog"
      ) {
        return false;
      }
      throw error;
    }
  };
  const returnFromProductToCatalog = async () => {
    if (
      !(await activateUnlessAlreadyCatalog(PRODUCT_DETAIL_RETURN_SELECTOR, {
        kind: "touch",
        timeoutMs: 10_000,
      }))
    )
      return "#/catalog";
    return routeValue(await waitForRouteWithTimeout("#/catalog"));
  };
  const returnFromCheckoutToCatalog = async () => {
    const emptyCheckoutCanReturn = await evaluateExpressionFn(
      client,
      `Boolean(document.querySelector(${JSON.stringify(CHECKOUT_EMPTY_RETURN_SELECTOR)})?.getClientRects().length)`,
    );
    if (emptyCheckoutCanReturn) {
      if (
        !(await activateUnlessAlreadyCatalog(CHECKOUT_EMPTY_RETURN_SELECTOR, {
          kind: "touch",
          timeoutMs: 10_000,
        }))
      )
        return "#/catalog";
      return routeValue(await waitForRouteWithTimeout("#/catalog"));
    }
    if (
      !(await activateUnlessAlreadyCatalog(CHECKOUT_BACK_PRODUCT_SELECTOR, {
        kind: "touch",
        timeoutMs: 10_000,
      }))
    )
      return "#/catalog";
    await waitForRouteWithTimeout(/^#\/products(?:\/|$)/, 10_000);
    return returnFromProductToCatalog();
  };
  let route = String(await evaluateExpressionFn(client, "location.hash"));
  if (route === "#/catalog") return route;
  if (route === "" || route === "#" || route === "#/") {
    route = routeValue(
      await waitForRouteWithTimeout(/^(?:#\/boot|#\/catalog)$/, 30_000),
    );
    if (route === "#/catalog") return "#/catalog";
  }
  if (route === "#/boot") {
    return routeValue(await waitForRouteWithTimeout("#/catalog", 30_000));
  }
  if (/^#\/result(?:\/|$)/.test(route)) {
    const activated = await activateUnlessAlreadyCatalog(
      '[data-test="result-return-catalog"]:not(:disabled)',
      {
        kind: "touch",
        timeoutMs: 10_000,
      },
    );
    if (!activated) return "#/catalog";
    return routeValue(await waitForRouteWithTimeout("#/catalog"));
  }
  if (route === "#/checkout") {
    return returnFromCheckoutToCatalog();
  }
  if (/^#\/products(?:\/|$)/.test(route)) {
    return returnFromProductToCatalog();
  }
  if (/^#\/payment(?:\/|$)/.test(route)) {
    try {
      if (
        !(await activateUnlessAlreadyCatalog(PAYMENT_CANCEL_SELECTOR, {
          kind: "touch",
          timeoutMs: 2_000,
        }))
      )
        return "#/catalog";
    } catch (error) {
      const projected = await waitForRouteWithTimeout(
        /^(?:#\/catalog|#\/result(?:\/|$)|#\/checkout|#\/products(?:\/|$))/,
        10_000,
      ).catch(() => null);
      if (!projected) throw error;
      route = routeValue(projected);
    }
    if (/^#\/payment(?:\/|$)/.test(route)) {
      route = routeValue(
        await waitForRouteWithTimeout(
          /^(?:#\/catalog|#\/result(?:\/|$)|#\/checkout|#\/products(?:\/|$))/,
          PAYMENT_RETURN_WAIT_MS,
        ),
      );
    }
    if (route === "#/catalog") return "#/catalog";
    if (/^#\/result(?:\/|$)/.test(route)) {
      if (
        !(await activateUnlessAlreadyCatalog(
          '[data-test="result-return-catalog"]:not(:disabled)',
          {
            kind: "touch",
            timeoutMs: 10_000,
          },
        ))
      )
        return "#/catalog";
      return routeValue(await waitForRouteWithTimeout("#/catalog"));
    }
    if (route === "#/checkout") {
      return returnFromCheckoutToCatalog();
    }
    if (/^#\/products(?:\/|$)/.test(route)) {
      return returnFromProductToCatalog();
    }
  }
  if (/^#\/maintenance(?:\?|$|\/)/.test(route)) {
    if (
      !(await activateUnlessAlreadyCatalog(
        '[data-test="maintenance-return-catalog"]:not(:disabled)',
        {
          kind: "touch",
          timeoutMs: 10_000,
        },
      ))
    )
      return "#/catalog";
    return routeValue(await waitForRouteWithTimeout("#/catalog", 30_000));
  }
  throw new Error(
    `no supported customer return control was available for ${route}`,
  );
}

export async function restoreCatalogHomeFromClient({
  client,
  returnToCatalogFn = returnToCatalogFromClient,
  evaluateExpressionFn = evaluateExpression,
  activateVisibleSelectorFn = activateVisibleSelector,
  waitForRouteFn = waitForRoute,
  waitForCatalogHomeStateFn = waitForCatalogHomeState,
  settleRouteTimeoutMs = 10_000,
}: {
  client: CdpClient;
  returnToCatalogFn?: typeof returnToCatalogFromClient;
  evaluateExpressionFn?: typeof evaluateExpression;
  activateVisibleSelectorFn?: typeof activateVisibleSelector;
  waitForRouteFn?: typeof waitForRoute;
  waitForCatalogHomeStateFn?: typeof waitForCatalogHomeState;
  settleRouteTimeoutMs?: number;
}): Promise<string> {
  await returnToCatalogFn({ client });
  const categoryIsOpen = await evaluateExpressionFn(
    client,
    'Boolean(document.querySelector(".catalog-back-button"))',
  );
  if (categoryIsOpen) {
    await activateVisibleSelectorFn(client, ".catalog-back-button", {
      kind: "touch",
      timeoutMs: 10_000,
    });
  }
  await waitForRouteFn(client, "#/catalog", {
    timeoutMs: settleRouteTimeoutMs,
    pollMs: 250,
  });
  return await waitForCatalogHomeStateFn({
    client,
    evaluateExpressionFn,
    timeoutMs: settleRouteTimeoutMs,
  });
}

export async function waitForCatalogHomeState({
  client,
  evaluateExpressionFn = evaluateExpression,
  timeoutMs = 10_000,
  pollMs = 250,
}: {
  client: CdpClient;
  evaluateExpressionFn?: typeof evaluateExpression;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state: Record<string, unknown> | null = null;
  do {
    state = (await evaluateExpressionFn(
      client,
      `(() => ({
        homeMarkerVisible: Boolean(document.querySelector('[data-test="catalog-page"]:not([data-category-key])')),
        categoryBackVisible: Boolean(document.querySelector('.catalog-back-button')),
      }))()`,
    )) as Record<string, unknown> | null;
    if (
      state?.homeMarkerVisible === true &&
      state.categoryBackVisible === false
    )
      return "#/catalog";
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  } while (Date.now() < deadline);
  throw new Error(`Catalog home did not settle: ${JSON.stringify(state)}`);
}

function terminalOperations(
  guestInput: Record<string, unknown> | null,
  handoff: Record<string, unknown> | null,
  handoffPath: string,
): {
  prepareTrack: () => Promise<unknown>;
  captureTerminal: (
    track: Track,
    context: { child: TrackChild; report: unknown },
  ) => Promise<Record<string, unknown>>;
  recover: (
    track: Track,
    context: { child: TrackChild; report: unknown; terminal: unknown },
  ) => Promise<Record<string, unknown>>;
} {
  const withClient = async <T>(
    operation: (client: CdpClient) => Promise<T>,
  ): Promise<T> => {
    reloadRuntimeHandoff(handoffPath, handoff ?? {});
    const attached = (await retryTransientBoundary(
      "machine UI CDP attach",
      async () => {
        const endpoint = required(
          (handoff?.cdp as Record<string, unknown> | undefined)?.endpoint,
          "handoff cdp endpoint",
        );
        const target = await discoverCanonicalMachineUiTarget({
          endpoint,
        });
        (handoff?.cdp as Record<string, unknown>).targetId = target.id;
        writeJson(handoffPath, handoff);
        const client = new CdpClient(
          rewriteWebSocketDebuggerUrl(target.webSocketDebuggerUrl, endpoint),
        );
        try {
          await client.connect();
          await enablePageRuntime(client);
          return { client, target };
        } catch (error) {
          await client.close().catch(() => undefined);
          throw error;
        }
      },
    )) as { client: CdpClient };
    const client = attached.client;
    try {
      return await operation(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  };
  return {
    prepareTrack: async () => {
      const capability = (await daemonGet(
        handoff,
        "/v1/sale-start-capability",
      ).catch(() => null)) as Record<string, unknown> | null;
      await replaceUnavailableTestbedLowerController({
        capability,
        sessionId: (
          handoff?.commissioningSerialSession as
            | Record<string, unknown>
            | undefined
        )?.sessionId,
        replaceSerialSession: (sessionId) =>
          replaceSerialSessionAndUpdateHandoff({
            guestInput: guestInput ?? {},
            handoff: handoff ?? {},
            handoffPath,
            sessionId,
            control: controlPlaneRequest,
          }),
      });
      await waitForBusinessHardwareReady({
        daemonGet: (path: string) => daemonGet(handoff, path),
      });
      await clearWholeMachineLockIfPresent({
        daemonGet: (path: string) => daemonGet(handoff, path),
        daemonPost: (path: string, body: unknown) =>
          daemonPost(handoff, path, body),
      });
      return withClient((client) => restoreCatalogHomeFromClient({ client }));
    },
    captureTerminal: async (track, context) => {
      reloadRuntimeHandoff(handoffPath, handoff ?? {});
      refreshDaemonReadyHandoff({ handoffPath, handoff: handoff ?? {} });
      return captureTrackTerminalFacts({
        track,
        context,
        readRoute: () => withClient((client) => readCdpLocationHash(client)),
        daemonGet: (path: string) => daemonGet(handoff, path),
        platformQuery: () =>
          controlPlaneRequest(guestInput, "/v1/platform/query", {
            runId: (guestInput ?? {}).runId,
            machineCode: (guestInput ?? {}).machineCode,
          }).then(
            (response) => (response as Record<string, unknown> | null)?.report,
          ),
      }) as Promise<Record<string, unknown>>;
    },
    recover: (track, context) =>
      recoverTrackHandoff({
        track,
        terminal: (context as Record<string, unknown>).terminal as
          | Record<string, unknown>
          | null
          | undefined,
        recoverAfterFailure:
          (context.child as TrackChild | undefined)?.status !== "passed" ||
          (context.report as Record<string, unknown> | null)?.ok !== true,
        fixtureAllocation: (guestInput ?? {}).fixtureAllocation as
          | FixtureAllocation
          | undefined,
        returnToCatalog: () =>
          withClient(async (client) => {
            return returnToCatalogFromClient({ client });
          }),
        disableFaultInjection: () =>
          controlPlaneRequest(guestInput, "/v1/mock-payment-create-gate/open"),
        restoreSerialSession: (sessionId: unknown) =>
          replaceSerialSessionAndUpdateHandoff({
            guestInput: guestInput ?? {},
            handoff: handoff ?? {},
            handoffPath,
            sessionId,
            control: controlPlaneRequest,
          }),
        cancelActiveTransaction: (
          transaction: Record<string, unknown> | null,
        ) =>
          daemonPost(handoff, "/v1/intents/cancel-order", {
            orderNo: required(
              transaction?.orderNo,
              "active transaction orderNo",
            ),
          }),
        waitForTransactionTerminal: async () => {
          const deadline = Date.now() + 30_000;
          let transaction = null;
          while (Date.now() < deadline) {
            transaction = await daemonGet(handoff, "/v1/transactions/current");
            if (!isActiveTransaction(transaction)) return transaction;
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 500),
            );
          }
          return transaction;
        },
        readLateTransaction: async () => {
          const deadline = Date.now() + 2_000;
          let transaction = null;
          do {
            transaction = await daemonGet(handoff, "/v1/transactions/current");
            if (isActiveTransaction(transaction)) return transaction;
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 100),
            );
          } while (Date.now() < deadline);
          return transaction;
        },
        selfCheckHardware: () =>
          daemonPost(handoff, "/v1/hardware/self-check", {}),
        clearWholeMachineLock: (operatorNote: unknown) =>
          daemonPost(handoff, "/v1/maintenance/whole-machine-lock/clear", {
            operatorNote,
          }),
        wholeMachineLockOperatorNote: "testbed business-set handoff recovery",
        restoreFixtureStock: async (fixture: FixtureAllocationEntry) => {
          const allocation = {
            [track.fixtureKey ?? track.key]: fixture,
          };
          const daemon = await ensureFixtureStockReady({
            fixtureAllocation: allocation,
            daemonGet: (path) => daemonGet(handoff, path),
            daemonPost: (path, body) => daemonPost(handoff, path, body),
          });
          const platform = await waitForPlatformFixtureStock({
            guestInput,
            fixtureAllocation: allocation,
          });
          return { targetQuantity: fixture.onHandQty, daemon, platform };
        },
      }) as Promise<Record<string, unknown>>,
  };
}

interface OrchestratorOptions {
  mode: string;
  focus?: string[];
  commit?: string | null;
  guestInputPath: string;
  handoffPath: string;
  outPath: string;
}

interface OrchestratorDependencies {
  clearEvidenceManifest?: (path: string) => void;
  clearAggregate?: (path: string) => void;
  writeEvidenceManifest?: (path: string, value: unknown) => void;
  readEvidenceManifest?: (path: string) => Buffer;
  validateEvidenceManifest?: (value: unknown) => string[];
  buildEvidenceManifest?: (context: Record<string, unknown>) => unknown;
  writeAggregate?: (path: string, value: unknown) => void;
  runTrack?: (track: Track) => Promise<TrackChild>;
  beforeTrack?: (track: Track) => unknown;
  captureTerminal?: (
    track: Track,
    context: { child: TrackChild; report: unknown },
  ) => Promise<Record<string, unknown>>;
  recover?: (
    track: Track,
    context: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  emitTrackProgress?: (event: Record<string, unknown>) => unknown;
  now?: () => Date;
  clearTrackReport?: (path: string | null, track: Track) => void;
  clearTrackArtifacts?: (path: string | null, track: Track) => void;
}

export async function runFullWorkflowOrchestrator(
  options: OrchestratorOptions,
  dependencies: OrchestratorDependencies = {},
): Promise<Record<string, unknown>> {
  const evidenceManifestPath = join(
    dirname(resolve(options.outPath)),
    "full-workflow-evidence-manifest.json",
  );
  const clearEvidenceManifest =
    dependencies.clearEvidenceManifest ??
    ((path) => rmSync(path, { force: true }));
  const clearAggregate =
    dependencies.clearAggregate ?? ((path) => rmSync(path, { force: true }));
  try {
    clearEvidenceManifest(evidenceManifestPath);
  } catch {}
  try {
    clearAggregate(options.outPath);
  } catch {}
  const guestInput = jsonIfPresent(options.guestInputPath) as Record<
    string,
    unknown
  > | null;
  const plan = buildWorkflowTrackCommands(options);
  const handoff = jsonIfPresent(options.handoffPath) as Record<
    string,
    unknown
  > | null;
  const operations =
    dependencies.captureTerminal ||
    dependencies.recover ||
    !guestInput ||
    !handoff
      ? null
      : terminalOperations(guestInput, handoff, options.handoffPath);
  const executedTracks = await runSerialTrackLifecycle({
    tracks: plan.tracks,
    runTrack:
      dependencies.runTrack ??
      ((track) => runTrack(track.command ?? [], track.key)),
    beforeTrack:
      dependencies.beforeTrack ??
      (async (track) => {
        await waitForDaemonReadyRefresh(handoff);
        const refreshed = refreshDaemonReadyHandoff({
          handoffPath: options.handoffPath,
          handoff,
        });
        await waitForInstalledRuntimeBarrier(refreshed);
        await operations?.prepareTrack();
        const fixtureAllocation = fixtureAllocationForTrack(
          (guestInput ?? {}).fixtureAllocation as FixtureAllocation | undefined,
          track,
        );
        if (fixtureAllocation) {
          await ensureFixtureStockReady({
            fixtureAllocation,
            daemonGet: (path) => daemonGet(refreshed, path),
            daemonPost: (path, body) => daemonPost(refreshed, path, body),
          });
          await waitForPlatformFixtureStock({
            guestInput,
            fixtureAllocation,
          });
        }
      }),
    captureTerminal:
      dependencies.captureTerminal ??
      operations?.captureTerminal ??
      (async () => ({
        ok: false,
        facts: null,
        reason: "terminal inputs are unavailable",
      })),
    recover:
      dependencies.recover ??
      operations?.recover ??
      (async () => ({
        ok: false,
        actions: [],
        errors: ["handoff inputs are unavailable"],
      })),
    haltOnRecoveryFailure: options.mode === "fast",
    emitTrackProgress:
      dependencies.emitTrackProgress ??
      ((event: Record<string, unknown>) => {
        if (event.type === "started") {
          process.stdout.write(
            `track=${(event.track as Track).key} status=started startedAt=${event.startedAt}\n`,
          );
        } else if (event.type === "finished") {
          const track = event.result as Record<string, unknown>;
          process.stdout.write(
            `track=${track.key} status=${track.businessStatus} durationMs=${track.durationMs} failureStage=${track.failureStage ?? "none"} error=${track.error ?? "none"}\n`,
          );
        }
      }),
    now: dependencies.now,
    clearReport: dependencies.clearTrackReport ?? clearTrackReport,
    clearArtifacts: dependencies.clearTrackArtifacts ?? clearTrackArtifacts,
  });
  const evidenceTracks = plan.tracks.map((track) => {
    const result = executedTracks.find((entry) => entry.key === track.key);
    return {
      ...track,
      result: result ?? {
        status: "blocked",
        businessStatus: "failed",
        error: "business track was not executed",
        evidenceTrust: { report: false, artifactRoot: false },
      },
    };
  });
  const evidenceErrors = [];
  let evidenceManifest;
  try {
    evidenceManifest = (
      (dependencies.buildEvidenceManifest ??
        buildFullWorkflowEvidenceManifest) as (
        context: Record<string, unknown>,
      ) => unknown
    )({ tracks: evidenceTracks });
  } catch (error) {
    const reason = supportingEvidenceFailure(
      "evidence manifest capture failed",
      error,
    );
    evidenceErrors.push(reason);
    evidenceManifest = unavailableEvidenceManifest({
      tracks: evidenceTracks,
      reason,
    });
  }
  let evidenceManifestFile = null;
  let publishedEvidenceManifestPath = null;
  try {
    clearEvidenceManifest(evidenceManifestPath);
    (dependencies.writeEvidenceManifest ?? writeJson)(
      evidenceManifestPath,
      evidenceManifest,
    );
    const evidenceManifestBytes = (
      dependencies.readEvidenceManifest ?? readFileSync
    )(evidenceManifestPath);
    evidenceManifestFile = {
      byteLength: evidenceManifestBytes.byteLength,
      sha256: createHash("sha256").update(evidenceManifestBytes).digest("hex"),
    };
    publishedEvidenceManifestPath = evidenceManifestPath;
  } catch (error) {
    try {
      clearEvidenceManifest(evidenceManifestPath);
    } catch {}
    evidenceErrors.push(
      supportingEvidenceFailure("evidence manifest persistence failed", error),
    );
  }
  try {
    evidenceErrors.push(
      ...(
        (dependencies.validateEvidenceManifest ??
          validateFullWorkflowEvidenceManifest) as (
          manifest: unknown,
        ) => string[]
      )(evidenceManifest),
    );
  } catch (error) {
    evidenceErrors.push(
      supportingEvidenceFailure("evidence manifest validation failed", error),
    );
  }
  const aggregate = (
    buildFullWorkflowAggregate as unknown as (
      options: Record<string, unknown>,
    ) => Record<string, unknown>
  )({
    mode: options.mode,
    selectedDescriptors: plan.tracks,
    identity: workflowIdentity(options.guestInputPath, options.commit),
    executedTracks,
    evidenceManifestPath: publishedEvidenceManifestPath,
    evidenceManifest,
    evidenceManifestFile,
    evidenceValidationErrors: evidenceErrors,
  });
  (aggregate as Record<string, unknown>).operationalOutcome = {
    ok: true,
    failures: [],
    canonicalResultPath: resolve(options.outPath),
  };
  try {
    (dependencies.writeAggregate ?? writeJson)(options.outPath, aggregate);
  } catch (error) {
    try {
      clearAggregate(options.outPath);
    } catch {}
    (aggregate as Record<string, unknown>).operationalOutcome = {
      ok: false,
      failures: [
        supportingEvidenceFailure(
          "canonical aggregate persistence failed",
          error,
        ),
      ],
      canonicalResultPath: null,
    };
  }
  return aggregate;
}

export function fullWorkflowCommandSucceeded(
  aggregate: Record<string, unknown> | null | undefined,
): boolean {
  return (
    aggregate?.ok === true &&
    (aggregate?.operationalOutcome as Record<string, unknown> | undefined)
      ?.ok === true
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const aggregate = await runFullWorkflowOrchestrator(options);
  if (!fullWorkflowCommandSucceeded(aggregate)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
