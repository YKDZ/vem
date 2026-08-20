import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import {
  CapturedFrameEvidenceCache,
  CdpTestAdapter,
  isControlledCapturedFrameReference,
  VisionProtocolEvidenceCollector,
} from "./cdp-adapter.ts";
import { assertAdapterContract } from "./test-adapter.ts";

describe("CDP test adapter", () => {
  it("implements the shared adapter contract", () => {
    const adapter = new CdpTestAdapter({ endpoint: "http://127.0.0.1:1" });
    assertAdapterContract(adapter);
    assert.equal(typeof adapter.connect, "function");
    assert.equal(typeof adapter.close, "function");
  });

  it("exposes only the try-on state file the slice driver reads", async () => {
    const adapter = new CdpTestAdapter();
    await assert.rejects(
      adapter.readFile("other.json"),
      /unknown adapter file/,
    );
  });

  it("allows only the controlled V2 captured-frame reference before fetching it", () => {
    assert.equal(
      isControlledCapturedFrameReference(
        "http://127.0.0.1:7892/v2/try-on/captured/frame.png?token=captured-token",
      ),
      true,
    );
    assert.equal(
      isControlledCapturedFrameReference(
        "https://example.test/v2/try-on/captured/frame.png?token=captured-token",
      ),
      false,
    );
    assert.equal(
      isControlledCapturedFrameReference(
        "http://127.0.0.1:7892/v2/try-on/results/frame.png?token=captured-token",
      ),
      false,
    );
    assert.equal(
      isControlledCapturedFrameReference(
        "http://127.0.0.1:99999/v2/try-on/captured/frame.png?token=captured-token",
      ),
      false,
    );
  });

  it("records only frames from the configured Vision websocket origin", () => {
    const collector = new VisionProtocolEvidenceCollector(
      "http://127.0.0.1:27892",
    );
    const message = {
      protocol: "vem.vision.v2",
      type: "vision.try_on.attempt.captured",
      payload: {
        attemptId: "attempt-1",
        captured: {
          reference:
            "http://127.0.0.1:27892/v2/try-on/captured/frame.png?token=captured-token",
        },
      },
    };
    collector.observeWebSocketCreated({
      requestId: "foreign",
      url: "ws://127.0.0.1:27893/v2/machine",
    });
    collector.observeWebSocketFrameReceived({
      requestId: "foreign",
      response: { payloadData: JSON.stringify(message) },
    });
    collector.observeWebSocketCreated({
      requestId: "vision-current",
      url: "ws://127.0.0.1:27892/v2/machine",
    });
    collector.observeWebSocketFrameReceived({
      requestId: "vision-current",
      response: { payloadData: JSON.stringify(message) },
    });

    assert.deepEqual(collector.eventsForAttempt("attempt-1"), [
      {
        type: "vision.try_on.attempt.captured",
        requestId: "vision-current",
        origin: "http://127.0.0.1:27892",
        payload: message.payload,
      },
    ]);
  });

  it("refetches a captured URL when a different attempt claims it", async () => {
    let fetches = 0;
    const firstFrame = readFileSync(
      new URL("../../../apps/machine/src-tauri/app-icon.png", import.meta.url),
    );
    const secondFrame = readFileSync(
      new URL(
        "../../../apps/machine/src/assets/home/icon-socks.png",
        import.meta.url,
      ),
    );
    const cache = new CapturedFrameEvidenceCache({
      fetchImpl: async (reference) => {
        fetches += 1;
        const bytes = fetches === 1 ? firstFrame : secondFrame;
        return {
          ok: true,
          status: 200,
          url: reference.toString(),
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: async () =>
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
        } as Response;
      },
    });
    const captured = {
      reference:
        "http://127.0.0.1:27892/v2/try-on/captured/frame.png?token=captured-token",
      digest: `sha256:${"a".repeat(64)}`,
      contentType: "image/png" as const,
      byteSize: 2048,
      width: 640,
      height: 480,
      frameId: "frame-1",
    };
    const first = await cache.read({
      attemptId: "attempt-1",
      visionOrigin: "http://127.0.0.1:27892",
      captured,
    });
    const second = await cache.read({
      attemptId: "attempt-2",
      visionOrigin: "http://127.0.0.1:27892",
      captured,
    });

    assert.equal(fetches, 2);
    assert.notEqual(first?.digest, second?.digest);
    assert.equal(second?.attemptId, "attempt-2");
  });

  it("maps declared role commands to the Vision runtime boundary", async () => {
    const stops: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === "/v2/runtime/roles" && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            schemaVersion: "vem-vision-runtime-roles/v1",
            roles: [
              { name: "observer", pid: null, ready: false },
              { name: "broker", pid: 2002, ready: true },
            ],
          }),
        );
        return;
      }
      if (
        request.url === "/v2/runtime/roles/observer/stop" &&
        request.method === "POST"
      ) {
        stops.push(request.url);
        response.end(JSON.stringify({ role: "observer", stopped: true }));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", () => resolvePromise()),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    const { port } = address;
    try {
      const adapter = new CdpTestAdapter({
        endpoint: "http://127.0.0.1:1",
        visionBaseUrl: `http://127.0.0.1:${port}`,
      });
      const stopped = await adapter.run("stop-vision-role", [
        "--role",
        "observer",
      ]);
      assert.equal(stopped.exitCode, 0);
      const probe = await adapter.run("probe-vision-role", ["observer"]);
      assert.equal(probe.exitCode, 0);
      assert.equal(probe.stdout, "dead");
      assert.deepEqual(stops, ["/v2/runtime/roles/observer/stop"]);
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    }
  });
});
