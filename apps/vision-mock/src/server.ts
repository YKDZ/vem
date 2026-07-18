import {
  DEFAULT_VISION_WS_URL,
  VISION_PROTOCOL,
  visionClientMessageSchema,
  visionServerMessageSchema,
  type VisionClientMessage,
  type VisionErrorCode,
  type VisionServerMessage,
} from "@vem/shared/schemas/vision";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

export const MOCK_VISION_SCENARIOS = [
  "success",
  "no_person",
  "presence_only",
  "presence_absent",
  "departure_after_presence",
  "controlled",
  "disconnect_once",
  "camera_unavailable",
  "try_on_unavailable_handshake",
  "try_on_unavailable_start",
] as const;

export type MockVisionScenario = (typeof MOCK_VISION_SCENARIOS)[number];

export interface MockVisionServerOptions {
  host?: string;
  port?: number;
  path?: string;
  scenario?: MockVisionScenario;
  pushIntervalMs?: number;
  controlPort?: number | null;
}

export interface MockVisionServer {
  ready: Promise<string>;
  close: () => Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7892;
const DEFAULT_PATH = "/ws";
const DEFAULT_PUSH_INTERVAL_MS = 1000;
const DEFAULT_CONTROL_PATH = "/control";

function nowIso(): string {
  return new Date().toISOString();
}

function messageId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function baseEnvelope(
  prefix: string,
): Pick<VisionServerMessage, "protocol" | "messageId" | "timestamp"> {
  return {
    protocol: VISION_PROTOCOL,
    messageId: messageId(prefix),
    timestamp: nowIso(),
  };
}

function createReadyMessage(): VisionServerMessage {
  const message = {
    ...baseEnvelope("ready"),
    type: "vision.ready",
    payload: {
      serverName: "vem-vision-mock",
      serverVersion: "0.2.0",
      cameraReady: true,
      modelReady: true,
      capabilities: [
        "profile_push",
        "presence_status",
        "person_departed",
        "ambient_light",
        "try_on_session",
      ],
    },
  } satisfies VisionServerMessage;
  return message;
}

function createPongMessage(): VisionServerMessage {
  const message = {
    ...baseEnvelope("pong"),
    type: "vision.pong",
    payload: {},
  } satisfies VisionServerMessage;
  return message;
}

function createResultMessage(): VisionServerMessage {
  const detectedAt = nowIso();
  const message = {
    ...baseEnvelope("result"),
    type: "vision.profile_result",
    payload: {
      eventId: messageId("event"),
      detectedAt,
      occupancy: {
        state: "single",
        confidence: 0.88,
      },
      profile: {
        personPresent: true,
        heightCm: 172,
        shoulderWidthCm: 43,
        ageRange: "adult",
        gender: "unknown",
        bodyType: "regular",
        upperColor: "dark",
        confidence: 0.86,
      },
      quality: {
        overall: "fair",
        warnings: [],
        profileUsable: true,
        sampleCount: 1,
        validFrameCount: 1,
      },
    },
  } satisfies VisionServerMessage;
  return message;
}

function createPresenceMessage(
  state: "approach" | "empty",
): VisionServerMessage {
  const detectedAt = nowIso();
  const personPresent = state !== "empty";
  const payload = {
    eventId: messageId("presence-event"),
    state,
    detectedAt,
    reason: personPresent ? "person_present_but_not_close" : "no_person",
    personPresent,
    occupancy: {
      state: personPresent ? "single" : "none",
      confidence: 0.86,
    },
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: {
      present: personPresent,
      closeNow: false,
      close: false,
      method: "person_detector+face_area_ratio",
    },
  } satisfies VisionServerMessage["payload"];
  const message = {
    ...baseEnvelope("presence"),
    type: "vision.presence_status",
    payload,
  } satisfies VisionServerMessage;
  return message;
}

function createPersonDepartedMessage(
  lastSeenAt: string | null,
): VisionServerMessage {
  const detectedAt = nowIso();
  const payload = {
    eventId: messageId("departure-event"),
    detectedAt,
    lastSeenAt,
    reason: "left_frame",
    absenceDurationMs: 1200,
  } satisfies VisionServerMessage["payload"];
  const message = {
    ...baseEnvelope("departure"),
    type: "vision.person_departed",
    payload,
  } satisfies VisionServerMessage;
  return message;
}

function createErrorMessage(input: {
  eventId?: string;
  code: VisionErrorCode;
  message: string;
  retryable: boolean;
}): VisionServerMessage {
  const message = {
    ...baseEnvelope("error"),
    type: "vision.error",
    payload: {
      eventId: input.eventId,
      code: input.code,
      message: input.message,
      retryable: input.retryable,
    },
  } satisfies VisionServerMessage;
  return message;
}

function createTryOnStartedMessage(sessionId: string): VisionServerMessage {
  const message = {
    ...baseEnvelope("try-on-started"),
    type: "vision.try_on.started",
    payload: {
      sessionId,
      previewUrl: "http://127.0.0.1:7892/try-on/mock.mjpeg",
      streamType: "mjpeg",
    },
  } satisfies VisionServerMessage;
  return message;
}

function createTryOnStoppedMessage(sessionId: string): VisionServerMessage {
  const message = {
    ...baseEnvelope("try-on-stopped"),
    type: "vision.try_on.stopped",
    payload: {
      sessionId,
      reason: "client_stop",
    },
  } satisfies VisionServerMessage;
  return message;
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((sum, entry) => sum + entry.length, 0) > 64 * 1024) {
      throw new Error("request body too large");
    }
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendServerMessage(
  socket: WebSocket,
  message: VisionServerMessage,
): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(visionServerMessageSchema.parse(message)));
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function parseClientMessage(data: RawData): VisionClientMessage | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawDataToText(data));
  } catch {
    return null;
  }
  const parsed = visionClientMessageSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

async function pushScenarioEvents(
  socket: WebSocket,
  options: Required<
    Pick<MockVisionServerOptions, "scenario" | "pushIntervalMs">
  >,
  presenceStatusEnabled: boolean,
  personDepartedEnabled: boolean,
): Promise<void> {
  await delay(options.pushIntervalMs);
  if (socket.readyState !== socket.OPEN) return;

  if (options.scenario === "camera_unavailable") {
    sendServerMessage(
      socket,
      createErrorMessage({
        code: "camera_unavailable",
        message: "模拟摄像头不可用",
        retryable: true,
      }),
    );
    return;
  }

  if (options.scenario === "no_person") {
    if (presenceStatusEnabled) {
      sendServerMessage(socket, createPresenceMessage("empty"));
    }
    return;
  }

  if (options.scenario === "presence_absent") {
    if (presenceStatusEnabled) {
      sendServerMessage(socket, createPresenceMessage("empty"));
    }
    return;
  }

  if (presenceStatusEnabled) {
    const presence = createPresenceMessage("approach");
    sendServerMessage(socket, presence);
    if (
      options.scenario === "departure_after_presence" &&
      personDepartedEnabled
    ) {
      await delay(options.pushIntervalMs);
      const lastSeenAt =
        presence.type === "vision.presence_status"
          ? presence.payload.detectedAt
          : null;
      sendServerMessage(socket, createPersonDepartedMessage(lastSeenAt));
      return;
    }
  }

  if (options.scenario === "presence_only") {
    return;
  }
  if (options.scenario === "controlled") {
    return;
  }

  sendServerMessage(socket, createResultMessage());
}

function handleClientRawMessage(
  socket: WebSocket,
  data: RawData,
  options: Required<
    Pick<MockVisionServerOptions, "scenario" | "pushIntervalMs">
  > & { disconnectOnceServed: { value: boolean } },
): void {
  const message = parseClientMessage(data);
  if (!message) {
    sendServerMessage(
      socket,
      createErrorMessage({
        code: "invalid_message",
        message: "无法解析客户端消息，请检查 JSON 与协议字段",
        retryable: false,
      }),
    );
    return;
  }

  switch (message.type) {
    case "vision.hello":
      if (options.scenario === "try_on_unavailable_handshake") {
        sendServerMessage(
          socket,
          createErrorMessage({
            code: "try_on_unavailable",
            message: "模拟试穿握手不可用",
            retryable: true,
          }),
        );
        return;
      }
      sendServerMessage(socket, createReadyMessage());
      if (
        options.scenario === "disconnect_once" &&
        !options.disconnectOnceServed.value
      ) {
        options.disconnectOnceServed.value = true;
        socket.close();
        return;
      }
      void pushScenarioEvents(
        socket,
        options,
        message.payload.capabilities.includes("presence_status"),
        message.payload.capabilities.includes("person_departed"),
      );
      return;
    case "vision.ping":
      sendServerMessage(socket, createPongMessage());
      return;
    case "vision.try_on.start":
      if (options.scenario === "try_on_unavailable_start") {
        sendServerMessage(
          socket,
          createErrorMessage({
            code: "try_on_unavailable",
            message: "模拟试穿启动不可用",
            retryable: true,
          }),
        );
        return;
      }
      sendServerMessage(
        socket,
        createTryOnStartedMessage(message.payload.sessionId),
      );
      return;
    case "vision.try_on.stop":
      sendServerMessage(
        socket,
        createTryOnStoppedMessage(message.payload.sessionId),
      );
      return;
  }
}

function resolveServerUrl(
  server: WebSocketServer,
  configuredHost: string,
  wsPath: string,
): string {
  const address = server.address();
  if (typeof address === "string" || address === null) {
    return `ws://${configuredHost}${wsPath}`;
  }
  const addressHost = address.address === "::" ? "127.0.0.1" : address.address;
  const displayHost = addressHost.includes(":")
    ? `[${addressHost}]`
    : addressHost;
  return `ws://${displayHost}:${address.port}${wsPath}`;
}

export function startMockVisionServer(
  options: MockVisionServerOptions = {},
): MockVisionServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const wsPath = options.path ?? DEFAULT_PATH;
  const scenario = options.scenario ?? "success";
  const pushIntervalMs = options.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
  const controlPort = options.controlPort ?? null;
  const server = new WebSocketServer({ host, port, path: wsPath });
  const disconnectOnceServed = { value: false };
  const sockets = new Set<WebSocket>();
  const controlServer =
    controlPort == null
      ? null
      : createServer(async (request, response) => {
          if (request.method !== "POST") {
            json(response, 405, { ok: false, error: "method_not_allowed" });
            return;
          }
          if (!request.url?.startsWith(DEFAULT_CONTROL_PATH)) {
            json(response, 404, { ok: false, error: "not_found" });
            return;
          }
          if (scenario !== "controlled") {
            json(response, 409, {
              ok: false,
              error: "control_requires_controlled_scenario",
            });
            return;
          }
          try {
            const body = await readJsonBody(request);
            if (request.url === `${DEFAULT_CONTROL_PATH}/presence`) {
              const state =
                body &&
                typeof body === "object" &&
                "state" in body &&
                body.state === "empty"
                  ? "empty"
                  : "approach";
              const message = createPresenceMessage(state);
              for (const socket of sockets) sendServerMessage(socket, message);
              json(response, 200, {
                ok: true,
                event: message.type,
                eventId: message.payload.eventId,
                state: message.payload.state,
              });
              return;
            }
            if (request.url === `${DEFAULT_CONTROL_PATH}/departure`) {
              const lastSeenAt =
                body &&
                typeof body === "object" &&
                "lastSeenAt" in body &&
                (typeof body.lastSeenAt === "string" || body.lastSeenAt === null)
                  ? body.lastSeenAt
                  : null;
              const message = createPersonDepartedMessage(lastSeenAt);
              for (const socket of sockets) sendServerMessage(socket, message);
              json(response, 200, {
                ok: true,
                event: message.type,
                eventId: message.payload.eventId,
                lastSeenAt: message.payload.lastSeenAt,
              });
              return;
            }
            json(response, 404, { ok: false, error: "unknown_control_route" });
          } catch (error) {
            json(response, 400, {
              ok: false,
              error:
                error instanceof Error ? error.message : "invalid_control_request",
            });
          }
        });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    socket.on("message", (data) => {
      handleClientRawMessage(socket, data, {
        scenario,
        pushIntervalMs,
        disconnectOnceServed,
      });
    });
  });

  const ready = Promise.all([
    new Promise<string>((resolve, reject) => {
      server.once("listening", () => {
        resolve(resolveServerUrl(server, host, wsPath));
      });
      server.once("error", (error) => {
        reject(error);
      });
    }),
    controlServer === null
      ? Promise.resolve(null)
      : new Promise<void>((resolve, reject) => {
          controlServer.once("listening", () => resolve());
          controlServer.once("error", (error) => reject(error));
          controlServer.listen(controlPort, DEFAULT_HOST);
        }),
  ]).then(([url]) => url);

  return {
    ready,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
        controlServer === null
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              controlServer.close((error) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              });
            }),
      ]);
    },
  };
}

function isMockVisionScenario(value: string): value is MockVisionScenario {
  return MOCK_VISION_SCENARIOS.some((scenario) => scenario === value);
}

function parseScenario(value: string | undefined): MockVisionScenario {
  if (value && isMockVisionScenario(value)) return value;
  return "success";
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

function parsePushInterval(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_PUSH_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PUSH_INTERVAL_MS;
  return parsed;
}

function parseControlPort(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    return null;
  }
  return parsed;
}

function logLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isCliEntrypoint()) {
  const server = startMockVisionServer({
    host: process.env.VISION_MOCK_HOST ?? DEFAULT_HOST,
    port: parsePort(process.env.VISION_MOCK_PORT),
    path: process.env.VISION_MOCK_PATH ?? DEFAULT_PATH,
    scenario: parseScenario(process.env.VISION_MOCK_SCENARIO),
    pushIntervalMs: parsePushInterval(process.env.VISION_MOCK_PUSH_INTERVAL_MS),
    controlPort: parseControlPort(process.env.VISION_MOCK_CONTROL_PORT),
  });

  void server.ready
    .then((url) => {
      logLine(`vision-mock listening on ${url}`);
      logLine(`default machine url is ${DEFAULT_VISION_WS_URL}`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logError(`vision-mock failed to start: ${message}`);
      process.exitCode = 1;
    });

  const shutdown = (signal: string): void => {
    void server.close().finally(() => {
      logLine(`vision-mock stopped by ${signal}`);
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}
