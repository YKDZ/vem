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
import { runSaleAudioCaptureHostAdapterCli } from "./sale-audio-capture-host-adapter.mjs";

const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";

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
  let binding = null;
  let latestMachineBinding = null;
  let f1Promise = null;
  let f2Promise = null;
  let f1Platform = null;
  const daemonCheckpoints = [];
  const captureDaemon = dependencies.captureDaemon ?? options.captureDaemon;
  const queryPlatform = dependencies.queryPlatform ?? options.queryPlatform;
  if (
    typeof captureDaemon !== "function" ||
    typeof queryPlatform !== "function"
  )
    throw new Error("live track daemon and platform producers are required");

  async function captureF1(observedBinding) {
    if (f1Promise) return f1Promise;
    binding = observedBinding;
    f1Promise = Promise.all([
      captureDaemon("after_f1_before_f2", binding),
      queryPlatform("at_f1"),
    ]).then(([daemon, platform]) => {
      daemonCheckpoints.push(bindCheckpoint(daemon, binding));
      f1Platform = platform;
      writeJson(paths.platformF1, platform);
      return { daemon, platform };
    });
    return f1Promise;
  }

  async function captureF2(observedBinding) {
    if (f2Promise) return f2Promise;
    if (binding && !sameBinding(binding, observedBinding))
      throw new Error("live Machine F2 binding differs from F1 sale binding");
    binding = observedBinding;
    f2Promise = captureDaemon("after_f2", binding).then((daemon) => {
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
        (dependencies.inspectRuntime ?? inspectWindowsMachineUiRuntime)({
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
        const reachedF1 = sample.runtimeTrace.some(
          (entry) =>
            entry?.type === "journey_transition" &&
            entry.transitionId ===
              `transaction:${sample.orderNo}:pickup-completed`,
        );
        if (reachedF1 && !f1Promise) await captureF1(latestMachineBinding);
        const reachedF2 = sample.runtimeTrace.some(
          (entry) =>
            entry?.type === "journey_transition" &&
            entry.transitionId ===
              `transaction:${sample.orderNo}:dispense-succeeded`,
        );
        if (reachedF2 && !f2Promise) await captureF2(latestMachineBinding);
      },
    });
    const runtime = machineCapture.runtime;
    const runAudio = dependencies.runAudio ?? runSaleAudioCaptureHostAdapterCli;
    audioStart = await runAudio([
      "--operation",
      "capture-sale-audio",
      "--capture-phase",
      "start",
      "--run-id",
      baseBinding.runId,
      "--lifecycle-reference",
      baseBinding.lifecycleReference,
      "--target-identity",
      options.targetIdentity,
      "--transaction-id",
      baseBinding.transactionId,
      ...audioRuntimeArgs(runtime),
      "--evidence-dir",
      evidenceDirectory,
      "--out",
      paths.audioStart,
    ]);
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
        const bytesHex = String(frame?.bytesHex).toLowerCase();
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
        const runAudio =
          dependencies.runAudio ?? runSaleAudioCaptureHostAdapterCli;
        const audioStop = await runAudio([
          "--operation",
          "capture-sale-audio",
          "--capture-phase",
          "stop",
          "--run-id",
          baseBinding.runId,
          "--lifecycle-reference",
          baseBinding.lifecycleReference,
          "--target-identity",
          options.targetIdentity,
          "--transaction-id",
          baseBinding.transactionId,
          ...audioRuntimeArgs(runtime),
          "--capture-session-id",
          audioStart.captureSession.captureSessionId,
          "--start-operation-reference",
          audioStart.captureSession.startOperationReference,
          "--capture-started-at",
          audioStart.captureSession.startedAt,
          "--sale-correlation-id",
          binding.saleCorrelationId,
          "--order-id",
          binding.orderId,
          "--order-no",
          binding.orderNo,
          "--command-id",
          binding.commandId,
          "--command-no",
          binding.commandNo,
          "--evidence-dir",
          evidenceDirectory,
          "--out",
          paths.audioStop,
        ]);
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
        await Promise.allSettled([client?.close(), sidecar.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([client?.close(), sidecar.close()]);
    throw error;
  }
}
