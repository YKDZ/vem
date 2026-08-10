import {
  DEFAULT_VISION_WS_URL,
  VISION_V2_RUNTIME_IDENTITY,
  visionPresenceStatusPayloadSchema,
  visionPersonDepartedPayloadSchema,
  visionProfileResultPayloadSchema,
  visionReadyPayloadSchema,
  visionServerMessageSchema,
  visionV2AttemptFailedMessageSchema,
  visionV2ClientMessageSchema,
  visionV2ServerMessageSchema,
  type VisionV2AttemptEvent,
  type VisionV2FastAttemptStartMessage,
  type VisionV2ServerMessage,
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

export type VisionRuntimeConnection = {
  machineCode?: string | null;
  url?: string;
  timeoutMs?: number;
  fastAttemptTimeoutMs?: number;
  enabled?: boolean;
};

export type VisionFastAttemptEvent = VisionV2AttemptEvent;

export type VisionFastAttemptInput = {
  attemptId: string;
  variantId: string;
  garment: VisionV2FastAttemptStartMessage["payload"]["garment"];
};

export interface VisionFastAttempt {
  attemptId: string;
  resultContext: {
    attemptId: string;
    visionSocketUrl: string;
  };
  close: () => void;
}

const CONNECT_TIMEOUT_MS = 3000;
const FAST_ATTEMPT_TERMINAL_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
const FAST_UNAVAILABLE_PREFIX = "vision fast_unavailable:";

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
    protocol: VISION_V2_RUNTIME_IDENTITY.protocol,
    type: "vision.hello",
    messageId: createMessageId("hello"),
    timestamp: nowIso(),
    payload: {
      clientRole: "machine",
      ...(machineCode ? { machineCode } : {}),
      schemaVersion: VISION_V2_RUNTIME_IDENTITY.schemaVersion,
      bundleVersion: VISION_V2_RUNTIME_IDENTITY.bundleVersion,
      contractDigest: VISION_V2_RUNTIME_IDENTITY.contractDigest,
      capabilities: [
        "profile_push",
        "presence_status",
        "person_departed",
        "ambient_light",
        "try_on_fast",
      ],
    },
  } satisfies VisionClientMessage;
  return message;
}

function normalizedVisionReady(
  ready: z.infer<typeof visionReadyPayloadSchema>,
): z.infer<typeof visionReadyPayloadSchema> {
  const contractBundleUnavailable =
    ready.businessReadinessDiagnostic === "contract_bundle_unavailable" &&
    ready.schemaVersion === "unavailable" &&
    ready.bundleVersion === "unavailable" &&
    ready.contractDigest === "0".repeat(64) &&
    !ready.fastReady &&
    !ready.visionBusinessReady;
  if (contractBundleUnavailable) return ready;
  const versionMatches =
    ready.schemaVersion === VISION_V2_RUNTIME_IDENTITY.schemaVersion &&
    ready.bundleVersion === VISION_V2_RUNTIME_IDENTITY.bundleVersion;
  const digestMatches =
    ready.contractDigest === VISION_V2_RUNTIME_IDENTITY.contractDigest;
  if (versionMatches && digestMatches) return ready;
  return {
    ...ready,
    fastReady: false,
    visionBusinessReady: false,
    businessReadinessDiagnostic: versionMatches
      ? "contract_digest_mismatch"
      : "contract_version_mismatch",
  };
}

function parseServerMessage(value: unknown): VisionServerMessage {
  const message = visionServerMessageSchema.parse(value);
  if (message.type !== "vision.ready") return message;
  return { ...message, payload: normalizedVisionReady(message.payload) };
}

function createPingMessage(): VisionClientMessage {
  const message = {
    protocol: VISION_V2_RUNTIME_IDENTITY.protocol,
    type: "vision.ping",
    messageId: createMessageId("ping"),
    timestamp: nowIso(),
    payload: {},
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
    fastAttemptTimeoutMs:
      connection.fastAttemptTimeoutMs ?? FAST_ATTEMPT_TERMINAL_TIMEOUT_MS,
    enabled: connection.enabled ?? true,
  };
}

async function openVisionSocket(
  url: string,
  timeoutMs = CONNECT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<WebSocket> {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this runtime");
  }
  if (signal?.aborted) throw new Error("vision websocket operation aborted");

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      reject(new Error(`connect vision websocket timed out: ${url}`));
    }, timeoutMs);

    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };

    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`connect vision websocket failed: ${url}`));
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close();
      reject(new Error("vision websocket operation aborted"));
    };

    function cleanup(): void {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
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
        resolve(parseServerMessage(decoded));
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

class VisionFastUnavailableError extends Error {
  constructor(message: string) {
    super(`${FAST_UNAVAILABLE_PREFIX} ${message}`);
    this.name = "VisionFastUnavailableError";
  }
}

function tryOnUnavailableError(message: string): Error {
  return new VisionFastUnavailableError(message);
}

function errorFromVisionMessage(message: VisionErrorMessage): Error {
  if (message.payload.code === "fast_unavailable") {
    return tryOnUnavailableError(message.payload.message);
  }
  return new Error(
    `vision ${message.payload.code}: ${message.payload.message}`,
  );
}

export function isVisionTryOnCapabilityDegraded(error: unknown): boolean {
  return error instanceof VisionFastUnavailableError;
}

function createVisionV2HelloMessage(machineCode: string | null) {
  return visionV2ClientMessageSchema.parse({
    protocol: VISION_V2_RUNTIME_IDENTITY.protocol,
    type: "vision.hello" as const,
    messageId: createMessageId("hello-v2"),
    timestamp: nowIso(),
    payload: {
      clientRole: "machine" as const,
      ...(machineCode ? { machineCode } : {}),
      schemaVersion: VISION_V2_RUNTIME_IDENTITY.schemaVersion,
      bundleVersion: VISION_V2_RUNTIME_IDENTITY.bundleVersion,
      contractDigest: VISION_V2_RUNTIME_IDENTITY.contractDigest,
      capabilities: ["try_on_fast"],
    },
  });
}

function parseVisionV2ServerMessage(value: unknown): VisionV2ServerMessage {
  return visionV2ServerMessageSchema.parse(value);
}

async function nextVisionV2Message(
  socket: WebSocket,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VisionV2ServerMessage> {
  if (signal?.aborted) throw new Error("Vision V2 operation aborted");
  return await new Promise<VisionV2ServerMessage>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("waiting for Vision V2 message timed out"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof event.data !== "string") {
        reject(new Error("Vision V2 returned a non-text frame"));
        return;
      }
      try {
        resolve(parseVisionV2ServerMessage(JSON.parse(event.data)));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Vision V2 websocket error"));
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Vision V2 operation aborted"));
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    }
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function openVisionFastAttempt(
  connection: VisionRuntimeConnection = {},
  input: VisionFastAttemptInput,
  onEvent: (
    event: VisionFastAttemptEvent,
    resultContext: VisionFastAttempt["resultContext"],
  ) => void,
  signal?: AbortSignal,
): Promise<VisionFastAttempt> {
  const options = connectionOptions(connection);
  if (!options.enabled) throw new Error("视觉模块未启用，无法启动快速试衣");
  const socket = await openVisionSocket(options.url, options.timeoutMs, signal);
  let closed = false;
  let terminal = false;
  let terminalTimer: ReturnType<typeof setTimeout> | null = null;
  let onMessage: ((event: MessageEvent) => void) | null = null;
  let onClose: (() => void) | null = null;
  let onError: (() => void) | null = null;
  let onAbort: (() => void) | null = null;
  const resultContext = {
    attemptId: input.attemptId,
    visionSocketUrl: options.url,
  };
  const cleanup = (): void => {
    if (terminalTimer !== null) {
      clearTimeout(terminalTimer);
      terminalTimer = null;
    }
    if (onMessage) socket.removeEventListener("message", onMessage);
    if (onClose) socket.removeEventListener("close", onClose);
    if (onError) socket.removeEventListener("error", onError);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    onMessage = null;
    onClose = null;
    onError = null;
    onAbort = null;
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    cleanup();
    closeSocket(socket);
  };
  const emitFailure = (): void => {
    if (terminal || closed) return;
    terminal = true;
    const failure = visionV2AttemptFailedMessageSchema.parse({
      protocol: VISION_V2_RUNTIME_IDENTITY.protocol,
      type: "vision.try_on.attempt.failed",
      messageId: createMessageId("attempt-failed"),
      timestamp: nowIso(),
      payload: { attemptId: input.attemptId, reason: "fast_failed" },
    });
    onEvent(failure, resultContext);
    close();
  };
  try {
    onAbort = close;
    if (signal?.aborted) throw new Error("Vision V2 Fast attempt aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.send(
      JSON.stringify(createVisionV2HelloMessage(options.machineCode)),
    );
    const ready = await nextVisionV2Message(socket, options.timeoutMs, signal);
    if (signal?.aborted) throw new Error("Vision V2 Fast attempt aborted");
    if (ready.type !== "vision.ready") {
      throw new Error(`unexpected Vision V2 handshake message: ${ready.type}`);
    }
    const identityMatches =
      ready.payload.schemaVersion ===
        VISION_V2_RUNTIME_IDENTITY.schemaVersion &&
      ready.payload.bundleVersion ===
        VISION_V2_RUNTIME_IDENTITY.bundleVersion &&
      ready.payload.contractDigest ===
        VISION_V2_RUNTIME_IDENTITY.contractDigest;
    if (
      !identityMatches ||
      !ready.payload.fastReady ||
      !ready.payload.visionBusinessReady
    ) {
      throw new Error("Vision V2 Fast capability is unavailable");
    }
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("Vision V2 websocket closed during Fast handshake");
    }
    const startMessage = visionV2ClientMessageSchema.parse({
      protocol: VISION_V2_RUNTIME_IDENTITY.protocol,
      type: "vision.try_on.attempt.start",
      messageId: createMessageId("attempt-start"),
      timestamp: nowIso(),
      payload: {
        attemptId: input.attemptId,
        mode: "fast",
        variantId: input.variantId,
        garment: input.garment,
      },
    });
    onMessage = (event: MessageEvent): void => {
      if (closed || terminal || typeof event.data !== "string") return;
      try {
        const message = parseVisionV2ServerMessage(JSON.parse(event.data));
        if (
          (message.type === "vision.try_on.attempt.accepted" ||
            message.type === "vision.try_on.attempt.acquiring" ||
            message.type === "vision.try_on.attempt.generating" ||
            message.type === "vision.try_on.attempt.completed" ||
            message.type === "vision.try_on.attempt.failed" ||
            message.type === "vision.try_on.attempt.canceled") &&
          message.payload.attemptId === input.attemptId
        ) {
          onEvent(message, resultContext);
          if (
            message.type === "vision.try_on.attempt.completed" ||
            message.type === "vision.try_on.attempt.failed" ||
            message.type === "vision.try_on.attempt.canceled"
          ) {
            terminal = true;
            close();
          }
        }
      } catch {
        // A malformed or unrelated late frame cannot alter the current attempt.
      }
    };
    onClose = emitFailure;
    onError = emitFailure;
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    terminalTimer = setTimeout(emitFailure, options.fastAttemptTimeoutMs);
    if (signal?.aborted) throw new Error("Vision V2 Fast attempt aborted");
    socket.send(JSON.stringify(startMessage));
    return { attemptId: input.attemptId, resultContext, close };
  } catch (error) {
    close();
    throw error;
  }
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
      online: message.payload.cameraReady,
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
  let activeGeneration = 0;

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
    activeGeneration += 1;
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
    const generation = activeGeneration + 1;
    activeGeneration = generation;
    try {
      const connectedSocket = await openVisionSocket(
        options.url,
        options.timeoutMs,
      );
      if (closed || generation !== activeGeneration) {
        closeSocket(connectedSocket);
        return;
      }
      socket = connectedSocket;
      reconnectAttempt = 0;
      let established = false;
      socket.addEventListener("message", (event) => {
        if (
          closed ||
          generation !== activeGeneration ||
          socket !== connectedSocket
        ) {
          return;
        }
        if (typeof event.data !== "string") {
          handlers.onError?.(
            new Error("vision websocket returned a non-text frame"),
          );
          return;
        }
        try {
          const decoded: unknown = JSON.parse(event.data);
          const message = parseServerMessage(decoded);
          if (!established) {
            if (message.type === "vision.ready") {
              // A readiness mismatch still establishes core presence/profile;
              // normalized readiness withholds only the business Fast capability.
              established = true;
              handleServerMessage(message);
            } else if (message.type === "vision.error") {
              handleServerMessage(message);
            }
            return;
          }
          handleServerMessage(message);
        } catch (error) {
          reportError(error);
        }
      });
      socket.addEventListener("error", () => {
        if (generation !== activeGeneration || socket !== connectedSocket)
          return;
        reportError(new Error("vision websocket error"));
        scheduleReconnect("视觉模块连接异常");
      });
      socket.addEventListener("close", () => {
        if (
          closed ||
          generation !== activeGeneration ||
          socket !== connectedSocket
        ) {
          return;
        }
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
