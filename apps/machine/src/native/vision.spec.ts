import { VISION_V2_RUNTIME_IDENTITY } from "@vem/shared";
import { createServer as createHttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  openVisionGarmentAdjustment,
  openVisionTryOnAttempt,
  visionSelfCheck,
} from "./vision";

const servers: Array<ReturnType<typeof createHttpServer>> = [];
const attemptId = "550e8400-e29b-41d4-a716-446655440124";

afterEach(async () => {
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
