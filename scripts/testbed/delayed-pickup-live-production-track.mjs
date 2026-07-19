import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createDaemonFulfillmentStoreEvidence } from "./delayed-pickup-daemon-evidence.mjs";
import {
  startDelayedPickupMachineEvidenceCapture,
  writeDelayedPickupMachineEvidence,
} from "./delayed-pickup-machine-evidence.mjs";
import {
  CdpClient,
  discoverCanonicalMachineUiTarget,
  enablePageRuntime,
  inspectWindowsMachineUiRuntime,
  openMachineUiCdpSidecar,
  rewriteWebSocketDebuggerUrl,
} from "./machine-ui-cdp-driver.mjs";

const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";
const CLOSE_TIMEOUT_MS = 10_000;

function required(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0)
    throw new Error(`${label} is required`);
  return value;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function audioRuntimeArgs(runtime) {
  return [
    "--machine-process-id",
    String(runtime.processId),
    "--machine-executable-path",
    runtime.executablePath,
    "--interactive-principal",
    runtime.principal,
    "--interactive-session-id",
    String(runtime.sessionId),
    "--cdp-target-id",
    runtime.cdpTargetId,
    "--cdp-session-id",
    runtime.cdpSessionId,
  ];
}

function observedSaleBinding(base, sample) {
  const observed = {
    ...base,
    orderId: sample?.orderId,
    orderNo: sample?.orderNo,
    commandId: sample?.commandId,
    commandNo: sample?.commandNo,
  };
  for (const name of ["orderId", "orderNo", "commandId", "commandNo"])
    required(observed[name], `observed Machine ${name}`);
  return observed;
}

function sameBinding(left, right) {
  return [
    "runId",
    "lifecycleReference",
    "transactionId",
    "saleCorrelationId",
    "orderId",
    "orderNo",
    "commandId",
    "commandNo",
  ].every((name) => left?.[name] === right?.[name]);
}

function bindCheckpoint(checkpoint, binding) {
  return { ...checkpoint, binding: { ...binding } };
}

function normalizeObservedFrameHex(frame) {
  const value =
    typeof frame?.rawFrameHex === "string" ? frame.rawFrameHex : frame?.bytesHex;
  const normalized = String(value ?? "").toLowerCase();
  return /^[0-9a-f]+$/.test(normalized) ? normalized : null;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function cleanupTimeout(label, timeoutMs) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms cleanup deadline`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function runCloseStep(label, action, timeoutMs = CLOSE_TIMEOUT_MS) {
  try {
    return await Promise.race([action(), cleanupTimeout(label, timeoutMs)]);
  } catch (error) {
    const wrapped = new Error(`${label} failed: ${formatError(error)}`);
    wrapped.cause = error;
    wrapped.cleanupLabel = label;
    throw wrapped;
  }
}

async function captureSurvivingRuntimeEvidence({
  runtime,
  client,
  sidecar,
  inspectRuntime,
}) {
  const evidence = {
    capturedAt: new Date().toISOString(),
    runtime: runtime ? { ...runtime } : null,
    sidecarEndpoint: sidecar?.endpoint ?? null,
    processSessionInspection: null,
    cdpIdentity: null,
  };
  if (typeof inspectRuntime === "function") {
    try {
      evidence.processSessionInspection = await Promise.race([
        inspectRuntime(),
        cleanupTimeout("process/session evidence", 2_000),
      ]);
    } catch (error) {
      evidence.processSessionInspection = {
        error: formatError(error),
      };
    }
  }
  if (client && typeof client.observeIdentity === "function") {
    try {
      evidence.cdpIdentity = await Promise.race([
        client.observeIdentity({ timeoutMs: 2_000 }),
        cleanupTimeout("cdp identity evidence", 2_000),
      ]);
    } catch (error) {
      evidence.cdpIdentity = {
        error: formatError(error),
      };
    }
  }
  return evidence;
}

async function closeResourcesOrThrow({
  machineCapture,
  cancelAudio,
  client,
  sidecar,
  runtime,
  inspectRuntime,
}) {
  const cleanupFailures = [];
  const settleStep = async (label, action) => {
    try {
      await runCloseStep(label, action);
    } catch (error) {
      const evidence = await captureSurvivingRuntimeEvidence({
        runtime,
        client,
        sidecar,
        inspectRuntime,
      });
      error.message = `${error.message}; surviving process/session evidence: ${JSON.stringify(evidence)}`;
      error.survivingEvidence = evidence;
      cleanupFailures.push(error);
    }
  };
  await Promise.all([
    settleStep("machine capture cancel", async () => {
      await machineCapture?.cancel();
    }),
    settleStep("audio capture cancel", async () => {
      await cancelAudio();
    }),
    settleStep("CDP client close", async () => {
      await client?.close();
    }),
    settleStep("CDP sidecar close", async () => {
      await sidecar.close();
    }),
  ]);
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      `live production track cleanup failed: ${cleanupFailures.map((error) => error.message).join("; ")}`,
    );
  }
}

function daemonF1Ready(daemon, binding) {
  const transaction = daemon?.transaction;
  return (
    transaction?.orderNo === binding.orderNo &&
    transaction?.vending?.commandNo === binding.commandNo &&
    transaction?.nextAction === "dispensing" &&
    transaction?.orderStatus !== "fulfilled" &&
    transaction?.vending?.status === "dispensing" &&
    transaction?.vending?.fulfillmentProgressStage === "pickup_completed"
  );
}

function daemonF2Ready(daemon, binding) {
  const transaction = daemon?.transaction;
  return (
    transaction?.orderNo === binding.orderNo &&
    transaction?.vending?.commandNo === binding.commandNo &&
    transaction?.nextAction === "success" &&
    transaction?.orderStatus === "fulfilled" &&
    transaction?.vending?.status === "succeeded"
  );
}

function platformF1Ready(platform, binding) {
  const raw = platform?.raw;
  const order = raw?.orders?.find(
    (entry) => entry?.id === binding.orderId && entry?.orderNo === binding.orderNo,
  );
  const payment = raw?.payments?.find((entry) => entry?.orderId === binding.orderId);
  const command = raw?.commands?.find(
    (entry) =>
      entry?.id === binding.commandId &&
      entry?.orderId === binding.orderId &&
      entry?.commandNo === binding.commandNo,
  );
  const movements = raw?.movements?.filter(
    (entry) => entry?.commandNo === binding.commandNo,
  );
  return (
    order?.status === "paid" &&
    order?.fulfillmentState === "awaiting_fulfillment" &&
    payment?.status === "succeeded" &&
    new Set(["pending", "sent", "acknowledged", "dispensing"]).has(
      command?.status,
    ) &&
    movements?.length === 0
  );
}

export function delayedPickupIssue16ControlPlaneContract() {
  return Object.freeze({
    profile: "delayed-pickup-native-audio",
    producerLifecycle: [
      "before-live-sale",
      "controller-frame:55F1",
      "controller-frame:55F2",
      "after-live-sale",
    ],
    asyncCheckpoint: "controller-frame:55F1",
    releaseAfter: "platform-and-daemon-f1-captured",
  });
}

export async function startDelayedPickupLiveProductionTrack(
  options,
  dependencies = {},
) {
  const root = resolve(options.outputRoot);
  const evidenceDirectory = join(root, "host-default-audio");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const paths = {
    audioStart: join(root, "audio-capture-start.json"),
    audioStop: join(root, "audio-capture-stop.json"),
    machine: join(root, "machine-production-evidence.json"),
    daemon: join(root, "daemon-fulfillment-store-evidence.json"),
    platformF1: join(root, "platform-raw-at-f1.json"),
  };
  const baseBinding = {
    runId: required(options.runId, "runId"),
    lifecycleReference: required(
      options.lifecycleReference,
      "lifecycleReference",
    ),
    transactionId: required(options.transactionId, "transactionId"),
    saleCorrelationId: required(options.saleCorrelationId, "saleCorrelationId"),
  };
  const sidecar = await (dependencies.openSidecar ?? openMachineUiCdpSidecar)({
    endpoint: options.cdpEndpoint,
    remote: options.remote.remote,
    sshPort: options.remote.sshPort,
    identityFile: options.remote.identity,
    certificateFile: options.remote.certificate,
    sshKnownHostsPath: options.remote.sshKnownHostsPath,
    sshHostKeyAlias: options.remote.sshHostKeyAlias,
    sshArgs: ["-o", "ProxyCommand=none"],
    remoteCdpPort: 9222,
  });
  let client;
  let machineCapture;
  let audioStart;
  let audioStopped = false;
  let audioCancelled = false;
  let binding = null;
  let latestMachineBinding = null;
  let f1Promise = null;
  let f2Promise = null;
  let f1Platform = null;
  const daemonCheckpoints = [];
  const captureDaemon = dependencies.captureDaemon ?? options.captureDaemon;
  const queryPlatform = dependencies.queryPlatform ?? options.queryPlatform;
  const startAudioCapture =
    dependencies.startAudioCapture ?? options.startAudioCapture;
  const stopAudioCapture =
    dependencies.stopAudioCapture ?? options.stopAudioCapture;
  const cancelAudioCapture =
    dependencies.cancelAudioCapture ?? options.cancelAudioCapture;
  const inspectRuntimeNow =
    dependencies.inspectRuntime ?? inspectWindowsMachineUiRuntime;
  if (
    typeof captureDaemon !== "function" ||
    typeof queryPlatform !== "function" ||
    typeof startAudioCapture !== "function" ||
    typeof stopAudioCapture !== "function" ||
    typeof cancelAudioCapture !== "function"
  )
    throw new Error(
      "live track daemon/platform producers and audio lifecycle are required",
    );

  async function settleF1Snapshots(observedBinding) {
    const deadline = Date.now() + (options.checkpointTimeoutMs ?? 30_000);
    let lastDaemon = null;
    let lastPlatform = null;
    do {
      [lastDaemon, lastPlatform] = await Promise.all([
        captureDaemon("after_f1_before_f2", observedBinding),
        queryPlatform("at_f1"),
      ]);
      if (
        daemonF1Ready(lastDaemon, observedBinding) &&
        platformF1Ready(lastPlatform, observedBinding)
      ) {
        return { daemon: lastDaemon, platform: lastPlatform };
      }
      await sleep(options.checkpointPollMs ?? 250);
    } while (Date.now() < deadline);
    throw new Error(
      `timed out waiting for F1 nonterminal daemon/platform settlement for ${observedBinding.commandNo}: ${JSON.stringify({ daemon: lastDaemon, platform: lastPlatform })}`,
    );
  }

  async function settleF2Snapshot(observedBinding) {
    const deadline = Date.now() + (options.checkpointTimeoutMs ?? 30_000);
    let lastDaemon = null;
    do {
      lastDaemon = await captureDaemon("after_f2", observedBinding);
      if (daemonF2Ready(lastDaemon, observedBinding)) return lastDaemon;
      await sleep(options.checkpointPollMs ?? 250);
    } while (Date.now() < deadline);
    throw new Error(
      `timed out waiting for F2 terminal daemon settlement for ${observedBinding.commandNo}`,
    );
  }

  async function captureF1(observedBinding) {
    if (f1Promise) return f1Promise;
    if (!observedBinding)
      throw new Error(
        "live Machine F1 control-plane barrier arrived before sale binding was observed",
      );
    binding = observedBinding;
    f1Promise = settleF1Snapshots(binding).then(({ daemon, platform }) => {
      daemonCheckpoints.push(bindCheckpoint(daemon, binding));
      f1Platform = platform;
      writeJson(paths.platformF1, platform);
      return { daemon, platform };
    });
    return f1Promise;
  }

  async function captureF2(observedBinding) {
    if (f2Promise) return f2Promise;
    if (!f1Promise)
      throw new Error(
        "live Machine F2 control-plane barrier arrived before F1 checkpoint completed",
      );
    if (!observedBinding)
      throw new Error(
        "live Machine F2 control-plane barrier arrived before sale binding was observed",
      );
    if (binding && !sameBinding(binding, observedBinding))
      throw new Error("live Machine F2 binding differs from F1 sale binding");
    binding = observedBinding;
    f2Promise = f1Promise
      .then(() => settleF2Snapshot(binding))
      .then((daemon) => {
        daemonCheckpoints.push(bindCheckpoint(daemon, binding));
        return daemon;
      });
    return f2Promise;
  }

  try {
    const target = await (
      dependencies.discoverTarget ?? discoverCanonicalMachineUiTarget
    )({ endpoint: sidecar.endpoint });
    client = dependencies.createClient
      ? dependencies.createClient(target, sidecar)
      : new CdpClient(
          rewriteWebSocketDebuggerUrl(
            target.webSocketDebuggerUrl,
            sidecar.endpoint,
          ),
        );
    await client.connect();
    await (dependencies.enableRuntime ?? enablePageRuntime)(client);
    machineCapture = await startDelayedPickupMachineEvidenceCapture({
      client,
      inspectRuntime: () =>
        inspectRuntimeNow({
          remote: options.remote.remote,
          sshPort: options.remote.sshPort,
          identityFile: options.remote.identity,
          certificateFile: options.remote.certificate,
          sshKnownHostsPath: options.remote.sshKnownHostsPath,
          sshHostKeyAlias: options.remote.sshHostKeyAlias,
          sshArgs: ["-o", "ProxyCommand=none"],
          remoteCdpPort: 9222,
          expectedMachinePath: MACHINE_PATH,
        }),
      intervalMs: options.pollIntervalMs ?? 100,
      readSample: dependencies.readMachineSample,
      async onSample(sample) {
        try {
          latestMachineBinding = observedSaleBinding(baseBinding, sample);
        } catch {
          latestMachineBinding = null;
        }
      },
    });
    const runtime = machineCapture.runtime;
    audioStart = await startAudioCapture({
      baseBinding: { ...baseBinding },
      runtime: { ...runtime },
      targetIdentity: options.targetIdentity,
      evidenceDirectory,
      outPath: paths.audioStart,
    });
    if (
      Date.parse(audioStart?.captureSession?.startedAt ?? "") <
        Date.parse(runtime.observedAt) ||
      !Number.isFinite(Date.parse(audioStart?.captureSession?.startedAt ?? ""))
    )
      throw new Error(
        "host default-audio capture did not start after live runtime observation",
      );
    const baseline = await captureDaemon("before_f0", null);
    daemonCheckpoints.push(baseline);
    await queryPlatform("baseline");

    return {
      runtime,
      paths,
      evidenceDirectory,
      issue16: delayedPickupIssue16ControlPlaneContract(),
      async observeControllerFrame(frame) {
        const bytesHex = normalizeObservedFrameHex(frame);
        if (bytesHex !== "55f1" && bytesHex !== "55f2") return;
        if (!latestMachineBinding)
          throw new Error(
            `${bytesHex.toUpperCase()} control-plane barrier arrived before live Machine sale identity`,
          );
        if (bytesHex === "55f1") await captureF1(latestMachineBinding);
        else await captureF2(latestMachineBinding);
      },
      async finish(finalBinding) {
        if (binding && !sameBinding(binding, finalBinding))
          throw new Error(
            "live Machine F1 binding differs from terminal sale binding",
          );
        binding = finalBinding;
        if (!f1Promise)
          throw new Error("live F1 producer checkpoint was not observed");
        if (!f2Promise)
          throw new Error("live F2 producer checkpoint was not observed");
        await f1Promise;
        await f2Promise;
        const machineEvidence = await machineCapture.stop(binding);
        writeDelayedPickupMachineEvidence(paths.machine, machineEvidence);
        daemonCheckpoints[0] = bindCheckpoint(daemonCheckpoints[0], binding);
        daemonCheckpoints.sort(
          (left, right) =>
            Date.parse(left.capturedAt ?? "") -
            Date.parse(right.capturedAt ?? ""),
        );
        const daemonEvidence = createDaemonFulfillmentStoreEvidence(
          binding,
          daemonCheckpoints,
        );
        writeJson(paths.daemon, daemonEvidence);
        const audioStop = await stopAudioCapture({
          baseBinding: { ...baseBinding },
          binding: { ...binding },
          runtime: { ...runtime },
          targetIdentity: options.targetIdentity,
          evidenceDirectory,
          outPath: paths.audioStop,
          audioStart,
        });
        audioStopped = true;
        return {
          binding,
          runtime,
          machineEvidence,
          daemonEvidence,
          platformF1: f1Platform,
          audioStart,
          audioStop,
          paths,
          evidenceDirectory,
        };
      },
      async close() {
        await closeResourcesOrThrow({
          machineCapture,
          runtime: machineCapture?.runtime ?? runtime,
          client,
          sidecar,
          inspectRuntime: async () =>
            inspectRuntimeNow({
              remote: options.remote.remote,
              sshPort: options.remote.sshPort,
              identityFile: options.remote.identity,
              certificateFile: options.remote.certificate,
              sshKnownHostsPath: options.remote.sshKnownHostsPath,
              sshHostKeyAlias: options.remote.sshHostKeyAlias,
              sshArgs: ["-o", "ProxyCommand=none"],
              remoteCdpPort: 9222,
              expectedMachinePath: MACHINE_PATH,
            }),
          cancelAudio: async () => {
            if (audioStopped || audioCancelled || !audioStart) return;
            await cancelAudioCapture({
              baseBinding: { ...baseBinding },
              runtime: machineCapture?.runtime ? { ...machineCapture.runtime } : null,
              targetIdentity: options.targetIdentity,
              evidenceDirectory,
              outPath: paths.audioStop,
              audioStart,
            });
            audioCancelled = true;
          },
        });
      },
    };
  } catch (error) {
    try {
      await closeResourcesOrThrow({
        machineCapture,
        runtime: machineCapture?.runtime ?? null,
        client,
        sidecar,
        inspectRuntime: async () =>
          inspectRuntimeNow({
            remote: options.remote.remote,
            sshPort: options.remote.sshPort,
            identityFile: options.remote.identity,
            certificateFile: options.remote.certificate,
            sshKnownHostsPath: options.remote.sshKnownHostsPath,
            sshHostKeyAlias: options.remote.sshHostKeyAlias,
            sshArgs: ["-o", "ProxyCommand=none"],
            remoteCdpPort: 9222,
            expectedMachinePath: MACHINE_PATH,
          }),
        cancelAudio: async () => {
          if (audioStopped || audioCancelled || !audioStart) return;
          await cancelAudioCapture({
            baseBinding: { ...baseBinding },
            runtime: machineCapture?.runtime ? { ...machineCapture.runtime } : null,
            targetIdentity: options.targetIdentity,
            evidenceDirectory,
            outPath: paths.audioStop,
            audioStart,
          });
          audioCancelled = true;
        },
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${formatError(error)}; ${formatError(cleanupError)}`,
      );
    }
    throw error;
  }
}
