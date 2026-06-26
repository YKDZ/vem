import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import {
  DEFAULT_VISION_WS_URL,
  VISION_PROTOCOL,
  visionClientMessageSchema,
  visionServerMessageSchema,
  type VisionClientMessage,
  type VisionErrorCode,
  type VisionServerMessage,
} from "../../../packages/shared/src/schemas/vision";

export const MOCK_VISION_SCENARIOS = [
  "success",
  "no_person",
  "camera_unavailable",
] as const;

export type MockVisionScenario = (typeof MOCK_VISION_SCENARIOS)[number];

export interface MockVisionServerOptions {
  host?: string;
  port?: number;
  path?: string;
  scenario?: MockVisionScenario;
  pushIntervalMs?: number;
}

export interface MockVisionServer {
  ready: Promise<string>;
  close: () => Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7892;
const DEFAULT_PATH = "/ws";
const DEFAULT_PUSH_INTERVAL_MS = 1000;

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
      capabilities: ["profile_push"],
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
      profile: {
        personPresent: true,
        heightCm: 172,
        bodyType: "regular",
        upperColor: "dark",
        confidence: 0.86,
      },
      quality: {
        overall: "good",
        warnings: [],
      },
    },
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
    return;
  }

  sendServerMessage(socket, createResultMessage());
}

function handleClientRawMessage(
  socket: WebSocket,
  data: RawData,
  options: Required<
    Pick<MockVisionServerOptions, "scenario" | "pushIntervalMs">
  >,
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
      sendServerMessage(socket, createReadyMessage());
      void pushScenarioEvents(socket, options);
      return;
    case "vision.ping":
      sendServerMessage(socket, createPongMessage());
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
  const server = new WebSocketServer({ host, port, path: wsPath });

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      handleClientRawMessage(socket, data, { scenario, pushIntervalMs });
    });
  });

  const ready = new Promise<string>((resolve, reject) => {
    server.once("listening", () => {
      resolve(resolveServerUrl(server, host, wsPath));
    });
    server.once("error", (error) => {
      reject(error);
    });
  });

  return {
    ready,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
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
