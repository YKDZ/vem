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

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required`);
  return value.trim();
}

function option(
  args: string[],
  name: string,
  fallback: string | null = null,
): string | null {
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
  dependencies: JsonRecord = {},
): Promise<JsonRecord> {
  const dependenciesTyped = dependencies as {
    discoverTarget?: typeof discoverCanonicalMachineUiTarget;
    createClient?: (webSocketUrl: string) => CdpClient;
    enableRuntime?: typeof enablePageRuntime;
    evaluate?: typeof evaluateExpression;
    returnToCatalog?: typeof returnToCatalogFromClient;
    waitForRoute?: typeof waitForRoute;
    rewriteUrl?: typeof rewriteWebSocketDebuggerUrl;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    webSocketFactory?: unknown;
  };
  const discoverTarget =
    dependenciesTyped.discoverTarget ?? discoverCanonicalMachineUiTarget;
  const createClient =
    dependenciesTyped.createClient ??
    ((webSocketUrl) =>
      new CdpClient(webSocketUrl, {
        webSocketFactory: dependenciesTyped.webSocketFactory as NonNullable<
          ConstructorParameters<typeof CdpClient>[1]
        >["webSocketFactory"],
      }));
  const enableRuntime = dependenciesTyped.enableRuntime ?? enablePageRuntime;
  const evaluate = dependenciesTyped.evaluate ?? evaluateExpression;
  const returnToCatalog =
    dependenciesTyped.returnToCatalog ?? returnToCatalogFromClient;
  const waitForRouteFn = dependenciesTyped.waitForRoute ?? waitForRoute;
  const rewriteUrl =
    dependenciesTyped.rewriteUrl ?? rewriteWebSocketDebuggerUrl;

  const now = dependenciesTyped.now ?? (() => Date.now());
  const sleepFor = dependenciesTyped.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  let target: JsonRecord | null = null;
  let lastError: unknown;
  do {
    try {
      target = recordValue(await discoverTarget({ endpoint }));
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
    rewriteUrl(String(target.webSocketDebuggerUrl), endpoint),
  );
  await client.connect();
  try {
    await enableRuntime(client);
    const initialRoute = await evaluate(client, "location.hash");
    let route: unknown;
    let staleResultFallback = false;
    let dismissedTerminalOrderNo = null;
    try {
      route = await returnToCatalog({
        client,
        evaluateExpressionFn: evaluate,
      });
    } catch (error) {
      if (!/^#\/result(?:\/|$)/.test(String(initialRoute ?? ""))) throw error;
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
        let dismissedOrderNo: unknown = null;
        const dismissDeadline = now() + 5_000;
        do {
          dismissedOrderNo = await evaluate(
            client,
            `(() => {
              const remember = (orderNo) => {
                const storageKey = ${JSON.stringify(
                  DISMISSED_TERMINAL_ORDER_STORAGE_KEY,
                )};
                const existing = JSON.parse(localStorage.getItem(storageKey) || "[]");
                const next = Array.isArray(existing)
                  ? existing.filter((value) => value !== orderNo)
                  : [];
                next.push(orderNo);
                localStorage.setItem(storageKey, JSON.stringify(next.slice(-50)));
                location.hash = "#/catalog";
                location.reload();
                return orderNo;
              };
              const page = document.querySelector("[data-test='result-page']");
              const domOrderNo = page?.dataset.orderNo || "";
              if (domOrderNo) return remember(domOrderNo);
              const trace = window.__VEM_MACHINE_RUNTIME_TRACE__ || [];
              const surface = [...trace].reverse().find(
                (entry) =>
                  entry?.type === "transaction_surface" &&
                  typeof entry.orderNo === "string" &&
                  entry.orderNo !== "",
              );
              return surface?.orderNo ? remember(surface.orderNo) : null;
            })()`,
          );
          if (typeof dismissedOrderNo === "string" && dismissedOrderNo !== "")
            break;
          if (now() < dismissDeadline) {
            await sleepFor(
              Math.min(pollMs, Math.max(0, dismissDeadline - now())),
            );
          }
        } while (now() < dismissDeadline);
        if (typeof dismissedOrderNo !== "string" || dismissedOrderNo === "") {
          throw directRouteError;
        }
        dismissedTerminalOrderNo = dismissedOrderNo;
        try {
          route = (
            await waitForRouteFn(client, "#/catalog", {
              timeoutMs: 30_000,
              pollMs,
            })
          ).route;
        } catch (postDismissError) {
          // 重启后的终态结果可能再次投影；回到正常返回路径重试直到可操作。
          const retryDeadline = now() + 30_000;
          do {
            try {
              const retried = await returnToCatalog({
                client,
                evaluateExpressionFn: evaluate,
              });
              route = String(
                (retried as { route?: unknown } | null | undefined)?.route ??
                  "",
              );
              if (route === "#/catalog") break;
            } catch {
              // 结果页尚未可操作时继续等待重试。
            }
            if (now() < retryDeadline) {
              await sleepFor(
                Math.min(pollMs, Math.max(0, retryDeadline - now())),
              );
            }
          } while (now() < retryDeadline);
          if (route !== "#/catalog") {
            const pageState = await evaluate(
              client,
              `(() => {
                const page = document.querySelector("[data-test='result-page']");
                return {
                  orderNo: page?.dataset.orderNo ?? null,
                  returnButton: Boolean(
                    document.querySelector(
                      "[data-test='result-return-catalog']:not(:disabled)",
                    ),
                  ),
                };
              })()`,
            ).catch(() => null);
            throw new Error(
              `stale result dismissal did not reach catalog; page=${JSON.stringify(pageState)}`,
              { cause: postDismissError },
            );
          }
        }
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

async function main(): Promise<void> {
  const result = await admitInstalledTauriCatalog({
    endpoint: option(
      process.argv.slice(2),
      "endpoint",
      DEFAULT_ENDPOINT,
    ) as string,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok !== true) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
