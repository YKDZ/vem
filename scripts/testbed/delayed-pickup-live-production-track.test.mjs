import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  delayedPickupIssue16ControlPlaneContract,
  startDelayedPickupLiveProductionTrack,
} from "./delayed-pickup-live-production-track.mjs";
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

describe("delayed pickup live production track", () => {
  it("owns producers around the live sale and awaits the F1 control-plane checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-delayed-live-"));
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
              transaction: {},
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
            const reachedF1 = sampleSequence >= 2;
            const reachedF2 = sampleSequence >= 3;
            return {
              observedAt: reachedF1
                ? "2026-07-18T08:00:30.100Z"
                : "2026-07-18T08:00:00.300Z",
              route: "#/dispensing",
              surface: reachedF1 ? "reset_progress" : "ordinary_warning",
              orderId: sale.orderId,
              orderNo: sale.orderNo,
              commandId: sale.commandId,
              commandNo: sale.commandNo,
              runtimeTrace: reachedF1
                ? [
                    {
                      type: "journey_transition",
                      transitionId: `transaction:${sale.orderNo}:pickup-completed`,
                    },
                    ...(reachedF2
                      ? [
                          {
                            type: "journey_transition",
                            transitionId: `transaction:${sale.orderNo}:dispense-succeeded`,
                          },
                        ]
                      : []),
                  ]
                : [],
            };
          },
          async runAudio(argv) {
            const phase = argv[argv.indexOf("--capture-phase") + 1];
            operations.push(`audio:${phase}`);
            return phase === "start"
              ? {
                  captureSession: {
                    captureSessionId: "sale-audio-session:run-17-live",
                    startOperationReference: "vm-operation:run-17-live",
                    startedAt: "2026-07-18T08:00:00.000Z",
                  },
                }
              : { result: "succeeded" };
          },
        },
      );
      assert.deepEqual(operations.slice(-3), [
        "audio:start",
        "daemon:before_f0",
        "platform:baseline",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 90));
      const evidence = await track.finish(sale);
      assert.ok(operations.indexOf("platform:at_f1") > 0);
      assert.ok(
        operations.indexOf("platform:at_f1") < operations.indexOf("audio:stop"),
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
