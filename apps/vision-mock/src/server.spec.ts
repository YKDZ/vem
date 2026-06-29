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

function createHelloMessage(
  capabilities: string[] = ["profile_push", "presence_status", "ambient_light"],
): VisionClientMessage {
  const message = {
    protocol: VISION_PROTOCOL,
    type: "vision.hello",
    messageId: "hello-001",
    timestamp: nowIso(),
    payload: {
      clientRole: "machine",
      machineCode: "M001",
      protocolVersion: 1,
      capabilities,
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

type QueuedServerMessage =
  | { ok: true; value: VisionServerMessage }
  | { ok: false; error: Error };

type PendingServerMessage = {
  resolve: (message: VisionServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function createServerMessageReader(socket: WebSocket): {
  next: (timeoutMs?: number) => Promise<VisionServerMessage>;
  dispose: () => void;
} {
  const queue: QueuedServerMessage[] = [];
  const pending: PendingServerMessage[] = [];

  function settle(item: QueuedServerMessage): void {
    const next = pending.shift();
    if (!next) {
      queue.push(item);
      return;
    }

    clearTimeout(next.timer);
    if (item.ok) {
      next.resolve(item.value);
      return;
    }
    next.reject(item.error);
  }

  const onError = (error: Error): void => {
    settle({ ok: false, error });
  };

  const onMessage = (data: RawData): void => {
    try {
      const decoded: unknown = JSON.parse(rawDataToText(data));
      settle({ ok: true, value: visionServerMessageSchema.parse(decoded) });
    } catch (error) {
      settle({
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  socket.on("error", onError);
  socket.on("message", onMessage);

  return {
    next: async (timeoutMs = 5000) => {
      const item = queue.shift();
      if (item) {
        if (item.ok) return item.value;
        throw item.error;
      }

      return await new Promise<VisionServerMessage>((resolve, reject) => {
        let pendingRead: PendingServerMessage;
        const timer = setTimeout(() => {
          const index = pending.indexOf(pendingRead);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error("waiting for server message timed out"));
        }, timeoutMs);
        pendingRead = { resolve, reject, timer };
        pending.push(pendingRead);
      });
    },
    dispose: () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
      for (const pendingRead of pending.splice(0)) {
        clearTimeout(pendingRead.timer);
        pendingRead.reject(new Error("server message reader disposed"));
      }
    },
  };
}

describe("vision mock server - protocol conformance", () => {
  it("sends ready then a pushed profile result after hello", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await messages.next();
      expect(ready.protocol).toBe(VISION_PROTOCOL);
      expect(ready.type).toBe("vision.ready");
      if (ready.type !== "vision.ready") return;
      expect(ready.payload.serverName).toBe("vem-vision-mock");
      expect(ready.payload.cameraReady).toBe(true);
      expect(ready.payload.modelReady).toBe(true);
      expect(ready.payload.capabilities).toContain("profile_push");
      expect(ready.payload.capabilities).toContain("presence_status");
      expect(ready.payload.capabilities).toContain("ambient_light");

      const presence = await messages.next();
      if (presence.type !== "vision.presence_status") {
        throw new Error(`expected presence status, got ${presence.type}`);
      }
      expect(presence.payload.state).toBe("approach");
      expect(presence.payload.personPresent).toBe(true);
      expect(presence.payload.ambientLight?.level).toBe("dim");

      const result = await messages.next();
      if (result.type !== "vision.profile_result") {
        throw new Error(`expected profile result, got ${result.type}`);
      }
      expect(result.protocol).toBe(VISION_PROTOCOL);
      expect(typeof result.payload.eventId).toBe("string");
      expect(typeof result.payload.detectedAt).toBe("string");
      expect(result.payload.profile.personPresent).toBe(true);
      expect(result.payload.profile.heightCm).toBe(172);
      expect(result.payload.profile.shoulderWidthCm).toBe(43);
      expect(result.payload.profile.gender).toBe("unknown");
      expect(result.payload.quality.overall).toBe("fair");
    } finally {
      messages.dispose();
      socket.close();
    }
  }, 20_000);

  it("can push presence without profile details", async () => {
    const url = await createServer("presence_only");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const presence = await messages.next();
      if (presence.type !== "vision.presence_status") {
        throw new Error(`expected presence status, got ${presence.type}`);
      }
      expect(presence.payload.state).toBe("approach");
      expect(presence.payload.personPresent).toBe(true);

      const timedOut = await messages.next(100).then(
        () => false,
        () => true,
      );
      expect(timedOut).toBe(true);
    } finally {
      messages.dispose();
      socket.close();
    }
  });
});

describe("vision mock server - no_person scenario", () => {
  it("pushes empty presence when no person is detected and presence_status is requested", async () => {
    const url = await createServer("no_person");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const presence = await messages.next();
      if (presence.type !== "vision.presence_status") {
        throw new Error(`expected presence status, got ${presence.type}`);
      }
      expect(presence.payload.state).toBe("empty");
      expect(presence.payload.personPresent).toBe(false);
      expect(presence.payload.ambientLight?.level).toBe("bright");

      const timedOut = await messages.next(100).then(
        () => false,
        () => true,
      );
      expect(timedOut).toBe(true);
    } finally {
      messages.dispose();
      socket.close();
    }
  });

  it("stays silent after ready when presence_status is not requested", async () => {
    const url = await createServer("no_person");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify(createHelloMessage(["profile_push"])));
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const timedOut = await messages.next(100).then(
        () => false,
        () => true,
      );
      expect(timedOut).toBe(true);
    } finally {
      messages.dispose();
      socket.close();
    }
  });

  it("omits ambient light when ambient_light is not requested", async () => {
    const url = await createServer("presence_only");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(
        JSON.stringify(createHelloMessage(["profile_push", "presence_status"])),
      );
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const presence = await messages.next();
      if (presence.type !== "vision.presence_status") {
        throw new Error(`expected presence status, got ${presence.type}`);
      }
      expect(presence.payload.personPresent).toBe(true);
      expect(presence.payload.ambientLight).toBeUndefined();
    } finally {
      messages.dispose();
      socket.close();
    }
  });
});

describe("vision mock server - camera_unavailable scenario", () => {
  it("pushes camera_unavailable after hello", async () => {
    const url = await createServer("camera_unavailable");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const error = await messages.next();
      if (error.type !== "vision.error") {
        throw new Error(`expected vision error, got ${error.type}`);
      }
      expect(error.payload.code).toBe("camera_unavailable");
      expect(error.payload.retryable).toBe(true);
    } finally {
      messages.dispose();
      socket.close();
    }
  });
});

describe("vision mock server - ping / pong", () => {
  it("responds to ping with pong", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      const pingMsg = {
        protocol: VISION_PROTOCOL,
        type: "vision.ping",
        messageId: "ping-001",
        timestamp: new Date().toISOString(),
        payload: {},
      } as const;
      socket.send(JSON.stringify(pingMsg));
      const pong = await messages.next();
      expect(pong.type).toBe("vision.pong");
    } finally {
      messages.dispose();
      socket.close();
    }
  });
});

describe("vision mock server - invalid message handling", () => {
  it("returns invalid_message error for malformed JSON body", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send("{not valid json}");
      const response = await messages.next();
      if (response.type !== "vision.error") {
        throw new Error(`expected vision.error, got ${response.type}`);
      }
      expect(response.payload.code).toBe("invalid_message");
      expect(response.payload.retryable).toBe(false);
    } finally {
      messages.dispose();
      socket.close();
    }
  });

  it("returns invalid_message error for valid JSON with wrong schema", async () => {
    const url = await createServer("success");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify({ type: "unknown.type", data: 42 }));
      const response = await messages.next();
      if (response.type !== "vision.error") {
        throw new Error(`expected vision.error, got ${response.type}`);
      }
      expect(response.payload.code).toBe("invalid_message");
    } finally {
      messages.dispose();
      socket.close();
    }
  });
});
