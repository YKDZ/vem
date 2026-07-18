import {
  DEFAULT_VISION_WS_URL,
  VISION_PROTOCOL,
  visionPresenceStatusPayloadSchema,
  visionPersonDepartedPayloadSchema,
  visionProfileResultPayloadSchema,
  visionReadyPayloadSchema,
  visionServerMessageSchema,
  visionTryOnPreviewUrlSchema,
  type VisionClientMessage,
  type VisionErrorMessage,
  type VisionProfile,
  type VisionServerMessage,
} from "@vem/shared";
import { z } from "zod";

import { callTauriCommand, isTauriRuntime } from "./tauri";

export const visionRuntimeStatusSchema = z.object({
  running: z.boolean(),
  pid: z.number().int().positive().nullable(),
  message: z.string(),
});

export const visionSelfCheckResultSchema = z.object({
  enabled: z.boolean(),
  online: z.boolean(),
  message: z.string(),
  checkedAtMs: z.number().nonnegative(),
  ready: visionReadyPayloadSchema.nullable().optional(),
});

export type VisionRuntimeStatus = z.infer<typeof visionRuntimeStatusSchema>;
export type VisionSelfCheckResult = z.infer<typeof visionSelfCheckResultSchema>;
export type VisionProfileResultPayload = z.infer<
  typeof visionProfileResultPayloadSchema
>;
export type VisionPresenceStatusPayload = z.infer<
  typeof visionPresenceStatusPayloadSchema
>;
export type VisionPersonDepartedPayload = z.infer<
  typeof visionPersonDepartedPayloadSchema
>;
export type { VisionProfile };

export interface VisionProfileSubscriptionHandlers {
  onReady?: (ready: z.infer<typeof visionReadyPayloadSchema>) => void;
  onPresenceStatus?: (
    payload: VisionPresenceStatusPayload,
  ) => void | Promise<void>;
  onPersonDeparted?: (
    payload: VisionPersonDepartedPayload,
  ) => void | Promise<void>;
  onProfile: (payload: VisionProfileResultPayload) => void | Promise<void>;
  onError?: (error: Error) => void;
  onStatus?: (message: string) => void;
}

export interface VisionProfileSubscription {
  close: () => void;
}

export interface VisionTryOnSessionInput {
  catalogKey?: string;
  variantId?: string;
}

export type VisionRuntimeConnection = {
  machineCode?: string | null;
  url?: string;
  timeoutMs?: number;
  enabled?: boolean;
};

export interface VisionTryOnSession {
  sessionId: string;
  previewUrl: string;
  streamType: "mjpeg";
  stop: (reason?: VisionTryOnStopReason) => Promise<void>;
}

export type VisionTryOnStopReason =
  | "user_exit"
  | "route_leave"
  | "replaced"
  | "error"
  | "unknown";

const CONNECT_TIMEOUT_MS = 3000;
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
const TRY_ON_UNAVAILABLE_PREFIX = "vision try_on_unavailable:";

function nowIso(): string {
  return new Date().toISOString();
}

function createMessageId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createHelloMessage(machineCode: string | null): VisionClientMessage {
  const message = {
    protocol: VISION_PROTOCOL,
    type: "vision.hello",
    messageId: createMessageId("hello"),
    timestamp: nowIso(),
    payload: {
      clientRole: "machine",
      machineCode,
      protocolVersion: 1,
      capabilities: [
        "profile_push",
        "presence_status",
        "person_departed",
        "ambient_light",
        "try_on_session",
      ],
    },
  } satisfies VisionClientMessage;
  return message;
}

function createPingMessage(): VisionClientMessage {
  const message = {
    protocol: VISION_PROTOCOL,
    type: "vision.ping",
    messageId: createMessageId("ping"),
    timestamp: nowIso(),
    payload: {},
  } satisfies VisionClientMessage;
  return message;
}

function createTryOnStartMessage(
  input: VisionTryOnSessionInput,
): Extract<VisionClientMessage, { type: "vision.try_on.start" }> {
  const message = {
    protocol: VISION_PROTOCOL,
    type: "vision.try_on.start",
    messageId: createMessageId("try-on-start"),
    timestamp: nowIso(),
    payload: {
      sessionId: createMessageId("try-on-session"),
      catalogKey: input.catalogKey,
      variantId: input.variantId,
    },
  } satisfies VisionClientMessage;
  return message;
}

function createTryOnStopMessage(
  sessionId: string,
  reason: VisionTryOnStopReason,
): Extract<VisionClientMessage, { type: "vision.try_on.stop" }> {
  const message = {
    protocol: VISION_PROTOCOL,
    type: "vision.try_on.stop",
    messageId: createMessageId("try-on-stop"),
    timestamp: nowIso(),
    payload: {
      sessionId,
      reason,
    },
  } satisfies VisionClientMessage;
  return message;
}

function serializeClientMessage(message: VisionClientMessage): string {
  return JSON.stringify(message);
}

function connectionOptions(
  connection: VisionRuntimeConnection = {},
): Required<VisionRuntimeConnection> {
  return {
    machineCode: connection.machineCode ?? null,
    url: connection.url ?? DEFAULT_VISION_WS_URL,
    timeoutMs: connection.timeoutMs ?? CONNECT_TIMEOUT_MS,
    enabled: connection.enabled ?? true,
  };
}

async function openVisionSocket(
  url: string,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<WebSocket> {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }

  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`connect vision websocket timed out: ${url}`));
    }, timeoutMs);

    const onOpen = (): void => {
      cleanup();
      resolve(socket);
    };

    const onError = (): void => {
      cleanup();
      reject(new Error(`connect vision websocket failed: ${url}`));
    };

    function cleanup(): void {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

async function nextServerMessage(
  socket: WebSocket,
  timeoutMs: number,
): Promise<VisionServerMessage> {
  return await new Promise<VisionServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("waiting for vision message timed out"));
    }, timeoutMs);

    const onMessage = (event: MessageEvent): void => {
      cleanup();
      if (typeof event.data !== "string") {
        reject(new Error("vision websocket returned a non-text frame"));
        return;
      }
      try {
        const decoded: unknown = JSON.parse(event.data);
        resolve(visionServerMessageSchema.parse(decoded));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onError = (): void => {
      cleanup();
      reject(new Error("vision websocket error"));
    };

    function cleanup(): void {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    }

    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

class VisionTryOnUnavailableError extends Error {
  constructor(message: string) {
    super(`${TRY_ON_UNAVAILABLE_PREFIX} ${message}`);
    this.name = "VisionTryOnUnavailableError";
  }
}

function tryOnUnavailableError(message: string): Error {
  return new VisionTryOnUnavailableError(message);
}

function errorFromVisionMessage(message: VisionErrorMessage): Error {
  if (message.payload.code === "try_on_unavailable") {
    return tryOnUnavailableError(message.payload.message);
  }
  return new Error(
    `vision ${message.payload.code}: ${message.payload.message}`,
  );
}

export function isVisionTryOnCapabilityDegraded(error: unknown): boolean {
  return error instanceof VisionTryOnUnavailableError;
}

export function parseVisionTryOnPreviewUrl(value: unknown): string {
  return visionTryOnPreviewUrlSchema.parse(value);
}

function closeSocket(socket: WebSocket): void {
  if (
    socket.readyState === WebSocket.CONNECTING ||
    socket.readyState === WebSocket.OPEN
  ) {
    socket.close();
  }
}

async function visionSelfCheckBrowser(
  connection: VisionRuntimeConnection = {},
): Promise<VisionSelfCheckResult> {
  const options = connectionOptions(connection);
  if (!options.enabled) {
    return {
      enabled: false,
      online: false,
      message: "视觉模块未启用",
      checkedAtMs: Date.now(),
      ready: null,
    };
  }

  const socket = await openVisionSocket(options.url, options.timeoutMs);
  try {
    socket.send(
      serializeClientMessage(createHelloMessage(options.machineCode)),
    );
    const message = await nextServerMessage(socket, options.timeoutMs);
    if (message.type === "vision.error") throw errorFromVisionMessage(message);
    if (message.type !== "vision.ready") {
      throw new Error(`unexpected vision self-check message: ${message.type}`);
    }
    return {
      enabled: true,
      online: message.payload.cameraReady && message.payload.modelReady,
      message: `${message.payload.serverName} ${message.payload.serverVersion}`,
      checkedAtMs: Date.now(),
      ready: message.payload,
    };
  } finally {
    closeSocket(socket);
  }
}

export async function startVisionRuntime(): Promise<VisionRuntimeStatus> {
  if (!isTauriRuntime()) {
    return {
      running: false,
      pid: null,
      message: "浏览器开发环境不负责启动视觉子进程，请单独运行 vision-mock",
    };
  }
  const result = await callTauriCommand<unknown>("start_vision_runtime");
  return visionRuntimeStatusSchema.parse(result);
}

export async function stopVisionRuntime(): Promise<VisionRuntimeStatus> {
  if (!isTauriRuntime()) {
    return {
      running: false,
      pid: null,
      message: "浏览器开发环境没有可关闭的视觉子进程",
    };
  }
  const result = await callTauriCommand<unknown>("stop_vision_runtime");
  return visionRuntimeStatusSchema.parse(result);
}

export async function getVisionRuntimeStatus(): Promise<VisionRuntimeStatus> {
  if (!isTauriRuntime()) {
    return {
      running: false,
      pid: null,
      message: "浏览器开发环境未托管视觉子进程",
    };
  }
  const result = await callTauriCommand<unknown>("vision_runtime_status");
  return visionRuntimeStatusSchema.parse(result);
}

export async function visionSelfCheck(
  connection: VisionRuntimeConnection = {},
): Promise<VisionSelfCheckResult> {
  if (!isTauriRuntime()) return await visionSelfCheckBrowser(connection);
  const result = await callTauriCommand<unknown>("vision_self_check");
  return visionSelfCheckResultSchema.parse(result);
}

export async function openVisionTryOnSession(
  connection: VisionRuntimeConnection = {},
  input: VisionTryOnSessionInput = {},
): Promise<VisionTryOnSession> {
  const options = connectionOptions(connection);
  if (!options.enabled) {
    throw new Error("视觉模块未启用，无法启动虚拟试穿");
  }

  const socket = await openVisionSocket(options.url, options.timeoutMs);
  let closed = false;

  const closeSessionSocket = (): void => {
    closed = true;
    closeSocket(socket);
  };

  try {
    socket.send(
      serializeClientMessage(createHelloMessage(options.machineCode)),
    );
    const readyMessage = await nextServerMessage(socket, options.timeoutMs);
    if (readyMessage.type === "vision.error") {
      throw errorFromVisionMessage(readyMessage);
    }
    if (readyMessage.type !== "vision.ready") {
      throw new Error(
        `unexpected vision try-on handshake message: ${readyMessage.type}`,
      );
    }
    if (!readyMessage.payload.cameraReady) {
      throw tryOnUnavailableError("视觉摄像头未就绪，无法启动虚拟试穿");
    }
    if (!readyMessage.payload.capabilities.includes("try_on_session")) {
      throw tryOnUnavailableError("视觉模块不支持虚拟试穿会话");
    }

    const startMessage = createTryOnStartMessage(input);
    socket.send(serializeClientMessage(startMessage));
    const startedMessage = await waitForTryOnStarted(
      socket,
      startMessage.payload.sessionId,
      options.timeoutMs,
    );

    return {
      sessionId: startedMessage.payload.sessionId,
      previewUrl: parseVisionTryOnPreviewUrl(startedMessage.payload.previewUrl),
      streamType: startedMessage.payload.streamType,
      stop: async (reason: VisionTryOnStopReason = "user_exit") => {
        if (closed) return;
        try {
          socket.send(
            serializeClientMessage(
              createTryOnStopMessage(startedMessage.payload.sessionId, reason),
            ),
          );
        } finally {
          closeSessionSocket();
        }
      },
    };
  } catch (error) {
    closeSessionSocket();
    throw error;
  }
}

async function waitForTryOnStarted(
  socket: WebSocket,
  sessionId: string,
  timeoutMs: number,
): Promise<Extract<VisionServerMessage, { type: "vision.try_on.started" }>> {
  const deadline = Date.now() + timeoutMs;
  return await waitForTryOnStartedBefore(socket, sessionId, deadline);
}

async function waitForTryOnStartedBefore(
  socket: WebSocket,
  sessionId: string,
  deadline: number,
): Promise<Extract<VisionServerMessage, { type: "vision.try_on.started" }>> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("waiting for vision try-on preview timed out");
  }
  const message = await nextServerMessage(socket, remainingMs);
  if (message.type === "vision.error") {
    throw errorFromVisionMessage(message);
  }
  if (
    message.type === "vision.try_on.started" &&
    message.payload.sessionId === sessionId
  ) {
    return message;
  }
  if (
    message.type === "vision.try_on.stopped" &&
    message.payload.sessionId === sessionId
  ) {
    throw new Error(`vision try-on session stopped: ${message.payload.reason}`);
  }
  return await waitForTryOnStartedBefore(socket, sessionId, deadline);
}

export function subscribeVisionProfiles(
  connection: VisionRuntimeConnection = {},
  handlers: VisionProfileSubscriptionHandlers,
): VisionProfileSubscription {
  const options = connectionOptions(connection);
  if (!options.enabled) {
    handlers.onStatus?.("视觉模块未启用");
    return { close: () => undefined };
  }

  let closed = false;
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const clearPingTimers = (): void => {
    if (pingTimer !== null) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    if (pongTimer !== null) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  };

  const stopSocket = (): void => {
    clearPingTimers();
    if (socket) {
      closeSocket(socket);
      socket = null;
    }
  };

  const reportError = (error: unknown): void => {
    handlers.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  };

  const scheduleReconnect = (reason: string): void => {
    if (closed || reconnectTimer !== null) return;
    stopSocket();
    const delayMs = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt += 1;
    handlers.onStatus?.(
      `${reason}，${Math.round(delayMs / 1000)} 秒后重连视觉模块`,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const schedulePing = (): void => {
    if (closed) return;
    if (pingTimer !== null) clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      pingTimer = null;
      if (closed || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(serializeClientMessage(createPingMessage()));
      } catch (error) {
        reportError(error);
        scheduleReconnect("视觉模块心跳发送失败");
        return;
      }
      if (pongTimer !== null) clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        pongTimer = null;
        reportError(new Error("vision websocket pong timed out"));
        scheduleReconnect("视觉模块心跳超时");
      }, PONG_TIMEOUT_MS);
      schedulePing();
    }, PING_INTERVAL_MS);
  };

  const handleServerMessage = (message: VisionServerMessage): void => {
    if (message.type === "vision.ready") {
      handlers.onReady?.(message.payload);
      handlers.onStatus?.(
        `视觉模块就绪：${message.payload.serverName} ${message.payload.serverVersion}`,
      );
      return;
    }
    if (message.type === "vision.pong") {
      if (pongTimer !== null) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
      return;
    }
    if (message.type === "vision.presence_status") {
      void Promise.resolve(handlers.onPresenceStatus?.(message.payload)).catch(
        (error: unknown) => {
          handlers.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
      return;
    }
    if (message.type === "vision.person_departed") {
      void Promise.resolve(handlers.onPersonDeparted?.(message.payload)).catch(
        (error: unknown) => {
          handlers.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
      return;
    }
    if (message.type === "vision.profile_result") {
      void Promise.resolve(handlers.onProfile(message.payload)).catch(
        (error: unknown) => {
          handlers.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
      return;
    }
    if (message.type === "vision.error") {
      handlers.onError?.(errorFromVisionMessage(message));
    }
  };

  const connect = async (): Promise<void> => {
    try {
      const connectedSocket = await openVisionSocket(
        options.url,
        options.timeoutMs,
      );
      if (closed) {
        closeSocket(connectedSocket);
        return;
      }
      socket = connectedSocket;
      reconnectAttempt = 0;
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          handlers.onError?.(
            new Error("vision websocket returned a non-text frame"),
          );
          return;
        }
        try {
          const decoded: unknown = JSON.parse(event.data);
          handleServerMessage(visionServerMessageSchema.parse(decoded));
        } catch (error) {
          reportError(error);
        }
      });
      socket.addEventListener("error", () => {
        reportError(new Error("vision websocket error"));
        scheduleReconnect("视觉模块连接异常");
      });
      socket.addEventListener("close", () => {
        if (closed) return;
        scheduleReconnect("视觉模块连接已断开");
      });
      socket.send(
        serializeClientMessage(createHelloMessage(options.machineCode)),
      );
      schedulePing();
      handlers.onStatus?.("已连接机器视觉模块，等待识别结果推送");
    } catch (error) {
      reportError(error);
      scheduleReconnect("视觉模块连接失败");
    }
  };

  void connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopSocket();
    },
  };
}
