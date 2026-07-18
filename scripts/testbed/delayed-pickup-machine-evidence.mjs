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

export async function observeInstalledMachineRuntime({
  client,
  inspectRuntime,
}) {
  if (!client || typeof client.observeIdentity !== "function")
    throw new Error("connected production CDP client is required");
  if (typeof inspectRuntime !== "function")
    throw new Error("Windows runtime inspector is required");
  const [windows, cdp] = await Promise.all([
    inspectRuntime(),
    client.observeIdentity(),
  ]);
  const machine = windows?.machine;
  const listener = windows?.cdpListener;
  if (
    !Number.isSafeInteger(machine?.processId) ||
    machine.processId < 1 ||
    !Number.isSafeInteger(machine?.sessionId) ||
    machine.sessionId < 1 ||
    typeof machine?.executablePath !== "string" ||
    typeof machine?.principal !== "string" ||
    listener?.machineAncestorProcessId !== machine.processId ||
    listener?.sessionId !== machine.sessionId ||
    listener?.principal !== machine.principal ||
    typeof cdp?.targetId !== "string" ||
    typeof cdp?.sessionId !== "string"
  )
    throw new Error("installed Windows process/CDP identity is incomplete");
  return {
    processId: machine.processId,
    executablePath: machine.executablePath,
    principal: machine.principal,
    sessionId: machine.sessionId,
    cdpTargetId: cdp.targetId,
    cdpSessionId: cdp.sessionId,
    observedAt: cdp.connectedAt,
    source: "windows_process_and_live_cdp_client",
  };
}

export async function startDelayedPickupMachineEvidenceCapture({
  client,
  inspectRuntime,
  intervalMs = 100,
  readSample = readInstalledMachineProductionSample,
  onSample,
}) {
  if (!client) throw new Error("installed canonical CDP client is required");
  if (!Number.isInteger(intervalMs) || intervalMs < 25 || intervalMs > 1_000)
    throw new Error("machine evidence interval must be 25 through 1000ms");
  const runtime = await observeInstalledMachineRuntime({
    client,
    inspectRuntime,
  });
  const captureStartedAt = new Date().toISOString();
  const uiObservations = [];
  let runtimeTrace = [];
  let stopped = false;
  let timer = null;
  let active = Promise.resolve();
  let failure = null;
  let finalizing = null;
  let finalizeMode = null;

  async function poll() {
    if (stopped || failure) return;
    try {
      const sample = await readSample(client, { timeoutMs: 5_000 });
      if (!sample || !Array.isArray(sample.runtimeTrace))
        throw new Error("installed Machine production sample is invalid");
      if (typeof onSample === "function") await onSample(sample);
      runtimeTrace = sample.runtimeTrace;
      if (REQUIRED_SURFACES.has(sample.surface)) {
        if (sample.route !== "#/dispensing")
          throw new Error("installed Machine DOM sale binding is invalid");
        if (!uiObservations.some((entry) => entry.surface === sample.surface))
          uiObservations.push({
            surface: sample.surface,
            route: sample.route,
            observedAt: sample.observedAt,
            observedSale: {
              orderId: sample.orderId,
              orderNo: sample.orderNo,
              commandId: sample.commandId,
              commandNo: sample.commandNo,
            },
          });
      }
    } catch (error) {
      failure = error;
      stopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  }

  function schedule() {
    timer = setInterval(() => {
      active = active.then(poll);
    }, intervalMs);
  }

  async function finalize(mode, binding = null) {
    if (finalizing) {
      if (mode === "cancel" || finalizeMode === "cancel")
        return finalizing.catch(() => undefined);
      return finalizing.then((value) => {
        if (mode === "stop") return value;
      });
    }
    finalizeMode = mode;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    finalizing = active.then(() => {
      if (mode === "cancel") return undefined;
      if (failure) throw failure;
      for (const observation of uiObservations)
        for (const name of ["orderId", "orderNo", "commandId", "commandNo"])
          if (observation.observedSale[name] !== binding?.[name])
            throw new Error("installed Machine DOM sale binding is invalid");
      return {
        schemaVersion: "machine-production-evidence/v2",
        source: "installed_canonical_machine_cdp",
        binding: { ...binding },
        runtime: { ...runtime },
        captureStartedAt,
        captureCompletedAt: new Date().toISOString(),
        uiObservations,
        runtimeTrace,
      };
    });
    return finalizing;
  }

  active = poll();
  schedule();
  return {
    runtime: { ...runtime },
    async cancel() {
      await finalize("cancel");
    },
    async stop(binding) {
      return finalize("stop", binding);
    },
  };
}

export function writeDelayedPickupMachineEvidence(path, evidence) {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
}
