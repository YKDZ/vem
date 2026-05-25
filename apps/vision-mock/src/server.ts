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
  "timeout",
] as const;

export type MockVisionScenario = (typeof MOCK_VISION_SCENARIOS)[number];

export interface MockVisionServerOptions {
  host?: string;
  port?: number;
  path?: string;
  scenario?: MockVisionScenario;
  responseDelayMs?: number;
}

export interface MockVisionServer {
  ready: Promise<string>;
  close: () => Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7892;
const DEFAULT_PATH = "/ws";
const DEFAULT_RESPONSE_DELAY_MS = 250;

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
      serverVersion: "0.1.0",
      cameraReady: true,
      modelReady: true,
      busy: false,
      capabilities: ["single_profile_inference", "cancel"],
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

function createProgressMessage(sessionId: string): VisionServerMessage {
  const message = {
    ...baseEnvelope("progress"),
    type: "vision.profile_progress",
    payload: {
      sessionId,
      stage: "infer",
      progress: 0.65,
      message: "模拟视觉模块正在估算身高与体型",
    },
  } satisfies VisionServerMessage;
  return message;
}

function createResultMessage(sessionId: string): VisionServerMessage {
  const startedAt = nowIso();
  const message = {
    ...baseEnvelope("result"),
    type: "vision.profile_result",
    payload: {
      sessionId,
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
        overall: "good",
        warnings: [],
      },
      startedAt,
      completedAt: nowIso(),
    },
  } satisfies VisionServerMessage;
  return message;
}

function createErrorMessage(input: {
  sessionId?: string;
  code: VisionErrorCode;
  message: string;
  retryable: boolean;
}): VisionServerMessage {
  const message = {
    ...baseEnvelope("error"),
    type: "vision.error",
    payload: {
      sessionId: input.sessionId,
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

async function handleStartProfile(
  socket: WebSocket,
  message: Extract<VisionClientMessage, { type: "vision.start_profile" }>,
  options: Required<
    Pick<MockVisionServerOptions, "scenario" | "responseDelayMs">
  >,
): Promise<void> {
  const sessionId = message.payload.sessionId;
  const scenario = options.scenario;

  if (scenario === "camera_unavailable") {
    sendServerMessage(
      socket,
      createErrorMessage({
        sessionId,
        code: "camera_unavailable",
        message: "模拟摄像头不可用",
        retryable: true,
      }),
    );
    return;
  }

  sendServerMessage(socket, createProgressMessage(sessionId));

  if (scenario === "timeout") return;

  await delay(options.responseDelayMs);

  if (scenario === "no_person") {
    sendServerMessage(
      socket,
      createErrorMessage({
        sessionId,
        code: "no_person",
        message: "模拟场景未检测到人",
        retryable: true,
      }),
    );
    return;
  }

  sendServerMessage(socket, createResultMessage(sessionId));
}

async function handleClientRawMessage(
  socket: WebSocket,
  data: RawData,
  options: Required<
    Pick<MockVisionServerOptions, "scenario" | "responseDelayMs">
  >,
): Promise<void> {
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
      return;
    case "vision.ping":
      sendServerMessage(socket, createPongMessage());
      return;
    case "vision.cancel":
      sendServerMessage(
        socket,
        createErrorMessage({
          sessionId: message.payload.sessionId,
          code: "cancelled",
          message: `模拟视觉任务已取消：${message.payload.reason}`,
          retryable: true,
        }),
      );
      return;
    case "vision.start_profile":
      await handleStartProfile(socket, message, options);
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
  const responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
  const server = new WebSocketServer({ host, port, path: wsPath });

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      void handleClientRawMessage(socket, data, { scenario, responseDelayMs });
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

function parseDelay(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_RESPONSE_DELAY_MS);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RESPONSE_DELAY_MS;
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
    responseDelayMs: parseDelay(process.env.VISION_MOCK_RESPONSE_DELAY_MS),
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
