import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const REQUIRED_FRAME_ORDER = ["F0", "F1", "F2"];

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function timestamp(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function sameBinding(entry, binding) {
  return (
    entry.orderId === binding.orderId &&
    entry.paymentId === binding.paymentId &&
    entry.commandId === binding.commandId &&
    entry.sessionId === binding.sessionId
  );
}

export function validateProductionTransactionTrace({ entries, binding }) {
  if (!Array.isArray(entries) || entries.length !== 5) {
    throw new Error(
      "production transaction trace must contain payment, F0, F1, F2, and result",
    );
  }
  const boundaryIds = new Set();
  let previousAt = -Infinity;
  for (const [index, entry] of entries.entries()) {
    if (!sameBinding(entry, binding)) {
      throw new Error(
        `production transaction trace entry ${index + 1} has a different sale binding`,
      );
    }
    const at = timestamp(
      entry.at,
      `production transaction trace entry ${index + 1} at`,
    );
    if (at <= previousAt) {
      throw new Error(
        "production transaction trace timestamps must be strictly ordered",
      );
    }
    previousAt = at;
    const boundaryId = required(
      entry.boundaryId,
      "production transaction trace boundaryId",
    );
    if (boundaryIds.has(boundaryId)) {
      throw new Error(
        "production transaction trace boundary IDs must be unique",
      );
    }
    boundaryIds.add(boundaryId);
  }
  const expected = ["payment", "F0", "F1", "F2", "result"];
  if (
    JSON.stringify(entries.map((entry) => entry.type)) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      "production transaction trace order must be payment -> F0 -> F1 -> F2 -> result",
    );
  }
  for (const entry of entries.slice(1, 4)) {
    if (entry.rawFrame?.rawFrameHex !== `55${entry.type}`) {
      throw new Error(
        `production transaction trace ${entry.type} must retain its exact raw frame`,
      );
    }
    timestamp(
      entry.rawFrame?.observedAt,
      `production transaction trace ${entry.type} raw frame observedAt`,
    );
    required(
      entry.rawFrame?.boundaryId,
      `production transaction trace ${entry.type} raw frame boundaryId`,
    );
    if (entry.rawFrame.boundaryId !== entry.boundaryId) {
      throw new Error(
        `production transaction trace ${entry.type} raw frame boundary ID must match its trace boundary`,
      );
    }
  }
  const result = entries.at(-1);
  if (
    result.surface?.route !== "#/result/success" ||
    result.surface?.kind !== "success"
  ) {
    throw new Error(
      "production transaction trace result must bind the successful UI surface",
    );
  }
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export function createProductionTransactionTrace({
  stateRoot,
  sessionId,
  now = () => new Date().toISOString(),
}) {
  const tracePath = join(
    stateRoot,
    "fast-route",
    `${required(sessionId, "sessionId")}.production-transaction-trace.jsonl`,
  );
  const entries = [];
  let binding = null;
  let lastAtMs = -Infinity;

  function nextAt() {
    const observedAtMs = timestamp(
      now(),
      "production transaction trace timestamp",
    );
    const atMs = Math.max(observedAtMs, lastAtMs + 1);
    lastAtMs = atMs;
    return new Date(atMs).toISOString();
  }

  function append(entry) {
    const at = entry.at ?? nextAt();
    lastAtMs = Math.max(
      lastAtMs,
      timestamp(at, "production transaction trace timestamp"),
    );
    const boundaryId =
      entry.boundaryId ?? `${entry.type.toLowerCase()}:${entries.length + 1}`;
    const recorded = Object.freeze({ ...entry, at, boundaryId });
    entries.push(recorded);
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${JSON.stringify(recorded)}\n`, { mode: 0o600 });
    return recorded;
  }

  return {
    payment(input) {
      if (binding)
        throw new Error(
          "production transaction trace payment is already bound",
        );
      binding = Object.freeze({
        orderId: required(input.orderId, "orderId"),
        paymentId: required(input.paymentId, "paymentId"),
        commandId: required(input.commandId, "commandId"),
        sessionId,
      });
      return append({
        type: "payment",
        ...binding,
        paymentNo: required(input.paymentNo, "paymentNo"),
      });
    },
    controllerFrame(frame) {
      const type = required(frame?.parsedOpcode, "parsedOpcode");
      if (!REQUIRED_FRAME_ORDER.includes(type)) return null;
      if (!binding)
        throw new Error(
          "production transaction trace must bind payment before controller frames",
        );
      const expected = REQUIRED_FRAME_ORDER[entries.length - 1];
      if (type !== expected) {
        throw new Error(
          `production transaction trace expected ${expected ?? "result"} before ${type}`,
        );
      }
      const rawFrameHex = required(frame.rawFrameHex, "rawFrameHex");
      if (rawFrameHex !== `55${type}`) {
        throw new Error(
          `production transaction trace ${type} must use the exact production raw frame`,
        );
      }
      const boundaryId = `${type.toLowerCase()}:${entries.length + 1}`;
      const observedAt = nextAt();
      return append({
        type,
        ...binding,
        rawFrame: {
          direction: required(frame.direction, "raw frame direction"),
          rawFrameHex,
          sequence: frame.sequence,
          observedAt,
          boundaryId,
        },
        boundaryId,
        at: observedAt,
      });
    },
    result(surface) {
      if (!binding)
        throw new Error(
          "production transaction trace must bind payment before result",
        );
      if (entries.length < 4 || entries.at(-1)?.type !== "F2") {
        throw new Error(
          "production transaction trace rejects success before F2",
        );
      }
      if (
        surface?.route !== "#/result/success" ||
        surface?.result?.kind !== "success" ||
        surface.result.orderId !== binding.orderId ||
        surface.result.paymentId !== binding.paymentId ||
        surface.result.commandId !== binding.commandId
      ) {
        throw new Error(
          "production transaction trace result must match the bound successful UI surface",
        );
      }
      return append({
        type: "result",
        ...binding,
        surface: { route: surface.route, kind: surface.result.kind },
      });
    },
    entries: () => entries.map((entry) => ({ ...entry })),
    validate: () => validateProductionTransactionTrace({ entries, binding }),
    tracePath,
  };
}
