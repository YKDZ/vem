import { writeFileSync } from "node:fs";

import { evaluateExpression } from "./machine-ui-cdp-driver.mjs";

const REQUIRED_SURFACES = new Set([
  "ordinary_warning",
  "urgent_warning",
  "reset_progress",
]);

export async function readInstalledMachineProductionSample(
  client,
  options = {},
) {
  return evaluateExpression(
    client,
    `(() => {
      const surface = document.querySelector('[data-installed-kiosk-sale-fulfillment-surface]');
      const trace = window.__VEM_MACHINE_RUNTIME_TRACE__;
      if (!Array.isArray(trace)) throw new Error('Machine Runtime Trace is unavailable');
      return {
        observedAt: new Date().toISOString(),
        route: location.hash,
        surface: surface?.dataset?.pickupSurface ?? 'none',
        orderId: surface?.dataset?.orderId ?? null,
        orderNo: surface?.dataset?.orderNo ?? null,
        commandId: surface?.dataset?.commandId ?? null,
        commandNo: surface?.dataset?.commandNo ?? null,
        runtimeTrace: structuredClone(trace)
      };
    })()`,
    options,
  );
}

export function startDelayedPickupMachineEvidenceCapture({
  client,
  binding,
  runtime,
  intervalMs = 100,
  readSample = readInstalledMachineProductionSample,
}) {
  if (!client) throw new Error("installed canonical CDP client is required");
  if (!Number.isInteger(intervalMs) || intervalMs < 25 || intervalMs > 1_000)
    throw new Error("machine evidence interval must be 25 through 1000ms");
  const uiObservations = [];
  let runtimeTrace = [];
  let stopped = false;
  let timer = null;
  let active = Promise.resolve();
  let failure = null;

  async function poll() {
    if (stopped || failure) return;
    try {
      const sample = await readSample(client, { timeoutMs: 5_000 });
      if (!sample || !Array.isArray(sample.runtimeTrace))
        throw new Error("installed Machine production sample is invalid");
      runtimeTrace = sample.runtimeTrace;
      if (REQUIRED_SURFACES.has(sample.surface)) {
        if (
          sample.route !== "#/dispensing" ||
          sample.orderId !== binding.orderId ||
          sample.orderNo !== binding.orderNo ||
          sample.commandId !== binding.commandId ||
          sample.commandNo !== binding.commandNo
        )
          throw new Error("installed Machine DOM sale binding is invalid");
        if (!uiObservations.some((entry) => entry.surface === sample.surface))
          uiObservations.push({
            surface: sample.surface,
            route: sample.route,
            observedAt: sample.observedAt,
            binding: { ...binding },
            runtime: { ...runtime },
          });
      }
    } catch (error) {
      failure = error;
    }
  }

  function schedule() {
    timer = setInterval(() => {
      active = active.then(poll);
    }, intervalMs);
  }
  active = poll();
  schedule();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
      if (failure) throw failure;
      return {
        schemaVersion: "machine-production-evidence/v1",
        source: "installed_canonical_machine_cdp",
        binding: { ...binding },
        runtime: { ...runtime },
        uiObservations,
        runtimeTrace,
      };
    },
  };
}

export function writeDelayedPickupMachineEvidence(path, evidence) {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}
