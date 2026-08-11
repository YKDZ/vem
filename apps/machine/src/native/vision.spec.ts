import { VISION_V2_RUNTIME_IDENTITY } from "@vem/shared";
import {
  startMockVisionServer,
  type MockVisionScenario,
  type MockVisionServer,
} from "vision-mock";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openVisionFastAttempt,
  openVisionTryOnAttempt,
  subscribeVisionProfiles,
  type VisionPersonDepartedPayload,
  type VisionPresenceStatusPayload,
  type VisionProfileSubscriptionHandlers,
  type VisionProfileResultPayload,
  visionSelfCheck,
} from "./vision";

const servers: MockVisionServer[] = [];
const nativeWebSocket = globalThis.WebSocket;

afterEach(async () => {
  globalThis.WebSocket = nativeWebSocket;
  vi.useRealTimers();
  const closing = servers.splice(0).map(async (server) => {
    try {
      await server.close();
    } catch {
      return;
    }
  });
  await Promise.all(closing);
});

async function startVisionMock(
  scenario: MockVisionScenario = "success",
): Promise<string> {
  const server = startMockVisionServer({
    port: 0,
    scenario,
    pushIntervalMs: 1,
  });
  servers.push(server);
  return await server.ready;
}

async function waitForPushedProfile(
  url: string,
): Promise<VisionProfileResultPayload> {
  const config = { url };
  return await new Promise((resolve, reject) => {
    let subscription: ReturnType<typeof subscribeVisionProfiles>;
    subscription = subscribeVisionProfiles(config, {
      onProfile: (payload) => {
        subscription.close();
        resolve(payload);
      },
      onError: (error) => {
        subscription.close();
        reject(error);
      },
    });
  });
}

describe("vision native browser fallback - self-check", () => {
  it("performs self-check against the mock websocket server", async () => {
    const url = await startVisionMock();
    const config = { url };

    const result = await visionSelfCheck(config);

    expect(result.online).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.ready?.serverName).toBe("vem-vision-mock");
    expect(result.ready?.cameraReady).toBe(true);
    expect(result.ready?.visionBusinessReady).toBe(true);
    expect(typeof result.checkedAtMs).toBe("number");
  });

  it("returns enabled=false when vision is disabled in config", async () => {
    const config = { enabled: false };

    const result = await visionSelfCheck(config);

    expect(result.enabled).toBe(false);
    expect(result.online).toBe(false);
  });

  it("returns online=false when server is not reachable", async () => {
    const config = { url: "ws://127.0.0.1:19999/ws" };

    await expect(visionSelfCheck(config)).rejects.toThrow();
  });

  it("keeps the core Vision connection online while a V2 digest mismatch withholds Fast", async () => {
    const url = await startVisionMock("contract_digest_mismatch");

    const result = await visionSelfCheck({ url });

    expect(result.online).toBe(true);
    expect(result.ready?.cameraReady).toBe(true);
    expect(result.ready?.visionBusinessReady).toBe(false);
    expect(result.ready?.fastReady).toBe(false);
    expect(result.ready?.businessReadinessDiagnostic).toBe(
      "contract_digest_mismatch",
    );
  });

  it("preserves contract_bundle_unavailable without promoting business readiness", async () => {
    const url = await startVisionMock("contract_bundle_unavailable");
    const ready = await new Promise<
      Parameters<NonNullable<VisionProfileSubscriptionHandlers["onReady"]>>[0]
    >((resolve, reject) => {
      const subscription = subscribeVisionProfiles(
        { url },
        {
          onReady: (value) => {
            subscription.close();
            resolve(value);
          },
          onProfile: () => undefined,
          onError: reject,
        },
      );
    });

    expect(ready.fastReady).toBe(false);
    expect(ready.visionBusinessReady).toBe(false);
    expect(ready.businessReadinessDiagnostic).toBe(
      "contract_bundle_unavailable",
    );
    expect(ready.schemaVersion).toBe("unavailable");
    expect(ready.bundleVersion).toBe("unavailable");
    expect(ready.contractDigest).toBe("0".repeat(64));
  });
});

describe("vision native browser fallback - pushed profiles", () => {
  it("fences old-generation late messages while delivering only current post-ready events", async () => {
    vi.useFakeTimers();
    const sockets: FakeVisionSocket[] = [];
    class FakeVisionSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly readyState = FakeVisionSocket.OPEN;
      constructor(_url: string) {
        super();
        sockets.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }
      send(): void {
        return undefined;
      }
      close(): void {
        this.dispatchEvent(new Event("close"));
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = FakeVisionSocket as unknown as typeof WebSocket;
    const received: string[] = [];
    const subscription = subscribeVisionProfiles(
      { url: "ws://vision.invalid/ws" },
      {
        onReady: () => {
          received.push("ready");
        },
        onPresenceStatus: (payload) => {
          received.push(`presence:${payload.state}`);
        },
        onProfile: () => undefined,
        onError: (error) => {
          throw error;
        },
      },
    );
    const ready = () => ({
      protocol: "vem.vision.v2",
      type: "vision.ready",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        serverName: "fake",
        serverVersion: "1",
        schemaVersion: "vem-vision-v2-contract-bundle/v1",
        bundleVersion: "1",
        contractDigest: "a".repeat(64),
        cameraReady: true,
        fastReady: true,
        aiReady: false,
        aiReadinessDiagnostic: "model_pack_missing",
        visionBusinessReady: true,
        businessReadinessDiagnostic: "ready",
        capabilities: [],
      },
    });
    const presence = (state: "approach" | "empty") => ({
      protocol: "vem.vision.v2",
      type: "vision.presence_status",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        source: "top",
        eventId: crypto.randomUUID(),
        state,
        detectedAt: new Date().toISOString(),
        reason: "test",
        personPresent: state === "approach",
        occupancy: {
          state: state === "approach" ? "single" : "none",
          confidence: 0.9,
        },
        closeNow: false,
        close: false,
        closeTrigger: null,
        proximity: {
          present: state === "approach",
          closeNow: false,
          close: false,
          method: "test",
        },
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    const first = sockets[0];
    first.emit(presence("approach"));
    first.emit(ready());
    first.emit(presence("empty"));
    expect(received).toEqual(["ready", "presence:empty"]);

    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
    const second = sockets[1];
    first.emit(ready());
    first.emit(presence("approach"));
    expect(received).toEqual(["ready", "presence:empty"]);

    second.emit(ready());
    second.emit(presence("approach"));
    expect(received).toEqual([
      "ready",
      "presence:empty",
      "ready",
      "presence:approach",
    ]);
    subscription.close();
  });

  it("receives a pushed presence event before profile details", async () => {
    const url = await startVisionMock("success");
    const config = { url };

    const result = await new Promise<VisionPresenceStatusPayload>(
      (resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles>;
        subscription = subscribeVisionProfiles(config, {
          onPresenceStatus: (payload) => {
            subscription.close();
            resolve(payload);
          },
          onProfile: () => undefined,
          onError: (error) => {
            subscription.close();
            reject(error);
          },
        });
      },
    );

    expect(result.state).toBe("approach");
    expect(result.personPresent).toBe(true);
    expect(result.occupancy?.state).toBe("single");
    expect(typeof result.detectedAt).toBe("string");
  });

  it("drops business events sent before this generation is ready", async () => {
    const url = await startVisionMock("presence_before_ready");
    const receivedAfterReady = await new Promise<boolean>((resolve, reject) => {
      let ready = false;
      let subscription: ReturnType<typeof subscribeVisionProfiles>;
      subscription = subscribeVisionProfiles(
        { url },
        {
          onReady: () => {
            ready = true;
          },
          onPresenceStatus: () => {
            subscription.close();
            resolve(ready);
          },
          onProfile: () => undefined,
          onError: (error) => {
            subscription.close();
            reject(error);
          },
        },
      );
    });

    expect(receivedAfterReady).toBe(true);
  });

  it("receives a pushed profile from the mock websocket server", async () => {
    const url = await startVisionMock("success");

    const result = await waitForPushedProfile(url);

    expect(typeof result.eventId).toBe("string");
    expect(result.profile.personPresent).toBe(true);
    expect(result.occupancy?.state).toBe("single");
    expect(result.quality.profileUsable).toBe(true);
    expect(result.profile.heightCm).toBe(172);
    expect(result.quality.overall).toBe("fair");
    expect(typeof result.detectedAt).toBe("string");
  });

  it("receives a pushed departure event from the mock websocket server", async () => {
    const url = await startVisionMock("departure_after_presence");
    const config = { url };

    const result = await new Promise<VisionPersonDepartedPayload>(
      (resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles>;
        subscription = subscribeVisionProfiles(config, {
          onPresenceStatus: () => undefined,
          onPersonDeparted: (payload) => {
            subscription.close();
            resolve(payload);
          },
          onProfile: () => undefined,
          onError: (error) => {
            subscription.close();
            reject(error);
          },
        });
      },
    );

    expect(result.reason).toBe("left_frame");
    expect(result.lastSeenAt).toBeTruthy();
  });

  it("keeps waiting silently when no person is detected", async () => {
    const url = await startVisionMock("no_person");
    const config = { url };
    let pushed = false;
    let failed = false;

    const subscription = subscribeVisionProfiles(config, {
      onProfile: () => {
        pushed = true;
      },
      onError: () => {
        failed = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    subscription.close();

    expect(pushed).toBe(false);
    expect(failed).toBe(false);
  });

  it("reports pushed camera_unavailable errors", async () => {
    const url = await startVisionMock("camera_unavailable");
    const config = { url };

    await expect(
      new Promise((resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles>;
        subscription = subscribeVisionProfiles(config, {
          onProfile: resolve,
          onError: (error) => {
            subscription.close();
            reject(error);
          },
        });
      }),
    ).rejects.toThrow("vision camera_unavailable:");
  });

  it("reconnects after the websocket closes", async () => {
    const url = await startVisionMock("disconnect_once");
    const config = { url };

    const result = await new Promise<VisionProfileResultPayload>(
      (resolve, reject) => {
        let subscription: ReturnType<typeof subscribeVisionProfiles> = {
          close: () => undefined,
        };
        const timeout = setTimeout(() => {
          subscription.close();
          reject(new Error("waiting for reconnected profile timed out"));
        }, 5000);
        subscription = subscribeVisionProfiles(config, {
          onProfile: (payload) => {
            clearTimeout(timeout);
            subscription.close();
            resolve(payload);
          },
          onError: () => undefined,
        });
      },
    );

    expect(result.profile.personPresent).toBe(true);
    expect(result.profile.heightCm).toBe(172);
  }, 10_000);
});

describe("vision native browser fallback - Fast attempt lifecycle", () => {
  it("sends exactly one selected AI start and rejects accepted frames with the wrong or missing mode", async () => {
    vi.useFakeTimers();
    const sockets: FakeAiModeSocket[] = [];
    class FakeAiModeSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeAiModeSocket.OPEN;
      readonly sent: string[] = [];
      constructor(_url: string) {
        super();
        sockets.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }
      send(value: string): void {
        this.sent.push(value);
      }
      close(): void {
        this.readyState = FakeAiModeSocket.CLOSED;
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = FakeAiModeSocket as unknown as typeof WebSocket;
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    const events: Array<{ type: string; mode: string | undefined }> = [];
    const opening = openVisionTryOnAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine" },
      { ...fastAttemptInput(attemptId), mode: "ai" },
      (event) =>
        events.push({
          type: event.type,
          mode:
            event.type === "vision.try_on.attempt.accepted"
              ? event.payload.mode
              : undefined,
        }),
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit(
      readyV2Message({
        aiReady: true,
        capabilities: ["try_on_fast", "try_on_ai"],
      }),
    );
    await opening;

    expect(
      sockets[0].sent
        .map((frame) => JSON.parse(frame) as { type: string; payload: object })
        .filter((frame) => frame.type === "vision.try_on.attempt.start"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ attemptId, mode: "ai" }),
      }),
    ]);

    sockets[0].emit({
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.accepted",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { attemptId, mode: "fast" },
    });
    sockets[0].emit({
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.accepted",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { attemptId },
    });
    sockets[0].emit({
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.accepted",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { attemptId, mode: "ai" },
    });

    expect(events).toEqual([
      { type: "vision.try_on.attempt.accepted", mode: "ai" },
    ]);
  });

  it("fails once on an unexpected close and releases every attempt listener and timer", async () => {
    vi.useFakeTimers();
    const sockets: FakeFastSocket[] = [];
    class FakeFastSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeFastSocket.OPEN;
      listenerBalance = 0;
      constructor(_url: string) {
        super();
        sockets.push(this);
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
        this.readyState = FakeFastSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = FakeFastSocket as unknown as typeof WebSocket;
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    const events: string[] = [];
    const opening = openVisionFastAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine", fastAttemptTimeoutMs: 100 },
      {
        attemptId,
        variantId: "550e8400-e29b-41d4-a716-446655440125",
        garment: {
          assetId: "550e8400-e29b-41d4-a716-446655440126",
          reference: `http://127.0.0.1:65499/media/sha256:${"a".repeat(64)}?token=grant-token`,
          digest: `sha256:${"a".repeat(64)}`,
          contentType: "image/png",
          byteSize: 2048,
          template: "tshirt_short_sleeve",
        },
      },
      (event) => events.push(event.type),
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit(readyV2Message());
    const attempt = await opening;

    sockets[0].dispatchEvent(new Event("close"));
    sockets[0].dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(100);

    expect(events).toEqual(["vision.try_on.attempt.canceled"]);
    expect(attempt.resultContext).toEqual({
      attemptId,
      visionSocketUrl: "ws://127.0.0.1:65499/v2/machine",
    });
    expect(sockets[0].listenerBalance).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences late terminal messages after a completed result", async () => {
    vi.useFakeTimers();
    const sockets: FakeTerminalSocket[] = [];
    class FakeTerminalSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeTerminalSocket.OPEN;
      constructor(_url: string) {
        super();
        sockets.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }
      send(): void {
        return undefined;
      }
      close(): void {
        this.readyState = FakeTerminalSocket.CLOSED;
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = FakeTerminalSocket as unknown as typeof WebSocket;
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    const events: string[] = [];
    const opening = openVisionFastAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine" },
      fastAttemptInput(attemptId),
      (event) => events.push(event.type),
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit(readyV2Message());
    await opening;
    sockets[0].emit({
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.accepted",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { attemptId, mode: "fast" },
    });
    sockets[0].emit({
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.acquiring",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        attemptId,
        preview: {
          reference:
            "http://127.0.0.1:65499/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "hold_still",
        manualCaptureAllowed: true,
      },
    });
    sockets[0].emit({
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.generating",
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { attemptId, stage: "preparing" },
    });
    sockets[0].emit(completedV2Message(attemptId));
    sockets[0].emit(failedV2Message(attemptId));

    expect(events).toEqual([
      "vision.try_on.attempt.accepted",
      "vision.try_on.attempt.acquiring",
      "vision.try_on.attempt.generating",
      "vision.try_on.attempt.completed",
    ]);
  });

  it("sends one direction-only manual capture and one user cancellation without reading preview bytes", async () => {
    vi.useFakeTimers();
    const sockets: FakeManualIntentSocket[] = [];
    class FakeManualIntentSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeManualIntentSocket.OPEN;
      readonly sent: string[] = [];
      constructor(_url: string) {
        super();
        sockets.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }
      send(value: string): void {
        this.sent.push(value);
      }
      close(): void {
        this.readyState = FakeManualIntentSocket.CLOSED;
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket =
      FakeManualIntentSocket as unknown as typeof WebSocket;
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    const events: string[] = [];
    const opening = openVisionFastAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine" },
      fastAttemptInput(attemptId),
      (event) => events.push(event.type),
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit(readyV2Message());
    const attempt = await opening;

    expect(attempt.capture()).toBe(true);
    expect(attempt.capture()).toBe(false);
    expect(attempt.cancel("user")).toBe(true);
    expect(attempt.cancel("route_leave")).toBe(false);

    const types = sockets[0].sent.map(
      (frame) => JSON.parse(frame).type as string,
    );
    expect(types).toEqual([
      "vision.hello",
      "vision.try_on.attempt.start",
      "vision.try_on.attempt.capture",
      "vision.try_on.attempt.cancel",
    ]);
    expect(events).toEqual(["vision.try_on.attempt.canceled"]);
  });

  it("sends route_leave as the only route teardown intent", async () => {
    vi.useFakeTimers();
    const sockets: FakeRouteLeaveSocket[] = [];
    class FakeRouteLeaveSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeRouteLeaveSocket.OPEN;
      readonly sent: string[] = [];
      constructor(_url: string) {
        super();
        sockets.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }
      send(value: string): void {
        this.sent.push(value);
      }
      close(): void {
        this.readyState = FakeRouteLeaveSocket.CLOSED;
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = FakeRouteLeaveSocket as unknown as typeof WebSocket;
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    const opening = openVisionFastAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine" },
      fastAttemptInput(attemptId),
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit(readyV2Message());
    const attempt = await opening;

    expect(attempt.cancel("route_leave")).toBe(true);
    const cancel = JSON.parse(
      sockets[0].sent[sockets[0].sent.length - 1] ?? "{}",
    ) as {
      type?: string;
      payload?: { reason?: string };
    };
    expect(cancel).toMatchObject({
      type: "vision.try_on.attempt.cancel",
      payload: { reason: "route_leave" },
    });
  });

  it("accepts only the strict production lifecycle and fences skipped, reversed, and late frames", async () => {
    vi.useFakeTimers();
    const sockets: FakeLifecycleSocket[] = [];
    class FakeLifecycleSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeLifecycleSocket.OPEN;
      constructor(_url: string) {
        super();
        sockets.push(this);
        setTimeout(() => this.dispatchEvent(new Event("open")), 0);
      }
      send(): void {
        return undefined;
      }
      close(): void {
        this.readyState = FakeLifecycleSocket.CLOSED;
      }
      emit(message: object): void {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) }),
        );
      }
    }
    globalThis.WebSocket = FakeLifecycleSocket as unknown as typeof WebSocket;
    const attemptId = "550e8400-e29b-41d4-a716-446655440124";
    const events: string[] = [];
    const opening = openVisionFastAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine" },
      fastAttemptInput(attemptId),
      (event) => events.push(event.type),
    );
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].emit(readyV2Message());
    await opening;
    const envelope = (type: string, payload: object) => ({
      protocol: "vem.vision.v2",
      type,
      messageId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload,
    });
    sockets[0].emit(envelope("vision.hello", readyV2Message().payload));
    sockets[0].emit(
      envelope("vision.try_on.attempt.generating", {
        attemptId,
        stage: "preparing",
      }),
    );
    sockets[0].emit(completedV2Message(attemptId));
    sockets[0].emit(
      envelope("vision.try_on.attempt.accepted", { attemptId, mode: "fast" }),
    );
    sockets[0].emit(
      envelope("vision.try_on.attempt.generating", {
        attemptId,
        stage: "preparing",
      }),
    );
    sockets[0].emit(completedV2Message(attemptId));
    for (const [occupancy, guidance, manualCaptureAllowed] of [
      ["none", "no_person", false],
      ["multiple", "multiple_people", false],
      ["single", "hold_still", true],
    ]) {
      sockets[0].emit(
        envelope("vision.try_on.attempt.acquiring", {
          attemptId,
          preview: {
            reference:
              "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
            streamType: "mjpeg",
          },
          occupancy,
          guidance,
          manualCaptureAllowed,
        }),
      );
    }
    sockets[0].emit(
      envelope("vision.try_on.attempt.generating", {
        attemptId,
        stage: "preparing",
      }),
    );
    sockets[0].emit(
      envelope("vision.try_on.attempt.generating", {
        attemptId,
        stage: "preparing",
      }),
    );
    sockets[0].emit(
      envelope("vision.try_on.attempt.generating", {
        attemptId,
        stage: "rendering",
      }),
    );
    sockets[0].emit(
      envelope("vision.try_on.attempt.generating", {
        attemptId,
        stage: "preparing",
      }),
    );
    sockets[0].emit(
      envelope("vision.try_on.attempt.acquiring", {
        attemptId,
        preview: {
          reference:
            "http://127.0.0.1:65000/v2/try-on/acquisition/preview.mjpeg?token=preview-token",
          streamType: "mjpeg",
        },
        occupancy: "single",
        guidance: "ready",
        manualCaptureAllowed: false,
      }),
    );
    sockets[0].emit(
      envelope("vision.try_on.attempt.canceled", {
        attemptId,
        reason: "replaced",
      }),
    );
    sockets[0].emit(completedV2Message(attemptId));

    expect(events).toEqual([
      "vision.try_on.attempt.accepted",
      "vision.try_on.attempt.acquiring",
      "vision.try_on.attempt.acquiring",
      "vision.try_on.attempt.acquiring",
      "vision.try_on.attempt.generating",
      "vision.try_on.attempt.generating",
      "vision.try_on.attempt.generating",
      "vision.try_on.attempt.canceled",
    ]);
  });

  it("aborts a pending Fast handshake, closes the socket, and releases listeners exactly once", async () => {
    vi.useFakeTimers();
    const sockets: FakeAbortSocket[] = [];
    class FakeAbortSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeAbortSocket.OPEN;
      closeCount = 0;
      listenerBalance = 0;
      constructor(_url: string) {
        super();
        sockets.push(this);
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
        this.readyState = FakeAbortSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }
    globalThis.WebSocket = FakeAbortSocket as unknown as typeof WebSocket;
    const controller = new AbortController();
    const opening = openVisionFastAttempt(
      { url: "ws://127.0.0.1:65499/v2/machine" },
      fastAttemptInput("550e8400-e29b-41d4-a716-446655440124"),
      () => undefined,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    controller.abort();

    await expect(opening).rejects.toThrow(/aborted/);
    expect(sockets[0].closeCount).toBe(1);
    expect(sockets[0].listenerBalance).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function readyV2Message(
  overrides: Partial<{
    fastReady: boolean;
    aiReady: boolean;
    visionBusinessReady: boolean;
    capabilities: string[];
  }> = {},
) {
  return {
    protocol: "vem.vision.v2",
    type: "vision.ready",
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload: {
      serverName: "fake",
      serverVersion: "1",
      schemaVersion: VISION_V2_RUNTIME_IDENTITY.schemaVersion,
      bundleVersion: VISION_V2_RUNTIME_IDENTITY.bundleVersion,
      contractDigest: VISION_V2_RUNTIME_IDENTITY.contractDigest,
      cameraReady: true,
      fastReady: true,
      aiReady: false,
      aiReadinessDiagnostic: "model_pack_missing",
      visionBusinessReady: true,
      businessReadinessDiagnostic: "ready",
      capabilities: ["try_on_fast"],
      ...overrides,
    },
  };
}

function fastAttemptInput(attemptId: string) {
  return {
    attemptId,
    variantId: "550e8400-e29b-41d4-a716-446655440125",
    garment: {
      assetId: "550e8400-e29b-41d4-a716-446655440126",
      reference: `http://127.0.0.1:65499/media/sha256:${"a".repeat(64)}?token=grant-token`,
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png" as const,
      byteSize: 2048,
      template: "tshirt_short_sleeve" as const,
    },
  };
}

function completedV2Message(attemptId: string) {
  return {
    protocol: "vem.vision.v2",
    type: "vision.try_on.attempt.completed",
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload: {
      attemptId,
      result: {
        reference: `http://127.0.0.1:65499/v2/try-on/results/${attemptId}?token=result-token`,
        digest: `sha256:${"a".repeat(64)}`,
        contentType: "image/png",
        byteSize: 2048,
        width: 512,
        height: 768,
      },
    },
  };
}

function failedV2Message(attemptId: string) {
  return {
    protocol: "vem.vision.v2",
    type: "vision.try_on.attempt.failed",
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload: { attemptId, reason: "fast_failed" },
  };
}

describe("vision native browser fallback - vision disabled", () => {
  it("does not open a subscription when vision is disabled", () => {
    const config = { enabled: false };
    let status: string | null = null;

    const subscription = subscribeVisionProfiles(config, {
      onProfile: () => undefined,
      onStatus: (message) => {
        status = message;
      },
    });

    subscription.close();
    expect(status).toBe("视觉模块未启用");
  });
});
