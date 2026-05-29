import { afterEach, describe, expect, it } from "vitest";
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
      capabilities: ["profile_push"],
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
    pushIntervalMs: 1,
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
    }, 5000);

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
  timeoutMs = 5000,
): Promise<VisionServerMessage> {
  return await new Promise<VisionServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("waiting for server message timed out"));
    }, timeoutMs);

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

describe("vision mock server - protocol conformance", () => {
  it("sends ready then a pushed profile result after hello", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.protocol).toBe(VISION_PROTOCOL);
      expect(ready.type).toBe("vision.ready");
      if (ready.type !== "vision.ready") return;
      expect(ready.payload.serverName).toBe("vem-vision-mock");
      expect(ready.payload.cameraReady).toBe(true);
      expect(ready.payload.modelReady).toBe(true);
      expect(ready.payload.capabilities).toContain("profile_push");

      const result = await nextServerMessage(socket);
      if (result.type !== "vision.profile_result") {
        throw new Error(`expected profile result, got ${result.type}`);
      }
      expect(result.protocol).toBe(VISION_PROTOCOL);
      expect(typeof result.payload.eventId).toBe("string");
      expect(typeof result.payload.detectedAt).toBe("string");
      expect(result.payload.profile.personPresent).toBe(true);
      expect(result.payload.profile.heightCm).toBe(172);
      expect(result.payload.profile.gender).toBe("unknown");
      expect(result.payload.quality.overall).toBe("good");
    } finally {
      socket.close();
    }
  }, 20_000);
});

describe("vision mock server - no_person scenario", () => {
  it("stays silent after ready when no person is detected", async () => {
    const url = await createServer("no_person");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.type).toBe("vision.ready");

      const timedOut = await nextServerMessage(socket, 100).then(
        () => false,
        () => true,
      );
      expect(timedOut).toBe(true);
    } finally {
      socket.close();
    }
  });
});

describe("vision mock server - camera_unavailable scenario", () => {
  it("pushes camera_unavailable after hello", async () => {
    const url = await createServer("camera_unavailable");
    const socket = await openSocket(url);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await nextServerMessage(socket);
      expect(ready.type).toBe("vision.ready");

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

describe("vision mock server - ping / pong", () => {
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

describe("vision mock server - invalid message handling", () => {
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
