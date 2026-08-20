import {
  visionV2CapturedFrameSchema,
  visionV2ServerMessageSchema,
} from "../../../../../packages/shared/src/schemas/vision-v2.ts";

export interface CapturedFrameFacts {
  reference: string;
  digest: string;
  contentType: "image/png";
  byteSize: number;
  width: number;
  height: number;
  frameId: string;
}

export interface CapturedFrameResource {
  attemptId: string;
  capturedDigest: string;
  capturedFrameId: string;
  visionOrigin: string;
  reference: string;
  finalUrl: string;
  ok: true;
  httpStatus: 200;
  contentType: "image/png";
  byteSize: number;
  digest: string;
  width: number;
  height: number;
}

export type VisionAttemptPayload = Record<string, unknown> & {
  attemptId: string;
  captured?: CapturedFrameFacts;
};

export interface VisionProtocolEvent {
  type: string;
  requestId: string;
  origin: string;
  payload: VisionAttemptPayload;
}

export interface CapturedSourceBinding {
  attemptId: string;
  visionOrigin: string;
  requestId: string;
  captured: CapturedFrameFacts;
  resource: CapturedFrameResource;
  terminal: VisionProtocolEvent;
}

export interface CapturedSourceEvidence extends CapturedSourceBinding {
  kind: "vision-v2-captured-source";
  protocolTimeline: VisionProtocolEvent[];
}

const ATTEMPT_EVENT_TYPES = new Set([
  "vision.try_on.attempt.accepted",
  "vision.try_on.attempt.acquiring",
  "vision.try_on.attempt.captured",
  "vision.try_on.attempt.generating",
  "vision.try_on.attempt.completed",
  "vision.try_on.attempt.failed",
  "vision.try_on.attempt.canceled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export function hasSameCapturedEvidenceValue(
  left: unknown,
  right: unknown,
): boolean {
  return canonical(left) === canonical(right);
}

/** 将配置的 Vision base URL 归一化为唯一允许的 HTTP loopback origin。 */
export function normalizeVisionOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(
        url.hostname.toLowerCase(),
      ) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function hasVisionOrigin(
  reference: unknown,
  visionOrigin: unknown,
): boolean {
  const origin = normalizeVisionOrigin(visionOrigin);
  if (typeof reference !== "string" || !origin) return false;
  try {
    return new URL(reference).origin === origin;
  } catch {
    return false;
  }
}

function parseEvent(value: unknown): VisionProtocolEvent | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null;
  const { type, requestId, origin } = value;
  if (
    typeof type !== "string" ||
    !ATTEMPT_EVENT_TYPES.has(type) ||
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    typeof origin !== "string" ||
    !normalizeVisionOrigin(origin)
  ) {
    return null;
  }
  const parsedMessage = visionV2ServerMessageSchema.safeParse({
    protocol: "vem.vision.v2",
    messageId: "captured-evidence",
    timestamp: "2026-01-01T00:00:00.000Z",
    type,
    payload: value.payload,
  });
  if (!parsedMessage.success) {
    return null;
  }
  const payload = parsedMessage.data.payload as VisionAttemptPayload;
  if (typeof payload.attemptId !== "string" || payload.attemptId.length === 0) {
    return null;
  }
  return {
    type,
    requestId,
    origin: normalizeVisionOrigin(origin)!,
    payload: structuredClone(payload),
  };
}

function parseResource(
  value: unknown,
  binding: {
    attemptId: string;
    visionOrigin: string;
    captured: CapturedFrameFacts;
  },
): CapturedFrameResource | null {
  if (!isRecord(value)) return null;
  const resource = value as Partial<CapturedFrameResource>;
  if (
    resource.attemptId !== binding.attemptId ||
    resource.capturedDigest !== binding.captured.digest ||
    resource.capturedFrameId !== binding.captured.frameId ||
    normalizeVisionOrigin(resource.visionOrigin) !== binding.visionOrigin ||
    resource.reference !== binding.captured.reference ||
    resource.finalUrl !== binding.captured.reference ||
    resource.ok !== true ||
    resource.httpStatus !== 200 ||
    resource.contentType !== "image/png" ||
    resource.byteSize !== binding.captured.byteSize ||
    resource.digest !== binding.captured.digest ||
    resource.width !== binding.captured.width ||
    resource.height !== binding.captured.height
  ) {
    return null;
  }
  return resource as CapturedFrameResource;
}

/**
 * 在 acceptance report 边界重新验证 attempt、Vision websocket、captured 事实、
 * 已下载资源与 completed terminal 是同一条不可混用的证据链。
 */
export function validateCapturedSourceEvidence(
  value: unknown,
): CapturedSourceEvidence | null {
  if (!isRecord(value) || value.kind !== "vision-v2-captured-source") {
    return null;
  }
  const attemptId = value.attemptId;
  const visionOrigin = normalizeVisionOrigin(value.visionOrigin);
  const requestId = value.requestId;
  const capturedResult = visionV2CapturedFrameSchema.safeParse(value.captured);
  if (
    typeof attemptId !== "string" ||
    attemptId.length === 0 ||
    !visionOrigin ||
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    !capturedResult.success ||
    !hasVisionOrigin(capturedResult.data.reference, visionOrigin) ||
    !Array.isArray(value.protocolTimeline)
  ) {
    return null;
  }
  const timeline = value.protocolTimeline.map(parseEvent);
  if (timeline.some((event) => event === null)) return null;
  const events = timeline as VisionProtocolEvent[];
  if (
    events.length === 0 ||
    events.some(
      (event) =>
        event.payload.attemptId !== attemptId ||
        event.requestId !== requestId ||
        event.origin !== visionOrigin,
    )
  ) {
    return null;
  }
  const indexOf = (type: string) =>
    events.findIndex((event) => event.type === type);
  const accepted = indexOf("vision.try_on.attempt.accepted");
  const acquiring = indexOf("vision.try_on.attempt.acquiring");
  const captured = indexOf("vision.try_on.attempt.captured");
  const generating = indexOf("vision.try_on.attempt.generating");
  const completed = indexOf("vision.try_on.attempt.completed");
  const capturedEvents = events.filter(
    (event) => event.type === "vision.try_on.attempt.captured",
  );
  const terminalEvents = events.filter((event) =>
    [
      "vision.try_on.attempt.completed",
      "vision.try_on.attempt.failed",
      "vision.try_on.attempt.canceled",
    ].includes(event.type),
  );
  if (
    accepted < 0 ||
    acquiring < 0 ||
    captured < 0 ||
    generating < 0 ||
    completed < 0 ||
    !(
      accepted < acquiring &&
      acquiring < captured &&
      captured < generating &&
      generating < completed
    ) ||
    capturedEvents.length !== 1 ||
    terminalEvents.length !== 1 ||
    events.at(-1)?.type !== "vision.try_on.attempt.completed" ||
    !hasSameCapturedEvidenceValue(
      capturedEvents[0]?.payload.captured,
      capturedResult.data,
    )
  ) {
    return null;
  }
  const terminal = events.at(-1)!;
  if (!hasSameCapturedEvidenceValue(value.terminal, terminal)) return null;
  const resource = parseResource(value.resource, {
    attemptId,
    visionOrigin,
    captured: capturedResult.data,
  });
  if (!resource) return null;
  return {
    kind: "vision-v2-captured-source",
    attemptId,
    visionOrigin,
    requestId,
    captured: capturedResult.data,
    resource,
    terminal,
    protocolTimeline: events,
  };
}

export function capturedSourceBinding(
  evidence: CapturedSourceEvidence,
): CapturedSourceBinding {
  return {
    attemptId: evidence.attemptId,
    visionOrigin: evidence.visionOrigin,
    requestId: evidence.requestId,
    captured: evidence.captured,
    resource: evidence.resource,
    terminal: evidence.terminal,
  };
}
