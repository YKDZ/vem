import { evaluateExpression } from "./machine-ui-cdp-driver.mjs";
import { collectVisionReadyHandshake } from "./vision-try-on-acceptance.mjs";

const DIAGNOSTICS = new Set([
  "model_pack_missing",
  "model_pack_invalid",
  "worker_unavailable",
]);

async function readJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(5_000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(`installed degradation endpoint failed: ${url}`);
  return value;
}

export async function collectInstalledAiDegradationEvidence({
  client,
  daemonOrigin,
  daemonToken,
  expectedDiagnostic,
  machineCode,
  visionOrigin = "http://127.0.0.1:7892",
  readReady = collectVisionReadyHandshake,
}) {
  if (!DIAGNOSTICS.has(expectedDiagnostic))
    throw new Error("installed AI degradation diagnostic is invalid");
  const [vision, ready, daemonHealth, daemonReady, sale, machine] =
    await Promise.all([
      readJson(`${visionOrigin}/health`),
      readReady({ machineCode }),
      readJson(`${daemonOrigin}/healthz`, {
        headers: { authorization: `Bearer ${daemonToken}` },
      }),
      readJson(`${daemonOrigin}/readyz`, {
        headers: { authorization: `Bearer ${daemonToken}` },
      }),
      readJson(`${daemonOrigin}/v1/sale-start-capability`, {
        headers: { authorization: `Bearer ${daemonToken}` },
      }),
      evaluateExpression(
        client,
        `(() => ({
        buyAvailable: document.querySelector('[data-test="product-buy"]')?.disabled === false,
        catalogAvailable: document.querySelector('[data-test="catalog-page"]') !== null,
        machineUiAvailable: document.documentElement !== null,
        tryOnAiAvailable: document.querySelector('[data-test="try-on-ai"]')?.disabled === false,
      }))()`,
      ),
    ]);
  if (
    !["ok", "degraded"].includes(vision?.status) ||
    vision.protocol !== "vem.vision.v2" ||
    vision.cameraReady !== true ||
    vision.aiReady !== false ||
    vision.aiReadinessDiagnostic !== expectedDiagnostic ||
    ready?.payload?.aiReady !== false ||
    ready.payload.aiReadinessDiagnostic !== expectedDiagnostic ||
    ready.payload.fastReady !== true ||
    ready.payload.visionBusinessReady !== true ||
    !ready.payload.capabilities?.includes("try_on_fast") ||
    ready.payload.capabilities.includes("try_on_ai") ||
    daemonHealth?.status !== "healthy" ||
    daemonReady?.ready !== true ||
    sale?.canStartSale !== true ||
    machine?.machineUiAvailable !== true ||
    machine.catalogAvailable !== true ||
    machine.buyAvailable !== true ||
    machine.tryOnAiAvailable !== false
  )
    throw new Error("installed AI degradation public evidence is invalid");
  return {
    aiReady: false,
    coreReady: true,
    daemonReady: true,
    fastReady: true,
    machineUiAvailable: true,
    saleAvailable: true,
  };
}
