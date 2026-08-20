import { VISION_V2_RUNTIME_IDENTITY } from "@vem/shared";
import { createServer as createHttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  openVisionGarmentAdjustment,
  openVisionTryOnAttempt,
  subscribeVisionProfiles,
  visionSelfCheck,
} from "./vision";

const servers: Array<ReturnType<typeof createHttpServer>> = [];
const attemptId = "550e8400-e29b-41d4-a716-446655440124";
const nativeWebSocket = globalThis.WebSocket;

afterEach(async () => {
  globalThis.WebSocket = nativeWebSocket;
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function envelope(type: string, payload: object) {
  return {
    protocol: "vem.vision.v2",
    type,
    messageId: `machine-${type}-${Math.random().toString(16).slice(2)}`,
    timestamp: "2026-08-20T00:00:00.000Z",
    payload,
  };
}

function ready(overrides: Record<string, unknown> = {}) {
  return envelope("vision.ready", {
    serverName: "vision-test",
    serverVersion: "2.0.0",
    schemaVersion: VISION_V2_RUNTIME_IDENTITY.schemaVersion,
    bundleVersion: VISION_V2_RUNTIME_IDENTITY.bundleVersion,
    contractDigest: VISION_V2_RUNTIME_IDENTITY.contractDigest,
    cameraReady: true,
    tryOnReady: true,
    visionBusinessReady: true,
    businessReadinessDiagnostic: "ready",
    capabilities: ["try_on"],
    ...overrides,
  });
}

async function withVisionServer(
  onMessage: (
    socket: import("ws").WebSocket,
    message: { type?: string },
  ) => void,
): Promise<string> {
  const server = createHttpServer();
  const sockets = new WebSocketServer({ server, path: "/ws" });
  sockets.on("connection", (socket) => {
    socket.on("message", (raw) => {
      onMessage(socket, JSON.parse(String(raw)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  servers.push(server);
  return `ws://127.0.0.1:${port}/ws`;
}

function input() {
  return {
    attemptId,
    variantId: "550e8400-e29b-41d4-a716-446655440125",
    garment: {
      assetId: "550e8400-e29b-41d4-a716-446655440126",
      reference: "http://127.0.0.1:65000/media/garment.png?token=garment-token",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png" as const,
      byteSize: 2048,
      template: "tshirt_short_sleeve" as const,
    },
  };
}

function presence(state: "approach" | "empty") {
  return envelope("vision.presence_status", {
    source: "top",
    eventId: `presence-${state}`,
    detectedAt: "2026-08-20T00:00:00.000Z",
    state,
    reason: "test",
    personPresent: state === "approach",
    occupancy: {
      state: state === "approach" ? "single" : "none",
      confidence: 0.9,
    },
    closeNow: false,
    close: false,
    closeTrigger: null,
    proximity: {},
  });
}

function profile() {
  return envelope("vision.profile_result", {
    source: "front",
    eventId: "profile-after-reconnect",
    detectedAt: "2026-08-20T00:00:01.000Z",
    occupancy: { state: "single", confidence: 0.9 },
    profile: {
      personPresent: true,
      heightCm: 172,
      shoulderWidthCm: 43,
      gender: "unknown",
    },
    quality: { overall: "fair", warnings: [], profileUsable: true },
  });
}

class FakeVisionSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeVisionSocket[] = [];

  readyState = FakeVisionSocket.OPEN;
  closeCount = 0;
  listenerBalance = 0;

  constructor(_url: string) {
    super();
    FakeVisionSocket.instances.push(this);
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }

  override addEventListener(
    ...args: Parameters<EventTarget["addEventListener"]>
  ): void {
    this.listenerBalance += 1;
    super.addEventListener(...args);
  }

  override removeEventListener(
    ...args: Parameters<EventTarget["removeEventListener"]>
  ): void {
    this.listenerBalance -= 1;
    super.removeEventListener(...args);
  }

  send(): void {
    return undefined;
  }

  close(): void {
    this.closeCount += 1;
    if (this.readyState === FakeVisionSocket.CLOSED) return;
    this.readyState = FakeVisionSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  emit(message: object): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }
}

function installFakeVisionSocket(): void {
  FakeVisionSocket.instances = [];
  globalThis.WebSocket = FakeVisionSocket as unknown as typeof WebSocket;
}

describe("native Vision single-path adapter", () => {
  it("performs the V2 ready self-check with the committed identity", async () => {
    const url = await withVisionServer((socket, message) => {
      if (message.type === "vision.hello") socket.send(JSON.stringify(ready()));
    });

    const result = await visionSelfCheck({ url });
    expect(result).toMatchObject({ enabled: true, online: true });
    expect(result.ready?.tryOnReady).toBe(true);
  });

  it("opens one attempt and emits accepted, acquiring, captured, generating and completed in order", async () => {
    let url = "";
    url = await withVisionServer((socket, message) => {
      if (message.type === "vision.hello") {
        socket.send(JSON.stringify(ready()));
        return;
      }
      if (message.type !== "vision.try_on.attempt.start") return;
      const reference = url.replace("ws://", "http://").replace("/ws", "");
      socket.send(
        JSON.stringify(
          envelope("vision.try_on.attempt.accepted", { attemptId }),
        ),
      );
      socket.send(
        JSON.stringify(
          envelope("vision.try_on.attempt.acquiring", {
            attemptId,
            preview: {
              reference: `${reference}/v2/try-on/acquisition/preview.mjpeg?token=preview-token`,
              streamType: "mjpeg",
            },
            occupancy: "single",
            guidance: "counting_down",
            manualCaptureAllowed: true,
            holdRemainingMs: 3_000,
          }),
        ),
      );
      socket.send(
        JSON.stringify(
          envelope("vision.try_on.attempt.captured", {
            attemptId,
            captured: {
              reference: `${reference}/v2/try-on/captured/frame.png?token=captured-token`,
              digest: `sha256:${"b".repeat(64)}`,
              contentType: "image/png",
              byteSize: 2048,
              width: 512,
              height: 768,
              frameId: "front-42",
            },
          }),
        ),
      );
      socket.send(
        JSON.stringify(
          envelope("vision.try_on.attempt.generating", {
            attemptId,
            stage: "generating",
          }),
        ),
      );
      socket.send(
        JSON.stringify(
          envelope("vision.try_on.attempt.completed", {
            attemptId,
            result: {
              reference: `${reference}/v2/try-on/results/${attemptId}?token=result-token`,
              digest: `sha256:${"c".repeat(64)}`,
              contentType: "image/png",
              byteSize: 2048,
              width: 512,
              height: 768,
            },
          }),
        ),
      );
    });
    const events: string[] = [];
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    const attempt = await openVisionTryOnAttempt(
      { url },
      input(),
      (message) => {
        events.push(message.type);
        if (message.type === "vision.try_on.attempt.completed")
          resolveTerminal();
      },
    );
    await terminal;

    expect(attempt.attemptId).toBe(attemptId);
    expect(events).toEqual([
      "vision.try_on.attempt.accepted",
      "vision.try_on.attempt.acquiring",
      "vision.try_on.attempt.captured",
      "vision.try_on.attempt.generating",
      "vision.try_on.attempt.completed",
    ]);
  });

  it("rejects readiness that omits the one try-on capability", async () => {
    const url = await withVisionServer((socket, message) => {
      if (message.type === "vision.hello") {
        socket.send(
          JSON.stringify(ready({ capabilities: [], tryOnReady: false })),
        );
      }
    });
    await expect(
      openVisionTryOnAttempt({ url }, input(), () => undefined),
    ).rejects.toThrow(/capability is unavailable/);
  });

  it("sends a customer cancellation once and fences later server terminals", async () => {
    const received: string[] = [];
    const url = await withVisionServer((socket, message) => {
      received.push(message.type ?? "unknown");
      if (message.type === "vision.hello") socket.send(JSON.stringify(ready()));
    });
    const events: string[] = [];
    const attempt = await openVisionTryOnAttempt(
      { url },
      input(),
      (message) => {
        events.push(message.type);
      },
    );

    expect(attempt.cancel("user")).toBe(true);
    expect(attempt.cancel("user")).toBe(false);
    await vi.waitFor(() => {
      expect(received).toContain("vision.try_on.attempt.cancel");
    });
    expect(events).toEqual(["vision.try_on.attempt.canceled"]);
  });

  it("fences stale profile-connection messages while delivering only the current generation", async () => {
    vi.useFakeTimers();
    installFakeVisionSocket();
    const received: string[] = [];
    const subscription = subscribeVisionProfiles(
      { url: "ws://vision.invalid/ws" },
      {
        onReady: () => received.push("ready"),
        onPresenceStatus: (event) => {
          received.push(`presence:${event.state}`);
        },
        onProfile: () => undefined,
        onError: (error) => {
          throw error;
        },
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    const first = FakeVisionSocket.instances[0];
    first.emit(presence("approach"));
    first.emit(ready());
    first.emit(presence("empty"));
    await Promise.resolve();
    expect(received).toEqual(["ready", "presence:empty"]);

    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
    const second = FakeVisionSocket.instances[1];
    first.emit(ready());
    first.emit(presence("approach"));
    await Promise.resolve();
    expect(received).toEqual(["ready", "presence:empty"]);

    second.emit(ready());
    second.emit(presence("approach"));
    await Promise.resolve();
    expect(received).toEqual([
      "ready",
      "presence:empty",
      "ready",
      "presence:approach",
    ]);
    subscription.close();
  });

  it("reconnects the profile stream and delivers a post-ready profile", async () => {
    vi.useFakeTimers();
    installFakeVisionSocket();
    const received: number[] = [];
    const subscription = subscribeVisionProfiles(
      { url: "ws://vision.invalid/ws" },
      {
        onProfile: (event) => {
          received.push(event.profile.heightCm ?? 0);
        },
        onError: (error) => {
          throw error;
        },
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    const first = FakeVisionSocket.instances[0];
    first.emit(ready());
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
    const second = FakeVisionSocket.instances[1];
    second.emit(ready());
    second.emit(profile());
    await Promise.resolve();

    expect(received).toEqual([172]);
    subscription.close();
  });

  it("emits one disconnect cancellation and releases the single-path attempt resources", async () => {
    vi.useFakeTimers();
    installFakeVisionSocket();
    const events: string[] = [];
    const opening = openVisionTryOnAttempt(
      {
        url: "ws://127.0.0.1:65499/v2/machine",
        tryOnAttemptTimeoutMs: 100,
      },
      input(),
      (event) => events.push(event.type),
    );
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeVisionSocket.instances[0];
    socket.emit(ready());
    const attempt = await opening;

    socket.close();
    socket.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual(["vision.try_on.attempt.canceled"]);
    expect(attempt.resultContext).toEqual({
      attemptId,
      visionSocketUrl: "ws://127.0.0.1:65499/v2/machine",
    });
    expect(socket.listenerBalance).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending single-path handshake and releases the socket exactly once", async () => {
    vi.useFakeTimers();
    installFakeVisionSocket();
    const controller = new AbortController();
    const opening = openVisionTryOnAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine" },
      input(),
      () => undefined,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    controller.abort();

    await expect(opening).rejects.toThrow(/aborted/);
    const socket = FakeVisionSocket.instances[0];
    expect(socket.closeCount).toBe(1);
    expect(socket.listenerBalance).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the same ready gate for garment-scale adjustment", async () => {
    const url = await withVisionServer((socket, message) => {
      if (message.type === "vision.hello") {
        socket.send(JSON.stringify(ready()));
      } else if (message.type === "vision.try_on.attempt.adjust") {
        const reference = url.replace("ws://", "http://").replace("/ws", "");
        socket.send(
          JSON.stringify(
            envelope("vision.try_on.result.adjusted", {
              attemptId,
              result: {
                reference: `${reference}/v2/try-on/results/${attemptId}?token=adjusted-token`,
                digest: `sha256:${"d".repeat(64)}`,
                contentType: "image/png",
                byteSize: 2048,
                width: 530,
                height: 795,
              },
            }),
          ),
        );
      }
    });
    const adjusted = await openVisionGarmentAdjustment(
      { url },
      { attemptId, garmentScale: 1.05 },
    );
    expect(adjusted.result.width).toBe(530);
  });
});
