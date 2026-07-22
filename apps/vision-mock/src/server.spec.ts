import {
  VISION_PROTOCOL,
  visionServerMessageSchema,
  type VisionClientMessage,
  type VisionServerMessage,
} from "@vem/shared/schemas/vision";
import { createConnection, createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";

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
  capabilities: string[] = [
    "profile_push",
    "presence_status",
    "person_departed",
  ],
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

async function postJson(
  url: string,
  body: unknown,
): Promise<{
  status: number;
  json: {
    ok?: boolean;
    connectedRuntimeClients?: number;
    acceptedDeliveries?: number;
    eventId?: string;
  };
}> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as {
      ok?: boolean;
      connectedRuntimeClients?: number;
      acceptedDeliveries?: number;
      eventId?: string;
    },
  };
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

async function findAvailablePort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function canListenOnPort(port: number): Promise<boolean> {
  const listener = createNetServer();
  return await new Promise<boolean>((resolve) => {
    listener.once("error", () => {
      resolve(false);
    });
    listener.listen(port, "127.0.0.1", () => {
      listener.close(() => {
        resolve(true);
      });
    });
  });
}

async function waitForSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === socket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once("close", () => {
      resolve();
    });
  });
}

async function openIncompleteControlRequest(controlPort: number) {
  const socket = createConnection({ host: "127.0.0.1", port: controlPort });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    "POST /control/departure HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${controlPort}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 2\r\n\r\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return socket;
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
      expect(ready.payload.capabilities).toContain("person_departed");

      const presence = await messages.next();
      if (presence.type !== "vision.presence_status") {
        throw new Error(`expected presence status, got ${presence.type}`);
      }
      expect(presence.payload.state).toBe("approach");
      expect(presence.payload.personPresent).toBe(true);

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

describe("vision mock server - shutdown", () => {
  it("terminates active WebSocket clients before releasing both listeners", async () => {
    const controlPort = await findAvailablePort();
    const server = startMockVisionServer({
      port: 0,
      scenario: "controlled",
      controlPort,
    });
    const url = await server.ready;
    const visionPort = Number(new URL(url).port);
    const socket = await openSocket(url);
    const socketClosed = waitForSocketClose(socket);
    const closePromise = server.close();

    try {
      await Promise.race([
        closePromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("mock server close waited for a client"));
          }, 500);
        }),
      ]);
      await socketClosed;
      expect(await canListenOnPort(visionPort)).toBe(true);
      expect(await canListenOnPort(controlPort)).toBe(true);
    } finally {
      socket.terminate();
      await closePromise.catch(() => undefined);
    }
  });

  it("closes an incomplete HTTP control request before releasing the control listener", async () => {
    const controlPort = await findAvailablePort();
    const server = startMockVisionServer({
      port: 0,
      scenario: "controlled",
      controlPort,
    });
    servers.push(server);
    await server.ready;
    const requestSocket = await openIncompleteControlRequest(controlPort);
    const closePromise = server.close();

    try {
      await Promise.race([
        closePromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                "mock server close waited for an incomplete control request",
              ),
            );
          }, 500);
        }),
      ]);
      expect(await canListenOnPort(controlPort)).toBe(true);
    } finally {
      requestSocket.destroy();
      await closePromise.catch(() => undefined);
    }
  });
});

describe("vision mock server - departure events", () => {
  it("pushes person_departed after presence when requested", async () => {
    const url = await createServer("departure_after_presence");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const presence = await messages.next();
      expect(presence.type).toBe("vision.presence_status");

      const departed = await messages.next();
      if (departed.type !== "vision.person_departed") {
        throw new Error(`expected person departed, got ${departed.type}`);
      }
      expect(departed.payload.reason).toBe("left_frame");
      expect(departed.payload.lastSeenAt).toBe(
        presence.type === "vision.presence_status"
          ? presence.payload.detectedAt
          : null,
      );
    } finally {
      messages.dispose();
      socket.close();
    }
  });

  it("does not push person_departed when the capability is absent", async () => {
    const url = await createServer("departure_after_presence");
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(
        JSON.stringify(createHelloMessage(["profile_push", "presence_status"])),
      );
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const presence = await messages.next();
      expect(presence.type).toBe("vision.presence_status");

      const result = await messages.next();
      expect(result.type).toBe("vision.profile_result");
    } finally {
      messages.dispose();
      socket.close();
    }
  });
});

describe("vision mock server - controlled injections", () => {
  it("pushes presence and departure only when the control endpoint is called", async () => {
    const controlPort = 18_932;
    const server = startMockVisionServer({
      port: 0,
      scenario: "controlled",
      pushIntervalMs: 1,
      controlPort,
    });
    servers.push(server);
    const url = await server.ready;
    const socket = await openSocket(url);
    const messages = createServerMessageReader(socket);

    try {
      socket.send(JSON.stringify(createHelloMessage()));
      const ready = await messages.next();
      expect(ready.type).toBe("vision.ready");

      const presenceResponse = await postJson(
        `http://127.0.0.1:${controlPort}/control/presence`,
        { state: "approach" },
      );
      expect(presenceResponse.status).toBe(200);
      expect(presenceResponse.json.ok).toBe(true);

      const presence = await messages.next();
      expect(presence.type).toBe("vision.presence_status");
      if (presence.type !== "vision.presence_status") {
        throw new Error(`expected presence status, received ${presence.type}`);
      }
      expect(presence.payload.state).toBe("approach");

      const departureResponse = await postJson(
        `http://127.0.0.1:${controlPort}/control/departure`,
        { lastSeenAt: presence.payload.detectedAt },
      );
      expect(departureResponse.status).toBe(200);
      expect(departureResponse.json.ok).toBe(true);
      expect(departureResponse.json.connectedRuntimeClients).toBe(1);
      expect(departureResponse.json.acceptedDeliveries).toBe(1);
      expect(departureResponse.json.eventId).toMatch(/^departure-event-/);

      let departed = await messages.next();
      if (departed.type !== "vision.person_departed") {
        departed = await messages.next();
      }
      expect(departed.type).toBe("vision.person_departed");
      if (departed.type !== "vision.person_departed") {
        throw new Error(`expected departure, received ${departed.type}`);
      }
      expect(departed.payload.lastSeenAt).toBe(presence.payload.detectedAt);
    } finally {
      messages.dispose();
      socket.close();
    }
  });

  it("rejects a controlled departure when no installed runtime client can accept it", async () => {
    const controlPort = 18_933;
    const server = startMockVisionServer({
      port: 0,
      scenario: "controlled",
      controlPort,
    });
    servers.push(server);
    await server.ready;

    const response = await postJson(
      `http://127.0.0.1:${controlPort}/control/departure`,
      {},
    );
    expect(response.status).toBe(409);
    expect(response.json).toEqual({
      ok: false,
      error: "no_connected_runtime_client",
      connectedRuntimeClients: 0,
      acceptedDeliveries: 0,
    });
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
