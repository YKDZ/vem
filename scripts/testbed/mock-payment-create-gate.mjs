import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

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

export function writePaymentMockCreateGateState(stateRoot, value) {
  const gate = paymentMockCreateGatePaths(stateRoot);
  mkdirSync(dirname(gate.statePath), { recursive: true });
  writeFileSync(gate.statePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
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
  mkdirSync(dirname(fault.statePath), { recursive: true });
  writeFileSync(fault.statePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
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
