import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import {
  CdpClient,
  activateVisibleSelector,
  discoverMachineUiTarget,
  openMachineUiCdpSidecar,
  rewriteWebSocketDebuggerUrl,
  runVisibleMachineSaleScenario,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";

describe("machine-ui-cdp-driver", () => {
  it("selects only strict tauri hash route targets", async () => {
    await withFakeHttpTargets(
      [
        {
          id: "wrong-host",
          url: "http://localhost/#/sale",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/wrong",
        },
        {
          id: "strict",
          url: "http://tauri.localhost/#/sale",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/strict",
        },
      ],
      async (endpoint) => {
        const target = await discoverMachineUiTarget({ endpoint });
        assert.equal(target.id, "strict");
        assert.equal(target.route, "#/sale");
      },
    );
  });

  it("rejects target discovery without a strict tauri route", async () => {
    await withFakeHttpTargets(
      [
        {
          id: "devtools",
          url: "devtools://devtools/bundled/inspector.html",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/devtools",
        },
      ],
      async (endpoint) => {
        await assert.rejects(
          discoverMachineUiTarget({ endpoint }),
          /no strict tauri hash route/,
        );
      },
    );
  });

  it("rewrites debugger websocket URLs to the forwarded endpoint", () => {
    assert.equal(
      rewriteWebSocketDebuggerUrl(
        "ws://127.0.0.1:9222/devtools/page/ABC?token=remote",
        "http://127.0.0.1:49152",
      ),
      "ws://127.0.0.1:49152/devtools/page/ABC?token=remote",
    );
  });

  it("dispatches physical touch input to visible selector bounds", async () => {
    const { factory, sockets } = createFakeWebSocketFactory((message) => {
      if (message.method === "Runtime.evaluate") {
        return {
          id: message.id,
          result: {
            result: {
              value: {
                selector: "[data-testid='buy']",
                exists: true,
                visible: true,
                bounds: { x: 10, y: 20, width: 40, height: 60 },
                center: { x: 30, y: 50 },
              },
            },
          },
        };
      }
      return { id: message.id, result: {} };
    });
    const client = new CdpClient("ws://127.0.0.1/devtools/page/1", {
      webSocketFactory: factory,
    });
    await client.connect();

    const probe = await activateVisibleSelector(client, "[data-testid='buy']", {
      kind: "touch",
    });

    const sent = sockets[0].sent;
    assert.equal(probe.center.x, 30);
    assert.deepEqual(
      sent.map((message) => message.method),
      [
        "Runtime.evaluate",
        "Input.dispatchTouchEvent",
        "Input.dispatchTouchEvent",
      ],
    );
    assert.equal(sent[1].params.type, "touchStart");
    assert.deepEqual(sent[1].params.touchPoints[0], {
      x: 30,
      y: 50,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    });
    assert.equal(sent[2].params.type, "touchEnd");
    assert.doesNotMatch(sent[0].params.expression, /\.click\s*\(/);
    await client.close();
  });

  it("rejects stale or wrong initial target route before driving input", async () => {
    await withFakeHttpTargets(
      [
        {
          id: "stale",
          url: "http://tauri.localhost/#/maintenance",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/stale",
        },
      ],
      async (endpoint) => {
        const { factory, sockets } = createFakeWebSocketFactory((message) => ({
          id: message.id,
          result: {},
        }));
        await assert.rejects(
          runVisibleMachineSaleScenario({
            endpoint,
            webSocketFactory: factory,
            expectedInitialRoute: "#/sale",
            steps: [
              {
                name: "buy",
                selector: "[data-testid='buy']",
              },
            ],
            continuousCapture: false,
          }),
          /initial CDP target route mismatch/,
        );
        assert.equal(sockets.length, 0);
      },
    );
  });

  it("times out CDP requests and removes the pending request", async () => {
    const { factory } = createFakeWebSocketFactory(() => null);
    const client = new CdpClient("ws://127.0.0.1/devtools/page/timeout", {
      webSocketFactory: factory,
      defaultTimeoutMs: 20,
    });
    await client.connect();

    await assert.rejects(
      client.send("Runtime.evaluate", {}, { timeoutMs: 10 }),
      /CDP Runtime\.evaluate timed out/,
    );
    assert.equal(client.pending.size, 0);
    await client.close();
  });

  it("rejects route waits that remain on the wrong route", async () => {
    const { factory } = createFakeWebSocketFactory((message) => {
      if (message.method === "Runtime.evaluate") {
        return {
          id: message.id,
          result: {
            result: {
              value: {
                url: "http://tauri.localhost/#/checkout",
                route: "#/checkout",
                domHash: "deadbeef",
              },
            },
          },
        };
      }
      return { id: message.id, result: {} };
    });
    const client = new CdpClient("ws://127.0.0.1/devtools/page/route", {
      webSocketFactory: factory,
    });
    await client.connect();

    await assert.rejects(
      waitForRoute(client, "#/success", { timeoutMs: 30, pollMs: 1 }),
      /last route was #\/checkout/,
    );
    await client.close();
  });

  it("cleans up websocket and sidecar process resources", async () => {
    await withFakeHttpTargets(
      [
        {
          id: "strict",
          url: "http://tauri.localhost/#/sale",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/strict",
        },
      ],
      async (endpoint) => {
        const { factory, sockets } = createFakeWebSocketFactory((message) => {
          if (message.method === "Runtime.evaluate") {
            return {
              id: message.id,
              result: {
                result: {
                  value: {
                    url: "http://tauri.localhost/#/sale",
                    route: "#/sale",
                    domHash: "11111111",
                  },
                },
              },
            };
          }
          return { id: message.id, result: {} };
        });

        const result = await runVisibleMachineSaleScenario({
          endpoint,
          webSocketFactory: factory,
          expectedInitialRoute: "#/sale",
          steps: [],
          continuousCapture: false,
        });

        assert.equal(result.status, "passed");
        assert.equal(sockets[0].closeCalls, 1);
      },
    );

    const child = new FakeChildProcess();
    const processAdapter = {
      spawn(command, args) {
        child.command = command;
        child.args = args;
        return child;
      },
    };
    const sidecar = await openMachineUiCdpSidecar({
      remote: "user@example.test",
      localPort: 49222,
      processAdapter,
    });
    assert.equal(sidecar.endpoint, "http://127.0.0.1:49222");
    assert.equal(child.command, "ssh");
    assert.deepEqual(child.args.slice(0, 3), [
      "-N",
      "-L",
      "127.0.0.1:49222:127.0.0.1:9222",
    ]);
    await sidecar.close();
    await sidecar.close();
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  });
});

async function withFakeHttpTargets(targets, callback) {
  const server = createServer((request, response) => {
    if (request.url !== "/json") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(targets));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function createFakeWebSocketFactory(handler) {
  const sockets = [];
  return {
    sockets,
    factory(url) {
      const socket = new FakeWebSocket(url, handler);
      sockets.push(socket);
      return socket;
    },
  };
}

class FakeWebSocket {
  constructor(url, handler) {
    this.url = url;
    this.handler = handler;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.listeners = new Map();
    queueMicrotask(() => {
      this.readyState = 1;
      this.#emit("open", {});
    });
  }

  addEventListener(type, handler, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    const entry = { handler, once: options.once === true };
    this.listeners.get(type).push(entry);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    const response = this.handler(message, this);
    if (response == null) return;
    queueMicrotask(() =>
      this.#emit("message", { data: JSON.stringify(response) }),
    );
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.#emit("close", {});
  }

  #emit(type, event) {
    const entries = [...(this.listeners.get(type) ?? [])];
    for (const entry of entries) entry.handler(event);
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => !entry.once),
    );
  }
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.killed = false;
    this.killSignals = [];
  }

  kill(signal) {
    this.killed = true;
    this.killSignals.push(signal);
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, signal);
      this.emit("close", 0, signal);
    });
  }
}
