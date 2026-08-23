import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createDaemonFulfillmentStoreEvidence } from "./delayed-pickup-daemon-evidence.ts";
import {
  readInstalledMachineProductionSample,
  startDelayedPickupMachineEvidenceCapture,
  writeDelayedPickupMachineEvidence,
} from "./delayed-pickup-machine-evidence.ts";
import {
  CdpClient,
  discoverCanonicalMachineUiTarget,
  enablePageRuntime,
  inspectWindowsMachineUiRuntime,
  openMachineUiCdpSidecar,
  rewriteWebSocketDebuggerUrl,
} from "./machine-ui-cdp-driver.ts";

const MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";
const CLOSE_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;
type SaleBinding = Record<string, unknown>;
type MachineRuntime = Record<string, unknown>;

type LiveProductionTrackOptions = {
  outputRoot: string;
  runId: string;
  lifecycleReference: string;
  transactionId: string;
  saleCorrelationId: string;
  targetIdentity?: string;
  cdpEndpoint?: string;
  remote: JsonRecord;
  checkpointTimeoutMs?: number;
  checkpointPollMs?: number;
  pollIntervalMs?: number;
  captureDaemon?: (
    stage: string,
    binding: SaleBinding | null,
  ) => Promise<JsonRecord>;
  queryPlatform?: (stage: string) => Promise<JsonRecord>;
  startAudioCapture?: (options: JsonRecord) => Promise<JsonRecord>;
  stopAudioCapture?: (options: JsonRecord) => Promise<JsonRecord>;
  cancelAudioCapture?: (options: JsonRecord) => Promise<unknown>;
};

type LiveProductionTrackDependencies = {
  openSidecar?: typeof openMachineUiCdpSidecar;
  captureDaemon?: NonNullable<LiveProductionTrackOptions["captureDaemon"]>;
  queryPlatform?: NonNullable<LiveProductionTrackOptions["queryPlatform"]>;
  startAudioCapture?: NonNullable<
    LiveProductionTrackOptions["startAudioCapture"]
  >;
  stopAudioCapture?: NonNullable<
    LiveProductionTrackOptions["stopAudioCapture"]
  >;
  cancelAudioCapture?: NonNullable<
    LiveProductionTrackOptions["cancelAudioCapture"]
  >;
  inspectRuntime?: () => Promise<JsonRecord>;
  discoverTarget?: (options: JsonRecord) => Promise<JsonRecord>;
  createClient?: (target: JsonRecord, sidecar: JsonRecord) => CdpClient;
  enableRuntime?: (client: CdpClient) => Promise<unknown>;
  readMachineSample?: typeof readInstalledMachineProductionSample;
};

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0)
    throw new Error(`${label} is required`);
  return value;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function observedSaleBinding(
  base: SaleBinding,
  sample: JsonRecord | undefined,
): SaleBinding {
  const observed = {
    ...base,
    orderId: sample?.orderId,
    orderNo: sample?.orderNo,
    commandId: sample?.commandId,
    commandNo: sample?.commandNo,
  };
  const observedRecord = observed as JsonRecord;
  for (const name of ["orderId", "orderNo", "commandId", "commandNo"])
    required(observedRecord[name], `observed Machine ${name}`);
  return observed;
}

function sameBinding(
  left: SaleBinding | null | undefined,
  right: SaleBinding | null | undefined,
): boolean {
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

function bindCheckpoint(
  checkpoint: unknown,
  binding: SaleBinding,
): JsonRecord {
  return {
    ...(checkpoint as JsonRecord),
    binding: { ...binding },
  };
}

function normalizeObservedFrameHex(frame: unknown): string | null {
  const record = frame as JsonRecord | undefined;
  const value =
    typeof record?.rawFrameHex === "string"
      ? record.rawFrameHex
      : record?.bytesHex;
  const normalized = String(value ?? "").toLowerCase();
  return /^[0-9a-f]+$/.test(normalized) ? normalized : null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupTimeout(label: string, timeoutMs: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms cleanup deadline`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function runCloseStep(
  label: string,
  action: () => Promise<unknown>,
  timeoutMs = CLOSE_TIMEOUT_MS,
): Promise<unknown> {
  try {
    return await Promise.race([action(), cleanupTimeout(label, timeoutMs)]);
  } catch (error) {
    const wrapped = new Error(`${label} failed: ${formatError(error)}`);
    wrapped.cause = error;
    (wrapped as Error & { cleanupLabel?: string }).cleanupLabel = label;
    throw wrapped;
  }
}

async function captureSurvivingRuntimeEvidence({
  runtime,
  client,
  sidecar,
  inspectRuntime,
}: {
  runtime: MachineRuntime | null;
  client: CdpClient | null;
  sidecar: { endpoint: string };
  inspectRuntime: (() => Promise<unknown>) | null;
}): Promise<JsonRecord> {
  const evidence: JsonRecord = {
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
        client.observeIdentity(),
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
}: {
  machineCapture: Awaited<
    ReturnType<typeof startDelayedPickupMachineEvidenceCapture>
  > | null;
  cancelAudio: () => Promise<unknown>;
  client: CdpClient | null;
  sidecar: { endpoint: string; close: () => Promise<void> };
  runtime: MachineRuntime | null;
  inspectRuntime: (() => Promise<unknown>) | null;
}): Promise<void> {
  const cleanupFailures: Error[] = [];
  const settleStep = async (
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await runCloseStep(label, action);
    } catch (error) {
      const err = error as Error & { survivingEvidence?: unknown };
      const evidence = await captureSurvivingRuntimeEvidence({
        runtime,
        client,
        sidecar,
        inspectRuntime,
      });
      err.message = `${err.message}; surviving process/session evidence: ${JSON.stringify(evidence)}`;
      err.survivingEvidence = evidence;
      cleanupFailures.push(err);
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

function daemonF1Ready(
  daemon: JsonRecord | null | undefined,
  binding: SaleBinding,
): boolean {
  const transaction = (daemon?.transaction ?? {}) as JsonRecord;
  const vending = (transaction?.vending ?? {}) as JsonRecord;
  const pickupReminder = (vending?.pickupReminder ?? {}) as
    | JsonRecord
    | undefined;
  const pickupCompleted =
    vending.fulfillmentProgressStage === "pickup_completed" ||
    pickupReminder?.stage === "pickup_completed";
  return (
    transaction.orderNo === binding.orderNo &&
    vending.commandNo === binding.commandNo &&
    transaction.nextAction === "dispensing" &&
    transaction.orderStatus !== "fulfilled" &&
    vending.status !== "succeeded" &&
    vending.status !== "failed" &&
    pickupCompleted
  );
}

function daemonF2Ready(
  daemon: JsonRecord | null | undefined,
  binding: SaleBinding,
): boolean {
  const transaction = (daemon?.transaction ?? {}) as JsonRecord;
  const vending = (transaction?.vending ?? {}) as JsonRecord;
  return (
    transaction.orderNo === binding.orderNo &&
    vending.commandNo === binding.commandNo &&
    transaction.nextAction === "success" &&
    transaction.orderStatus === "fulfilled" &&
    vending.status === "succeeded"
  );
}

function platformF1Ready(
  platform: JsonRecord | null | undefined,
  binding: SaleBinding,
): boolean {
  const raw = (platform?.raw ?? {}) as JsonRecord;
  const orders = (raw.orders ?? []) as unknown[];
  const payments = (raw.payments ?? []) as unknown[];
  const commands = (raw.commands ?? []) as unknown[];
  const movements = (raw.movements ?? []) as unknown[];
  const order = orders.find(
    (entry) =>
      (entry as JsonRecord)?.id === binding.orderId &&
      (entry as JsonRecord)?.orderNo === binding.orderNo,
  );
  const payment = payments.find(
    (entry) => (entry as JsonRecord)?.orderId === binding.orderId,
  );
  const command = commands.find(
    (entry) =>
      (entry as JsonRecord)?.id === binding.commandId &&
      (entry as JsonRecord)?.orderId === binding.orderId &&
      (entry as JsonRecord)?.commandNo === binding.commandNo,
  );
  const saleMovements = movements.filter(
    (entry) => (entry as JsonRecord)?.commandNo === binding.commandNo,
  );
  return (
    (order as JsonRecord)?.status === "paid" &&
    (order as JsonRecord)?.fulfillmentState === "awaiting_fulfillment" &&
    (payment as JsonRecord)?.status === "succeeded" &&
    new Set(["pending", "sent", "acknowledged", "dispensing"]).has(
      String((command as JsonRecord)?.status),
    ) &&
    saleMovements.length === 0
  );
}

export async function waitForStablePlatformInventoryBaseline(
  queryPlatform: (stage: string) => Promise<JsonRecord | null>,
  {
    timeoutMs = 10_000,
    pollMs = 250,
    sleepFn = sleep,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    sleepFn?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<JsonRecord> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | null = null;
  let stableReads = 0;
  let snapshot: JsonRecord | null = null;
  do {
    snapshot = await queryPlatform("baseline");
    const raw = (snapshot?.raw ?? {}) as JsonRecord;
    const inventories = (raw.inventories ?? []) as unknown[];
    const inventory = JSON.stringify(
      [...inventories].sort((left, right) =>
        String((left as JsonRecord)?.id).localeCompare(
          String((right as JsonRecord)?.id),
        ),
      ),
    );
    stableReads = inventory === previous ? stableReads + 1 : 1;
    previous = inventory;
    if (stableReads >= 3) {
      if (snapshot === null)
        throw new Error("platform inventory baseline snapshot is missing");
      return snapshot;
    }
    await sleepFn(pollMs);
  } while (Date.now() < deadline);
  throw new Error(
    `platform inventory baseline did not stabilize: ${JSON.stringify(
      ((snapshot?.raw ?? {}) as JsonRecord).inventories ?? null,
    )}`,
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
  options: LiveProductionTrackOptions,
  dependencies: LiveProductionTrackDependencies = {},
): Promise<{
  runtime: MachineRuntime;
  paths: Record<string, string>;
  evidenceDirectory: string;
  issue16: Readonly<JsonRecord>;
  observeControllerFrame: (frame: unknown) => Promise<void>;
  finish: (finalBinding: SaleBinding) => Promise<JsonRecord>;
  close: () => Promise<void>;
}> {
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
    remote: String(options.remote.remote ?? ""),
    sshPort: Number(options.remote.sshPort ?? undefined),
    identityFile: String(options.remote.identity ?? ""),
    certificateFile: String(options.remote.certificate ?? ""),
    sshKnownHostsPath: String(options.remote.sshKnownHostsPath ?? ""),
    sshHostKeyAlias: String(options.remote.sshHostKeyAlias ?? ""),
    sshArgs: ["-o", "ProxyCommand=none"],
    remoteCdpPort: 9222,
  });
  let client: CdpClient | null = null;
  let machineCapture: Awaited<
    ReturnType<typeof startDelayedPickupMachineEvidenceCapture>
  > | null = null;
  let audioStart: JsonRecord | null = null;
  let audioStopped = false;
  let audioCancelled = false;
  let binding: SaleBinding | null = null;
  let latestMachineBinding: SaleBinding | null = null;
  let f1Promise: Promise<{ daemon: JsonRecord; platform: JsonRecord }> | null =
    null;
  let f2Promise: Promise<JsonRecord> | null = null;
  let f1Platform: JsonRecord | null = null;
  const daemonCheckpoints: JsonRecord[] = [];
  const captureDaemon = dependencies.captureDaemon ?? options.captureDaemon;
  const queryPlatform = dependencies.queryPlatform ?? options.queryPlatform;
  const startAudioCapture =
    dependencies.startAudioCapture ?? options.startAudioCapture;
  const stopAudioCapture =
    dependencies.stopAudioCapture ?? options.stopAudioCapture;
  const cancelAudioCapture =
    dependencies.cancelAudioCapture ?? options.cancelAudioCapture;
  const inspectRuntimeNow: (options: JsonRecord) => Promise<JsonRecord> = (
    dependencies.inspectRuntime ?? inspectWindowsMachineUiRuntime
  ) as (options: JsonRecord) => Promise<JsonRecord>;
  const inspectRuntime = (): Promise<JsonRecord> =>
    inspectRuntimeNow({
      remote: options.remote.remote as string | undefined,
      sshPort: options.remote.sshPort as number | undefined,
      identityFile: options.remote.identity as string | undefined,
      certificateFile: options.remote.certificate as string | undefined,
      sshKnownHostsPath: options.remote.sshKnownHostsPath as string | undefined,
      sshHostKeyAlias: options.remote.sshHostKeyAlias as string | undefined,
      sshArgs: ["-o", "ProxyCommand=none"],
      remoteCdpPort: 9222,
      expectedMachinePath: MACHINE_PATH,
    });
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
  const verifiedCaptureDaemon = captureDaemon as (
    stage: string,
    binding: SaleBinding | null,
  ) => Promise<JsonRecord>;
  const verifiedQueryPlatform = queryPlatform as (
    stage: string,
  ) => Promise<JsonRecord>;

  async function settleF1Snapshots(
    observedBinding: SaleBinding,
  ): Promise<{ daemon: JsonRecord; platform: JsonRecord }> {
    const deadline = Date.now() + (options.checkpointTimeoutMs ?? 30_000);
    let lastDaemon = null;
    let lastPlatform = null;
    do {
      [lastDaemon, lastPlatform] = await Promise.all([
        verifiedCaptureDaemon("after_f1_before_f2", observedBinding),
        verifiedQueryPlatform("at_f1"),
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

  async function settleF2Snapshot(
    observedBinding: SaleBinding,
  ): Promise<JsonRecord> {
    const deadline = Date.now() + (options.checkpointTimeoutMs ?? 30_000);
    let lastDaemon = null;
    do {
      lastDaemon = await verifiedCaptureDaemon("after_f2", observedBinding);
      if (daemonF2Ready(lastDaemon, observedBinding)) return lastDaemon;
      await sleep(options.checkpointPollMs ?? 250);
    } while (Date.now() < deadline);
    throw new Error(
      `timed out waiting for F2 terminal daemon settlement for ${observedBinding.commandNo}`,
    );
  }

  async function captureF1(
    observedBinding: SaleBinding,
  ): Promise<{ daemon: JsonRecord; platform: JsonRecord }> {
    if (f1Promise) return f1Promise;
    if (!observedBinding)
      throw new Error(
        "live Machine F1 control-plane barrier arrived before sale binding was observed",
      );
    const activeBinding = observedBinding;
    binding = activeBinding;
    f1Promise = settleF1Snapshots(activeBinding).then(
      ({ daemon, platform }) => {
      daemonCheckpoints.push(bindCheckpoint(daemon, activeBinding));
      f1Platform = platform;
      writeJson(paths.platformF1, platform);
      return { daemon, platform };
      },
    );
    return f1Promise;
  }

  async function captureF2(observedBinding: SaleBinding): Promise<JsonRecord> {
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
    const activeBinding = observedBinding;
    binding = activeBinding;
    f2Promise = f1Promise
      .then(() => settleF2Snapshot(activeBinding))
      .then((daemon) => {
        daemonCheckpoints.push(bindCheckpoint(daemon, activeBinding));
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
    await waitForStablePlatformInventoryBaseline(queryPlatform, {
      timeoutMs: options.checkpointTimeoutMs ?? 30_000,
      pollMs: options.checkpointPollMs ?? 250,
    });
    machineCapture = await startDelayedPickupMachineEvidenceCapture({
      client,
      inspectRuntime,
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
    const captureSession = audioStart?.captureSession as
      | JsonRecord
      | undefined;
    if (
      !Number.isFinite(Date.parse(String(captureSession?.startedAt ?? "")))
    )
      throw new Error(
        "host default-audio capture did not report a valid start timestamp",
      );
    const baseline = await captureDaemon("before_f0", null);
    daemonCheckpoints.push(baseline);

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
        if (machineCapture === null)
          throw new Error(
            "machine evidence capture was not started before finish",
          );
        const machineEvidence = await machineCapture.stop(binding);
        writeDelayedPickupMachineEvidence(paths.machine, machineEvidence);
        daemonCheckpoints[0] = bindCheckpoint(daemonCheckpoints[0], binding);
        daemonCheckpoints.sort(
          (left, right) =>
            Date.parse(String(left.capturedAt ?? "")) -
            Date.parse(String(right.capturedAt ?? "")),
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
          inspectRuntime,
          cancelAudio: async () => {
            if (audioStopped || audioCancelled || !audioStart) return;
            await cancelAudioCapture({
              baseBinding: { ...baseBinding },
              runtime: machineCapture?.runtime
                ? { ...machineCapture.runtime }
                : null,
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
        inspectRuntime,
        cancelAudio: async () => {
          if (audioStopped || audioCancelled || !audioStart) return;
          await cancelAudioCapture({
            baseBinding: { ...baseBinding },
            runtime: machineCapture?.runtime
              ? { ...machineCapture.runtime }
              : null,
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
