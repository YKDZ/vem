import { describe, expect, it, afterEach } from "vitest";
import { WebSocket, type RawData } from "ws";

import {
  VISION_PROTOCOL,
  visionServerMessageSchema,
  type VisionClientMessage,
  type VisionServerMessage,
} from "../../../packages/shared/src/schemas/vision";
import {
  startMockVisionServer,
  type MockVisionScenario,
  type MockVisionServer,
} from "./server";

const servers: MockVisionServer[] = [];

afterEach(async () => {
  const closing = servers.splice(0).map(async (server) => {
    try {
      await server.close();
    } catch {
      return;
    }
  });
  await Promise.all(closing);
});

function nowIso(): string {
  return new Date().toISOString();
}

function createHelloMessage(): VisionClientMessage {
  const message = {
    protocol: VISION_PROTOCOL,
    type: "vision.hello",
    messageId: "hello-001",
    timestamp: nowIso(),
    payload: {
      clientRole: "machine",
      machineCode: "M001",
      protocolVersion: 1,
      capabilities: ["single_profile_inference"],
    },
  } satisfies VisionClientMessage;
  return message;
}

function createStartMessage(sessionId: string): VisionClientMessage {
  const message = {
    protocol: VISION_PROTOCOL,
    type: "vision.start_profile",
    messageId: "start-001",
    timestamp: nowIso(),
    payload: {
      sessionId,
      trigger: "test",
      timeoutMs: 1000,
      requested: ["heightCm", "bodyType", "ageRange", "gender"],
    },
  } satisfies VisionClientMessage;
  return message;
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

async function createServer(scenario: MockVisionScenario): Promise<string> {
  const server = startMockVisionServer({
    port: 0,
    scenario,
    responseDelayMs: 1,
  });
  servers.push(server);
  return await server.ready;
}

async function openSocket(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("open websocket timed out"));
    }, 1000);

    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function nextServerMessage(
  socket: WebSocket,
): Promise<VisionServerMessage> {
  return await new Promise<VisionServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("waiting for server message timed out"));
    }, 1000);

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onMessage = (data: RawData): void => {
      cleanup();
      try {
        const decoded: unknown = JSON.parse(rawDataToText(data));
        resolve(visionServerMessageSchema.parse(decoded));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    function cleanup(): void {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("message", onMessage);
    }

    socket.once("error", onError);
    socket.once("message", onMessage);
  });
}

describe("vision mock server — protocol conformance", () => {
  it("every server message has the correct protocol field", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.protocol).toBe(VISION_PROTOCOL);
      expect(typeof ready.messageId).toBe("string");
      expect(typeof ready.timestamp).toBe("string");

      socket.send(JSON.stringify(createStartMessage("session-proto")));
      const progress = await nextServerMessage(socket);
      expect(progress.protocol).toBe(VISION_PROTOCOL);

      const result = await nextServerMessage(socket);
      expect(result.protocol).toBe(VISION_PROTOCOL);
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — hello / ready handshake", () => {
  it("responds with ready after hello", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.type).toBe("vision.ready");
      if (ready.type !== "vision.ready") return;
      expect(ready.payload.serverName).toBe("vem-vision-mock");
      expect(ready.payload.cameraReady).toBe(true);
      expect(ready.payload.modelReady).toBe(true);
      expect(ready.payload.busy).toBe(false);
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — success scenario", () => {
  it("returns progress then profile result", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.type).toBe("vision.ready");

      socket.send(JSON.stringify(createStartMessage("session-success")));
      const progress = await nextServerMessage(socket);
      expect(progress.type).toBe("vision.profile_progress");
      if (progress.type !== "vision.profile_progress") return;
      expect(progress.payload.sessionId).toBe("session-success");
      expect(typeof progress.payload.progress).toBe("number");

      const result = await nextServerMessage(socket);
      if (result.type !== "vision.profile_result") {
        throw new Error(`expected profile result, got ${result.type}`);
      }
      expect(result.payload.sessionId).toBe("session-success");
      expect(result.payload.profile.personPresent).toBe(true);
      expect(result.payload.profile.heightCm).toBe(172);
      expect(result.payload.profile.gender).toBe("unknown");
      expect(result.payload.quality.overall).toBe("good");
      expect(typeof result.payload.startedAt).toBe("string");
      expect(typeof result.payload.completedAt).toBe("string");
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — no_person scenario", () => {
  it("returns progress then no_person error", async () => {
    const url = await createServer("no_person");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.type).toBe("vision.ready");

      socket.send(JSON.stringify(createStartMessage("session-no-person")));
      const progress = await nextServerMessage(socket);
      expect(progress.type).toBe("vision.profile_progress");

      const error = await nextServerMessage(socket);
      if (error.type !== "vision.error") {
        throw new Error(`expected vision.error, got ${error.type}`);
      }
      expect(error.payload.code).toBe("no_person");
      expect(error.payload.retryable).toBe(true);
      expect(error.payload.sessionId).toBe("session-no-person");
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — camera_unavailable scenario", () => {
  it("returns camera_unavailable error immediately (no progress)", async () => {
    const url = await createServer("camera_unavailable");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createStartMessage("session-camera-error")));
      const error = await nextServerMessage(socket);
      if (error.type !== "vision.error") {
        throw new Error(`expected vision error, got ${error.type}`);
      }
      expect(error.payload.code).toBe("camera_unavailable");
      expect(error.payload.retryable).toBe(true);
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — timeout scenario", () => {
  it("sends progress but never completes (client receives exactly one progress message)", async () => {
    const url = await createServer("timeout");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.type).toBe("vision.ready");

      socket.send(JSON.stringify(createStartMessage("session-timeout")));
      const progress = await nextServerMessage(socket);
      expect(progress.type).toBe("vision.profile_progress");

      // No further message should arrive — verify by waiting and catching the timeout
      const timedOut = await nextServerMessage(socket).then(
        (msg) => ({ kind: "message" as const, msg }),
        (err: unknown) => ({
          kind: "timeout" as const,
          msg: String(err),
        }),
      );
      expect(timedOut.kind).toBe("timeout");
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — ping / pong", () => {
  it("responds to ping with pong", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      const pingMsg = {
        protocol: VISION_PROTOCOL,
        type: "vision.ping",
        messageId: "ping-001",
        timestamp: new Date().toISOString(),
        payload: {},
      } as const;
      socket.send(JSON.stringify(pingMsg));
      const pong = await nextServerMessage(socket);
      expect(pong.type).toBe("vision.pong");
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — cancel message", () => {
  it("responds to cancel with a cancelled error", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      const cancelMsg = {
        protocol: VISION_PROTOCOL,
        type: "vision.cancel",
        messageId: "cancel-001",
        timestamp: new Date().toISOString(),
        payload: {
          sessionId: "session-cancel",
          reason: "user_request",
        },
      } as const;
      socket.send(JSON.stringify(cancelMsg));
      const response = await nextServerMessage(socket);
      if (response.type !== "vision.error") {
        throw new Error(`expected vision.error, got ${response.type}`);
      }
      expect(response.payload.code).toBe("cancelled");
      expect(response.payload.retryable).toBe(true);
      expect(response.payload.sessionId).toBe("session-cancel");
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server — invalid message handling", () => {
  it("returns invalid_message error for malformed JSON body", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      socket.send("{not valid json}");
      const response = await nextServerMessage(socket);
      if (response.type !== "vision.error") {
        throw new Error(`expected vision.error, got ${response.type}`);
      }
      expect(response.payload.code).toBe("invalid_message");
      expect(response.payload.retryable).toBe(false);
    } finally {
      socket.close();
    }
  });

  it("returns invalid_message error for valid JSON with wrong schema", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify({ type: "unknown.type", data: 42 }));
      const response = await nextServerMessage(socket);
      if (response.type !== "vision.error") {
        throw new Error(`expected vision.error, got ${response.type}`);
      }
      expect(response.payload.code).toBe("invalid_message");
    } finally {
      socket.close();
    }
  });
});
