import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  delayedPickupIssue16ControlPlaneContract,
  startDelayedPickupLiveProductionTrack,
} from "./delayed-pickup-live-production-track.mjs";
import {
  combineCleanupError,
  runCleanupStep,
} from "./delayed-pickup-native-audio-guest-full.mjs";
import { buildVmRuntimeAcceptancePlan } from "./win10-vem-e2e.mjs";

const sale = {
  runId: "RUN-17-LIVE",
  lifecycleReference: "vm-lifecycle://run-17-live.runtime",
  transactionId: "transaction://run-17-live.delayed-pickup",
  saleCorrelationId: "sale-correlation://run-17-live.sale",
  orderId: "11111111-1111-4111-8111-111111111111",
  orderNo: "ORDER-17-LIVE",
  commandId: "22222222-2222-4222-8222-222222222222",
  commandNo: "COMMAND-17-LIVE",
};

function makeTempDir(prefix) {
  const path = join(
    process.cwd(),
    "test-artifacts",
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

describe("delayed pickup live production track", () => {
  it("releases the scanner binding probe before payment-code injection", () => {
    const source = readFileSync(
      new URL("./delayed-pickup-native-audio-guest-full.mjs", import.meta.url),
      "utf8",
    );
    const prepare = source.indexOf("await prepareScannerForSale(");
    const inject = source.indexOf("/inject`,", prepare);
    assert.ok(prepare >= 0);
    assert.ok(inject > prepare);
    assert.match(source, /stop-scanner-probe/);
    assert.match(source, /await waitForPaymentCodeArm\(handoff, paymentSurface\)/);
    assert.match(source, /attempt < 3 && !paymentRouteReached/);
    assert.match(source, /\/v1\/sale-start-capability/);
    assert.match(source, /scannerCodeBase64: Buffer\.from\(/);
    assert.match(source, /DEFAULT_SCANNER_CODE = "621234567890123456"/);
    assert.match(source, /\\r\\n/);
    const paymentSurface = source.indexOf(
      "const paymentSurface = await readRenderedPaymentSurface(client)",
    );
    const paymentInject = source.indexOf("/inject`,", paymentSurface);
    const waitForCommand = source.indexOf(
      "liveSale = await waitForCommand(handoff, paymentSurface)",
      paymentSurface,
    );
    assert.ok(paymentSurface >= 0);
    assert.ok(paymentInject > paymentSurface);
    assert.ok(waitForCommand > paymentInject);
  });

  it("owns producers around the live sale and awaits the real F1/F2 control-plane checkpoints", async () => {
    const root = makeTempDir("vem-delayed-live");
    const operations = [];
    let sampleSequence = 0;
    const client = {
      async connect() {
        operations.push("cdp-connect");
      },
      async observeIdentity() {
        return {
          targetId: "target-live-17",
          sessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
          connectedAt: "2026-07-18T08:00:00.000Z",
        };
      },
      async close() {
        operations.push("cdp-close");
      },
    };
    try {
      const track = await startDelayedPickupLiveProductionTrack(
        {
          outputRoot: root,
          ...sale,
          targetIdentity: "vm-target://runtime-testbed",
          remote: {
            remote: "operator@runtime.test",
            identity: "/tmp/id",
            certificate: "/tmp/id-cert.pub",
          },
          pollIntervalMs: 25,
          async captureDaemon(stage) {
            operations.push(`daemon:${stage}`);
            return {
              stage,
              capturedAt:
                stage === "before_f0"
                  ? "2026-07-18T08:00:00.100Z"
                  : stage === "after_f1_before_f2"
                    ? "2026-07-18T08:00:30.200Z"
                    : "2026-07-18T08:00:31.200Z",
              binding: null,
              transaction:
                stage === "after_f1_before_f2"
                  ? {
                      orderNo: sale.orderNo,
                      orderStatus: "dispensing",
                      nextAction: "dispensing",
                      vending: {
                        commandNo: sale.commandNo,
                        status: "dispensing",
                        fulfillmentProgressStage: "pickup_completed",
                      },
                    }
                  : stage === "after_f2"
                    ? {
                        orderNo: sale.orderNo,
                        orderStatus: "fulfilled",
                        nextAction: "success",
                        vending: {
                          commandNo: sale.commandNo,
                          status: "succeeded",
                        },
                      }
                    : {},
              saleView: { items: [] },
            };
          },
          async queryPlatform(stage) {
            operations.push(`platform:${stage}`);
            return {
              schemaVersion: "installed-kiosk-sale-platform-raw-records/v3",
              source: "authoritative_ephemeral_platform_database",
              capturedAt:
                stage === "baseline"
                  ? "2026-07-18T08:00:00.200Z"
                  : "2026-07-18T08:00:30.300Z",
              scope: {
                runId: sale.runId,
                machineCode: "MACHINE-17",
                machineId: "44444444-4444-4444-8444-444444444444",
              },
              raw: {
                orders:
                  stage === "at_f1"
                    ? [{ id: sale.orderId, orderNo: sale.orderNo, status: "dispensing" }]
                    : [],
                orderItems: [],
                payments:
                  stage === "at_f1"
                    ? [{ id: "payment-17", orderId: sale.orderId, status: "succeeded" }]
                    : [],
                reservations: [],
                commands:
                  stage === "at_f1"
                    ? [
                        {
                          id: sale.commandId,
                          orderId: sale.orderId,
                          commandNo: sale.commandNo,
                          status: "dispensing",
                        },
                      ]
                    : [],
                movements: [],
              },
            };
          },
        },
        {
          async openSidecar() {
            return {
              endpoint: "http://127.0.0.1:9222",
              async close() {
                operations.push("sidecar-close");
              },
            };
          },
          async discoverTarget() {
            return {
              id: "target-live-17",
              webSocketDebuggerUrl:
                "ws://127.0.0.1:9222/devtools/page/target-live-17",
            };
          },
          createClient() {
            return client;
          },
          async enableRuntime() {},
          async inspectRuntime() {
            return {
              machine: {
                processId: 42,
                executablePath: "C:\\VEM\\bringup\\machine.exe",
                sessionId: 7,
                principal: "FIELD\\InteractiveUser",
              },
              cdpListener: {
                machineAncestorProcessId: 42,
                sessionId: 7,
                principal: "FIELD\\InteractiveUser",
              },
            };
          },
          async readMachineSample() {
            sampleSequence += 1;
            return {
              observedAt:
                sampleSequence >= 2
                  ? "2026-07-18T08:00:30.100Z"
                  : "2026-07-18T08:00:00.300Z",
              route: "#/dispensing",
              surface:
                sampleSequence >= 2 ? "reset_progress" : "ordinary_warning",
              orderId: sale.orderId,
              orderNo: sale.orderNo,
              commandId: sale.commandId,
              commandNo: sale.commandNo,
              runtimeTrace:
                sampleSequence >= 2
                  ? [
                      {
                        type: "journey_transition",
                        transitionId: `transaction:${sale.orderNo}:pickup-completed`,
                      },
                    ]
                  : [],
            };
          },
          async startAudioCapture() {
            operations.push("audio:start");
            return {
              captureSession: {
                captureSessionId: "sale-audio-session:run-17-live",
                startOperationReference: "vm-operation:run-17-live",
                startedAt: "2026-07-18T08:00:00.000Z",
              },
            };
          },
          async stopAudioCapture() {
            operations.push("audio:stop");
            return { result: "succeeded" };
          },
          async cancelAudioCapture() {
            operations.push("audio:cancel");
            return { cancelled: true };
          },
        },
      );
      assert.deepEqual(operations.slice(-3), [
        "audio:start",
        "daemon:before_f0",
        "platform:baseline",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 90));
      await track.observeControllerFrame({ rawFrameHex: "55F1" });
      await track.observeControllerFrame({ rawFrameHex: "55AF" });
      await track.observeControllerFrame({ rawFrameHex: "55F2" });
      const evidence = await track.finish(sale);
      assert.ok(operations.indexOf("platform:at_f1") > 0);
      assert.ok(
        operations.indexOf("platform:at_f1") < operations.indexOf("audio:stop"),
      );
      assert.ok(
        operations.indexOf("daemon:after_f1_before_f2") <
          operations.indexOf("daemon:after_f2"),
      );
      assert.ok(
        operations.indexOf("daemon:after_f2") < operations.indexOf("audio:stop"),
      );
      assert.equal(evidence.runtime.principal, "FIELD\\InteractiveUser");
      assert.equal(evidence.binding.commandId, sale.commandId);
      await track.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declares the Issue16 frame barrier used by the full-mode tracer", () => {
    const contract = delayedPickupIssue16ControlPlaneContract();
    assert.equal(contract.asyncCheckpoint, "controller-frame:55F1");
    assert.equal(contract.releaseAfter, "platform-and-daemon-f1-captured");
  });

  it("fails closed when F2 arrives before the live F1 release gate", async () => {
    const root = makeTempDir("vem-delayed-live-gate");
    let failedSampleCount = 0;
    try {
      const track = await startDelayedPickupLiveProductionTrack(
        {
          outputRoot: root,
          ...sale,
          targetIdentity: "vm-target://runtime-testbed",
          remote: {
            remote: "operator@runtime.test",
            identity: "/tmp/id",
            certificate: "/tmp/id-cert.pub",
          },
          async captureDaemon(stage) {
            return {
              stage,
              capturedAt: "2026-07-18T08:00:30.200Z",
              binding: null,
              transaction: {},
              saleView: { items: [] },
            };
          },
          async queryPlatform() {
            return {
              schemaVersion: "installed-kiosk-sale-platform-raw-records/v3",
              source: "authoritative_ephemeral_platform_database",
              capturedAt: "2026-07-18T08:00:30.300Z",
              scope: {
                runId: sale.runId,
                machineCode: "MACHINE-17",
                machineId: "44444444-4444-4444-8444-444444444444",
              },
              raw: {
                orders: [],
                orderItems: [],
                payments: [],
                reservations: [],
                commands: [],
                movements: [],
                inventories: [],
              },
            };
          },
        },
        {
          async openSidecar() {
            return {
              endpoint: "http://127.0.0.1:9222",
              async close() {},
            };
          },
          async discoverTarget() {
            return {
              id: "target-live-17",
              webSocketDebuggerUrl:
                "ws://127.0.0.1:9222/devtools/page/target-live-17",
            };
          },
          createClient() {
            return {
              async connect() {},
              async observeIdentity() {
                return {
                  targetId: "target-live-17",
                  sessionId:
                    "cdp-connection:33333333-3333-4333-8333-333333333333",
                  connectedAt: "2026-07-18T08:00:00.000Z",
                };
              },
              async close() {},
            };
          },
          async enableRuntime() {},
          async inspectRuntime() {
            return {
              machine: {
                processId: 42,
                executablePath: "C:\\VEM\\bringup\\machine.exe",
                sessionId: 7,
                principal: "FIELD\\InteractiveUser",
              },
              cdpListener: {
                machineAncestorProcessId: 42,
                sessionId: 7,
                principal: "FIELD\\InteractiveUser",
              },
            };
          },
          async readMachineSample() {
            failedSampleCount += 1;
            return {
              observedAt: "2026-07-18T08:00:30.100Z",
              route: "#/dispensing",
              surface: "reset_progress",
              orderId: sale.orderId,
              orderNo: sale.orderNo,
              commandId: sale.commandId,
              commandNo: sale.commandNo,
              runtimeTrace: [],
            };
          },
          async startAudioCapture() {
            return {
              captureSession: {
                captureSessionId: "sale-audio-session:run-17-live",
                startOperationReference: "vm-operation:run-17-live",
                startedAt: "2026-07-18T08:00:00.000Z",
              },
            };
          },
          async stopAudioCapture() {
            return { result: "succeeded" };
          },
          async cancelAudioCapture() {
            return { cancelled: true };
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await assert.rejects(
        track.observeControllerFrame({ rawFrameHex: "55F2" }),
        /F2 control-plane barrier arrived before F1 checkpoint completed/,
      );
      await track.close();
      const samplesAtClose = failedSampleCount;
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.equal(failedSampleCount, samplesAtClose);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for guest cleanup errors and preserves the primary error first", async () => {
    const primary = new Error("primary live sale failure");
    let cleanup = null;
    try {
      await runCleanupStep("live-track-close", async () => {
        throw new Error("sidecar tunnel still open");
      });
    } catch (error) {
      cleanup = error;
    }
    assert.ok(cleanup instanceof Error);
    const combined = combineCleanupError(primary, [cleanup]);
    assert.equal(combined instanceof AggregateError, true);
    assert.equal(combined.errors[0], primary);
    assert.match(combined.message, /primary live sale failure/);
    assert.match(combined.message, /live-track-close failed: sidecar tunnel still open/);
  });

  it("fails closed when live track close rejects and includes surviving process/session evidence", async () => {
    const root = makeTempDir("vem-delayed-live-close");
    try {
      const track = await startDelayedPickupLiveProductionTrack(
        {
          outputRoot: root,
          ...sale,
          targetIdentity: "vm-target://runtime-testbed",
          remote: {
            remote: "operator@runtime.test",
            identity: "/tmp/id",
            certificate: "/tmp/id-cert.pub",
          },
          async captureDaemon(stage) {
            return {
              stage,
              capturedAt: "2026-07-18T08:00:00.100Z",
              binding: null,
              transaction: {},
              saleView: { items: [] },
            };
          },
          async queryPlatform() {
            return {
              schemaVersion: "installed-kiosk-sale-platform-raw-records/v3",
              source: "authoritative_ephemeral_platform_database",
              capturedAt: "2026-07-18T08:00:00.200Z",
              scope: {
                runId: sale.runId,
                machineCode: "MACHINE-17",
                machineId: "44444444-4444-4444-8444-444444444444",
              },
              raw: {
                orders: [],
                orderItems: [],
                payments: [],
                reservations: [],
                commands: [],
                movements: [],
              },
            };
          },
        },
        {
          async openSidecar() {
            return {
              endpoint: "http://127.0.0.1:9222",
              async close() {
                throw new Error("ssh tunnel still forwarding");
              },
            };
          },
          async discoverTarget() {
            return {
              id: "target-live-17",
              webSocketDebuggerUrl:
                "ws://127.0.0.1:9222/devtools/page/target-live-17",
            };
          },
          createClient() {
            return {
              async connect() {},
              async observeIdentity() {
                return {
                  targetId: "target-live-17",
                  sessionId:
                    "cdp-connection:33333333-3333-4333-8333-333333333333",
                  connectedAt: "2026-07-18T08:00:00.000Z",
                };
              },
              async close() {
                throw new Error("cdp websocket close stalled");
              },
            };
          },
          async enableRuntime() {},
          async inspectRuntime() {
            return {
              machine: {
                processId: 42,
                executablePath: "C:\\VEM\\bringup\\machine.exe",
                sessionId: 7,
                principal: "FIELD\\InteractiveUser",
              },
              cdpListener: {
                machineAncestorProcessId: 42,
                sessionId: 7,
                principal: "FIELD\\InteractiveUser",
              },
            };
          },
          async readMachineSample() {
            return {
              observedAt: "2026-07-18T08:00:00.300Z",
              route: "#/catalog",
              surface: "catalog",
              runtimeTrace: [],
            };
          },
          async startAudioCapture() {
            return {
              captureSession: {
                captureSessionId: "sale-audio-session:run-17-live",
                startOperationReference: "vm-operation:run-17-live",
                startedAt: "2026-07-18T08:00:00.400Z",
              },
            };
          },
          async stopAudioCapture() {
            return { result: "succeeded" };
          },
          async cancelAudioCapture() {
            return { cancelled: true };
          },
        },
      );
      await assert.rejects(
        track.close(),
        (error) => {
          assert.equal(error instanceof AggregateError, true);
          assert.match(error.message, /live production track cleanup failed/);
          assert.match(error.message, /CDP client close failed/);
          assert.match(error.message, /CDP sidecar close failed/);
          assert.match(error.message, /surviving process\/session evidence/);
          assert.match(error.message, /\"processId\":42/);
          assert.match(error.message, /\"sessionId\":7/);
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is invoked by the current full VM runtime acceptance plan", () => {
    const previous = process.env.VEM_EPHEMERAL_DATABASE_URL;
    process.env.VEM_EPHEMERAL_DATABASE_URL =
      "postgresql://vem:test@127.0.0.1:55432/vem_issue17";
    try {
      const plan = buildVmRuntimeAcceptancePlan({
        runId: "RUN-17-FULL",
        platformTarget: "ephemeral-run-17-full",
        ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
        ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
        daemonArtifactSha256: "a".repeat(64),
        machineUiArtifactSha256: "b".repeat(64),
      });
      const step = plan.steps.find(
        (candidate) =>
          candidate.name === "delayed pickup native audio live sale",
      );
      assert.equal(step.mode, "installed-kiosk-sale");
      assert.equal(
        step.command[step.command.indexOf("--profile") + 1],
        "vm-delayed-pickup-native-audio",
      );
      assert.equal(
        step.issue16ControlPlaneProfile,
        "delayed-pickup-native-audio",
      );
    } finally {
      if (previous === undefined) delete process.env.VEM_EPHEMERAL_DATABASE_URL;
      else process.env.VEM_EPHEMERAL_DATABASE_URL = previous;
    }
  });
});
