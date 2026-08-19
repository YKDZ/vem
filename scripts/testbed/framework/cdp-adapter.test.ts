import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { CdpTestAdapter } from "./cdp-adapter.ts";
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
