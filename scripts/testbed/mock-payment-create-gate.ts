import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function paymentMockCreateGatePaths(stateRoot: unknown): JsonRecord {
  const statePath = join(
    resolve(required(stateRoot, "stateRoot")),
    "fast-route",
    "mock-payment-create-gate.json",
  );
  return Object.freeze({
    statePath,
    pendingPath: `${statePath}.pending.json`,
  });
}

export function paymentMockQueryFaultPaths(stateRoot: unknown): JsonRecord {
  const statePath = join(
    resolve(required(stateRoot, "stateRoot")),
    "fast-route",
    "mock-payment-query-fault.json",
  );
  return Object.freeze({ statePath });
}

export function replaceJsonFileAtomically(
  path: unknown,
  value: JsonRecord,
): string {
  const statePath = resolve(required(path, "path"));
  const directory = dirname(statePath);
  const temporaryPath = join(
    directory,
    `.${basename(statePath)}.${randomUUID()}.tmp`,
  );
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, statePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return statePath;
}

export function writePaymentMockCreateGateState(
  stateRoot: unknown,
  value: JsonRecord,
): JsonRecord {
  const gate = paymentMockCreateGatePaths(stateRoot);
  replaceJsonFileAtomically(gate.statePath, value);
  if (value?.state === "open" || value?.state === "hold") {
    rmSync(String(gate.pendingPath), { force: true });
  }
  return gate;
}

export function readPaymentMockCreateGateStatus(
  stateRoot: unknown,
): JsonRecord {
  const gate = paymentMockCreateGatePaths(stateRoot);
  const readJson = (path: string): JsonRecord | null =>
    existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as JsonRecord)
      : null;
  const state = readJson(String(gate.statePath));
  const pending = readJson(String(gate.pendingPath));
  return {
    state: typeof state?.state === "string" ? state.state : "open",
    timeoutMs: Number.isInteger(state?.timeoutMs)
      ? state?.timeoutMs
      : null,
    pending:
      pending?.state === "pending" &&
      typeof pending.paymentNo === "string" &&
      typeof pending.observedAt === "string"
        ? {
            state: "pending",
            paymentNo: pending.paymentNo,
            observedAt: pending.observedAt,
          }
        : null,
  };
}

export function writePaymentMockQueryFaultState(
  stateRoot: unknown,
  value: JsonRecord,
): JsonRecord {
  const fault = paymentMockQueryFaultPaths(stateRoot);
  replaceJsonFileAtomically(fault.statePath, value);
  return fault;
}

export function readPaymentMockQueryFaultStatus(
  stateRoot: unknown,
): JsonRecord {
  const fault = paymentMockQueryFaultPaths(stateRoot);
  if (!existsSync(String(fault.statePath)))
    return { state: "open", paymentNo: null };
  const state = recordValue(
    JSON.parse(readFileSync(String(fault.statePath), "utf8")),
  );
  return {
    state: state?.state === "fail" ? "fail" : "open",
    paymentNo: typeof state?.paymentNo === "string" ? state.paymentNo : null,
  };
}
