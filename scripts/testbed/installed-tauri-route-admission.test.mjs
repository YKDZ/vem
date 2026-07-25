import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { admitInstalledTauriCatalog } from "./installed-tauri-route-admission.mjs";

describe("installed Tauri route admission", () => {
  it("returns a stale installed UI route to catalog before runtime smoke waits", async () => {
    const calls = [];
    const client = {
      async connect() {
        calls.push("connect");
      },
      async close() {
        calls.push("close");
      },
    };
    let route = "#/result/closed";

    const result = await admitInstalledTauriCatalog(
      { endpoint: "http://127.0.0.1:9222" },
      {
        discoverTarget: async ({ endpoint }) => {
          calls.push(["discover", endpoint]);
          return {
            id: "tauri-page-1",
            webSocketDebuggerUrl:
              "ws://127.0.0.1:9222/devtools/page/tauri-page-1",
          };
        },
        rewriteUrl: (webSocketUrl, endpoint) => {
          calls.push(["rewrite", webSocketUrl, endpoint]);
          return webSocketUrl;
        },
        createClient: (webSocketUrl) => {
          calls.push(["client", webSocketUrl]);
          return client;
        },
        enableRuntime: async () => {
          calls.push("enable");
        },
        evaluate: async (_client, expression) => {
          calls.push(["evaluate", expression]);
          return route;
        },
        returnToCatalog: async ({ evaluateExpressionFn }) => {
          calls.push("returnToCatalog");
          assert.equal(
            await evaluateExpressionFn(client, "location.hash"),
            route,
          );
          route = "#/catalog";
          return route;
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.initialRoute, "#/result/closed");
    assert.equal(result.finalRoute, "#/catalog");
    assert.deepEqual(calls, [
      ["discover", "http://127.0.0.1:9222"],
      [
        "rewrite",
        "ws://127.0.0.1:9222/devtools/page/tauri-page-1",
        "http://127.0.0.1:9222",
      ],
      ["client", "ws://127.0.0.1:9222/devtools/page/tauri-page-1"],
      "connect",
      "enable",
      ["evaluate", "location.hash"],
      "returnToCatalog",
      ["evaluate", "location.hash"],
      ["evaluate", "location.hash"],
      "close",
    ]);
  });

  it("waits for the installed CDP target before returning to catalog", async () => {
    let attempts = 0;
    let timestamp = 1_000;
    const result = await admitInstalledTauriCatalog(
      {
        endpoint: "http://127.0.0.1:9222",
        timeoutMs: 5_000,
        pollMs: 250,
      },
      {
        now: () => timestamp,
        sleep: async (milliseconds) => {
          timestamp += milliseconds;
        },
        discoverTarget: async () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError("fetch failed");
          return {
            id: "tauri-page-1",
            webSocketDebuggerUrl:
              "ws://127.0.0.1:9222/devtools/page/tauri-page-1",
          };
        },
        rewriteUrl: (webSocketUrl) => webSocketUrl,
        createClient: () => ({
          async connect() {},
          async close() {},
        }),
        enableRuntime: async () => {},
        evaluate: async () => "#/catalog",
        returnToCatalog: async () => "#/catalog",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
  });

  it("falls back to direct catalog admission for a stale result page without return controls", async () => {
    const calls = [];
    const client = {
      async connect() {
        calls.push("connect");
      },
      async close() {
        calls.push("close");
      },
    };
    let route = "#/result/manual_handling";

    const result = await admitInstalledTauriCatalog(
      { endpoint: "http://127.0.0.1:9222", pollMs: 250 },
      {
        discoverTarget: async () => ({
          id: "tauri-page-1",
          webSocketDebuggerUrl:
            "ws://127.0.0.1:9222/devtools/page/tauri-page-1",
        }),
        rewriteUrl: (webSocketUrl) => webSocketUrl,
        createClient: () => client,
        enableRuntime: async () => {},
        evaluate: async (_client, expression) => {
          calls.push(["evaluate", expression]);
          if (expression === 'location.hash = "#/catalog"') {
            route = "#/catalog";
            return route;
          }
          return route;
        },
        returnToCatalog: async () => {
          throw new Error("selector is not physically actionable");
        },
        waitForRoute: async (_client, expected, options) => {
          calls.push(["wait", expected, options]);
          assert.equal(route, "#/catalog");
          return { route };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.initialRoute, "#/result/manual_handling");
    assert.equal(result.finalRoute, "#/catalog");
    assert.equal(result.staleResultFallback, true);
    assert.deepEqual(calls, [
      "connect",
      ["evaluate", "location.hash"],
      ["evaluate", 'location.hash = "#/catalog"'],
      ["wait", "#/catalog", { timeoutMs: 10_000, pollMs: 250 }],
      ["evaluate", "location.hash"],
      "close",
    ]);
  });

  it("dismisses a stale terminal order when direct result routing is projected back", async () => {
    const calls = [];
    const client = {
      async connect() {
        calls.push("connect");
      },
      async close() {
        calls.push("close");
      },
    };
    let route = "#/result/manual_handling";
    let waitCount = 0;

    const result = await admitInstalledTauriCatalog(
      { endpoint: "http://127.0.0.1:9222", pollMs: 250 },
      {
        discoverTarget: async () => ({
          id: "tauri-page-1",
          webSocketDebuggerUrl:
            "ws://127.0.0.1:9222/devtools/page/tauri-page-1",
        }),
        rewriteUrl: (webSocketUrl) => webSocketUrl,
        createClient: () => client,
        enableRuntime: async () => {},
        evaluate: async (_client, expression) => {
          calls.push(["evaluate", expression]);
          if (expression === 'location.hash = "#/catalog"') {
            route = "#/result/manual_handling";
            return "#/catalog";
          }
          if (expression.includes("dismissedTerminalOrderNos")) {
            route = "#/catalog";
            return "ORD-MANUAL-001";
          }
          return route;
        },
        returnToCatalog: async () => {
          throw new Error("selector is not physically actionable");
        },
        waitForRoute: async (_client, expected, options) => {
          calls.push(["wait", expected, options]);
          waitCount += 1;
          if (waitCount === 1) {
            throw new Error(
              'route did not reach "#/catalog"; last route was #/result/manual_handling',
            );
          }
          return { route };
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.finalRoute, "#/catalog");
    assert.equal(result.staleResultFallback, true);
    assert.equal(result.dismissedTerminalOrderNo, "ORD-MANUAL-001");
    assert.deepEqual(calls, [
      "connect",
      ["evaluate", "location.hash"],
      ["evaluate", 'location.hash = "#/catalog"'],
      ["wait", "#/catalog", { timeoutMs: 10_000, pollMs: 250 }],
      ["evaluate", calls[4][1]],
      ["wait", "#/catalog", { timeoutMs: 30_000, pollMs: 250 }],
      ["evaluate", "location.hash"],
      "close",
    ]);
    assert.match(calls[4][1], /dismissedTerminalOrderNos/);
  });
});
