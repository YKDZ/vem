#!/usr/bin/env node

import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { returnToCatalogFromClient } from "./full-workflow-orchestrator.ts";
import {
  CdpClient,
  discoverCanonicalMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  rewriteWebSocketDebuggerUrl,
  waitForRoute,
} from "./machine-ui-cdp-driver.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_MS = 500;
const DISMISSED_TERMINAL_ORDER_STORAGE_KEY =
  "vem.machine.dismissedTerminalOrderNos";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}

function option(args, name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return required(args[index + 1], name);
}

export async function admitInstalledTauriCatalog(
  {
    endpoint = DEFAULT_ENDPOINT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
  } = {},
  dependencies = {},
) {
  const discoverTarget =
    dependencies.discoverTarget ?? discoverCanonicalMachineUiTarget;
  const createClient =
    dependencies.createClient ??
    ((webSocketUrl) =>
      new CdpClient(webSocketUrl, {
        webSocketFactory: dependencies.webSocketFactory,
      }));
  const enableRuntime = dependencies.enableRuntime ?? enablePageRuntime;
  const evaluate = dependencies.evaluate ?? evaluateExpression;
  const returnToCatalog =
    dependencies.returnToCatalog ?? returnToCatalogFromClient;
  const waitForRouteFn = dependencies.waitForRoute ?? waitForRoute;
  const rewriteUrl = dependencies.rewriteUrl ?? rewriteWebSocketDebuggerUrl;

  const now = dependencies.now ?? (() => Date.now());
  const sleepFor = dependencies.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  let target;
  let lastError;
  do {
    try {
      target = await discoverTarget({ endpoint });
      break;
    } catch (error) {
      lastError = error;
      if (now() >= deadline) break;
      await sleepFor(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  } while (now() < deadline);
  if (!target) {
    throw new Error(
      `installed Tauri CDP target did not become observable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { cause: lastError },
    );
  }
  const client = createClient(
    rewriteUrl(target.webSocketDebuggerUrl, endpoint),
  );
  await client.connect();
  try {
    await enableRuntime(client);
    const initialRoute = await evaluate(client, "location.hash");
    let route;
    let staleResultFallback = false;
    let dismissedTerminalOrderNo = null;
    try {
      route = await returnToCatalog({
        client,
        evaluateExpressionFn: evaluate,
      });
    } catch (error) {
      if (!/^#\/result(?:\/|$)/.test(initialRoute ?? "")) throw error;
      staleResultFallback = true;
      await evaluate(client, 'location.hash = "#/catalog"');
      try {
        route = (
          await waitForRouteFn(client, "#/catalog", {
            timeoutMs: 10_000,
            pollMs,
          })
        ).route;
      } catch (directRouteError) {
        const dismissedOrderNo = await evaluate(
          client,
          `(() => {
            const orderNo = document.querySelector("[data-test='result-page']")?.dataset.orderNo || "";
            if (!orderNo) return null;
            const storageKey = ${JSON.stringify(DISMISSED_TERMINAL_ORDER_STORAGE_KEY)};
            const existing = JSON.parse(localStorage.getItem(storageKey) || "[]");
            const next = Array.isArray(existing)
              ? existing.filter((value) => value !== orderNo)
              : [];
            next.push(orderNo);
            localStorage.setItem(storageKey, JSON.stringify(next.slice(-50)));
            location.hash = "#/catalog";
            location.reload();
            return orderNo;
          })()`,
        );
        if (typeof dismissedOrderNo !== "string" || dismissedOrderNo === "") {
          throw directRouteError;
        }
        dismissedTerminalOrderNo = dismissedOrderNo;
        route = (
          await waitForRouteFn(client, "#/catalog", {
            timeoutMs: 30_000,
            pollMs,
          })
        ).route;
      }
    }
    const finalRoute = await evaluate(client, "location.hash");
    return {
      schemaVersion: "vem-installed-tauri-route-admission/v1",
      ok: finalRoute === "#/catalog",
      endpoint,
      targetId: target.id,
      initialRoute,
      route,
      finalRoute,
      staleResultFallback,
      dismissedTerminalOrderNo,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const result = await admitInstalledTauriCatalog({
    endpoint: option(process.argv.slice(2), "endpoint", DEFAULT_ENDPOINT),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
