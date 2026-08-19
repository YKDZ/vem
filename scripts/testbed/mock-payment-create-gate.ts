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

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function paymentMockCreateGatePaths(stateRoot) {
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

export function paymentMockQueryFaultPaths(stateRoot) {
  const statePath = join(
    resolve(required(stateRoot, "stateRoot")),
    "fast-route",
    "mock-payment-query-fault.json",
  );
  return Object.freeze({ statePath });
}

export function replaceJsonFileAtomically(path, value) {
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

export function writePaymentMockCreateGateState(stateRoot, value) {
  const gate = paymentMockCreateGatePaths(stateRoot);
  replaceJsonFileAtomically(gate.statePath, value);
  if (value?.state === "open" || value?.state === "hold") {
    rmSync(gate.pendingPath, { force: true });
  }
  return gate;
}

export function readPaymentMockCreateGateStatus(stateRoot) {
  const gate = paymentMockCreateGatePaths(stateRoot);
  const readJson = (path) =>
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const state = readJson(gate.statePath);
  const pending = readJson(gate.pendingPath);
  return {
    state: typeof state?.state === "string" ? state.state : "open",
    timeoutMs: Number.isInteger(state?.timeoutMs) ? state.timeoutMs : null,
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

export function writePaymentMockQueryFaultState(stateRoot, value) {
  const fault = paymentMockQueryFaultPaths(stateRoot);
  replaceJsonFileAtomically(fault.statePath, value);
  return fault;
}

export function readPaymentMockQueryFaultStatus(stateRoot) {
  const fault = paymentMockQueryFaultPaths(stateRoot);
  if (!existsSync(fault.statePath)) return { state: "open", paymentNo: null };
  const state = JSON.parse(readFileSync(fault.statePath, "utf8"));
  return {
    state: state?.state === "fail" ? "fail" : "open",
    paymentNo: typeof state?.paymentNo === "string" ? state.paymentNo : null,
  };
}
