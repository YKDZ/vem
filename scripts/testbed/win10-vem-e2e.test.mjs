import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runInstalledKioskSaleAcceptanceCli } from "./installed-kiosk-sale-acceptance.mjs";
import {
  deriveSerialConformanceReportDigest,
  readFailureMatrixCommands,
  runFailedDispenseCommand,
  validateSerialConformanceReport,
} from "./vm-host-adapter-serial-conformance.mjs";
import {
  buildBringUpPlan,
  buildFactoryPreclaimVerificationScript,
  buildRemotePowerShellCommand,
  buildResetPlan,
  buildRemotePowerShellScript,
  buildSshCommand,
  assertResetPlanPreservesTestbed,
  buildPreClaimPublicConfig,
  buildProvisioningFacts,
  buildReadyFileEvidence,
  buildInteractiveDesktopDisplayBaseline,
  assertSimulatedSaleFlowPreMutationTarget,
  readEphemeralPlatformSetupEvidence,
  parseStructuredSshVerifierEvidence,
  runTransientSshOperation,
  buildKioskRuntimeEvidence,
  buildPortraitKioskAcceptance,
  buildRuntimeAcceptanceReport,
  buildVmRuntimeAcceptanceReport,
  buildVmRuntimeAcceptancePlan,
  buildInstalledKioskSaleLaunchScript,
  buildInstalledKioskSaleCleanupScript,
  buildCleanBaseFactoryAcceptancePlan,
  buildFactoryImageDeliveryUnitReport,
  assertTrustedProtectedFactoryPersonalizationGate,
  buildCleanBaseRemoteIdentityProbeCommand,
  buildCleanBaseRemotePreflightAbsenceProbeCommand,
  cleanupFactoryAcceptanceStaging,
  createFactoryAcceptanceCancellationController,
  installFactoryAcceptanceSignalHandlers,
  validateCleanBaseFactoryAcceptanceEvidence,
  writeVmRuntimeAcceptanceEvidenceIndexes,
  buildScpCommand,
  classifyProvisioningFailure,
  evaluateFirstClaimPrecondition,
  evaluateSimulatedHardwareSerialEvidence,
  findActiveKioskSession,
  getRuntimeAcceptanceExitStatus,
  isStrictTauriHashRouteUrl,
  sanitizeFactoryPreclaimReport,
} from "./win10-vem-e2e.mjs";

const FAKE_VM_HOST_ADAPTER = new URL(
  "./fake-vm-host-adapter.mjs",
  import.meta.url,
).pathname;
const SERIAL_CONFORMANCE = new URL(
  "./vm-host-adapter-serial-conformance.mjs",
  import.meta.url,
).pathname;

let capturedSerialConformance;
let capturedSerialRunnerPrivateKey;

function resignSerialConformance(conformance) {
  const reportDigest = deriveSerialConformanceReportDigest(conformance);
  conformance.runnerEvidence.conformance = {
    reportDigest,
    signature: `ed25519-signature:base64:${sign(
      null,
      Buffer.from(reportDigest),
      capturedSerialRunnerPrivateKey,
    ).toString("base64")}`,
  };
}

function completedSerialSaleEvidence(overrides = {}) {
  if (!capturedSerialConformance) {
    const root = mkdtempSync(join(tmpdir(), "vem-serial-evidence-consumer-"));
    const scannerCodePath = join(root, "protected-scanner-code.txt");
    const runnerSigningKeyFile = join(root, "runner-signing-key.pem");
    const outputPath = join(root, "conformance.json");
    try {
      const runnerKey = generateKeyPairSync("ed25519");
      capturedSerialRunnerPrivateKey = runnerKey.privateKey;
      const expectedRunnerPublicKey = `ed25519-public-key:base64:${runnerKey.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64")}`;
      writeFileSync(scannerCodePath, "test-scanner-secret", { mode: 0o600 });
      writeFileSync(
        runnerSigningKeyFile,
        runnerKey.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      );
      execFileSync(
        process.execPath,
        [
          SERIAL_CONFORMANCE,
          "--adapter",
          FAKE_VM_HOST_ADAPTER,
          "--out",
          outputPath,
          "--scanner-code-file",
          scannerCodePath,
          "--runner-signing-key-file",
          runnerSigningKeyFile,
          "--expected-runner-public-key",
          expectedRunnerPublicKey,
          "--run-id",
          "RUN-180-EVIDENCE",
          "--target-identity",
          "vm-target://runtime-testbed",
          "--approved-runtime-base",
          `factory-cas://sha256/${"a".repeat(64)}`,
          "--lifecycle-reference",
          "vm-lifecycle://run-180-evidence.runtime-testbed",
          "--sale-correlation-id",
          "sale-correlation://sale-180",
          "--order-id",
          "ORDER-180",
          "--payment-id",
          "PAYMENT-180",
          "--vending-command-id",
          "VEND-180",
        ],
        {
          env: {
            ...process.env,
            RUNNER_TEMP: root,
            VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY: "1",
            VEM_VM_HOST_ADAPTER_STATE_FILE: join(root, "adapter-state.json"),
            VEM_VM_HOST_FAKE_LOWER_CONTROLLER_GUEST_IDENTITY:
              "windows-com://com31",
            VEM_VM_HOST_FAKE_SCANNER_GUEST_IDENTITY: "windows-com://com32",
          },
        },
      );
      capturedSerialConformance = JSON.parse(readFileSync(outputPath, "utf8"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const sale = {
    orderId: "ORDER-180",
    paymentId: "PAYMENT-180",
    vendingCommandId: "VEND-180",
  };
  return {
    saleFlow: {
      simulatedHardwareSaleFlow: {
        phase: "complete",
        hostSerialEvidencePending: true,
        sale,
        daemonSerialConfiguration: {
          hardwareAdapter: "serial",
          scannerAdapter: "serial_text",
          lowerControllerPort: "COM31",
          scannerPort: "COM32",
          lowerControllerPortObserved: true,
          scannerPortObserved: true,
        },
      },
    },
    serialConformance: structuredClone(capturedSerialConformance),
    expectedRunnerPublicKey: capturedSerialConformance.runnerEvidence.publicKey,
    expectedAdapterIdentity:
      capturedSerialConformance.reports.start.adapter.identity,
    ...overrides,
  };
}

function extractPowerShellFunction(script, name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `generated script is missing ${name}`);

  const openingBrace = script.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < script.length; index += 1) {
    if (script[index] === "{") {
      depth += 1;
    } else if (script[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return script.slice(start, index + 1);
      }
    }
  }
  throw new Error(`generated PowerShell function ${name} is not closed`);
}

function runPowerShellSemanticHarness(functionSource, harness) {
  const directory = mkdtempSync(join(tmpdir(), "vem-daemon-ipc-harness-"));
  const scriptPath = join(directory, "harness.ps1");
  try {
    writeFileSync(
      scriptPath,
      `$ErrorActionPreference = "Stop"\n${functionSource}\n${harness}`,
    );
    const result = spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", scriptPath],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `PowerShell semantic harness failed:\n${result.stdout}\n${result.stderr}`,
    );
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function projectFactoryRuntimeBoundary(profile) {
  const directory = mkdtempSync(join(tmpdir(), "vem-factory-boundary-"));
  const projectionPath = join(directory, `${profile}-projection.json`);
  const daemonSha256 = "a".repeat(64);
  const machineUiSha256 = "b".repeat(64);
  const artifactSha256 = "c".repeat(64);
  const signerThumbprint = "d".repeat(40);
  const rootThumbprint = "e".repeat(40);
  const isProduction = profile === "production";
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "scripts/windows/prepare-factory-runtime.ps1",
      "-ProjectionOnly",
      "-DaemonArtifactPath",
      "C:\\input\\vending-daemon.exe",
      "-DaemonSha256",
      daemonSha256,
      "-MachineUiArtifactPath",
      "C:\\input\\machine.exe",
      "-MachineUiSha256",
      machineUiSha256,
      "-EnvironmentName",
      `vps-fresh-${profile}-clean-base`,
      "-DeploymentBatch",
      `clean-base-${profile}-v1`,
      "-ProvisioningEndpoint",
      "https://factory.example.com/api",
      "-MqttUrl",
      "mqtt://factory.example.com:1883",
      "-HardwareMode",
      isProduction ? "production" : "simulated",
      "-HardwareModel",
      isProduction ? "VEM-PROD-24" : "VEM-TESTBED-24",
      "-TopologyIdentity",
      `vem-${profile}-24`,
      "-TopologyVersion",
      "2026-07-14",
      "-ExpectedDisplayWidth",
      "1080",
      "-ExpectedDisplayHeight",
      "1920",
      "-ExpectedDisplayOrientation",
      "portrait",
      "-ExpectedKioskUser",
      "VemKiosk",
      "-ExpectedMaintenanceUser",
      isProduction ? "Admin" : "YKDZ",
      "-ExpectedAutoLogonUser",
      "VemKiosk",
      "-ExpectedKioskShell",
      "C:\\VEM\\bringup\\machine.exe",
      "-TargetLayoutVersion",
      "1",
      "-FactoryProfile",
      profile,
      "-OpenSshPackagePath",
      "C:\\input\\openssh.msi",
      "-OpenSshPackageSource",
      "local-pinned",
      "-OpenSshPackageVersion",
      "1.0.0",
      "-OpenSshPackageSha256",
      artifactSha256,
      "-OpenSshApprovedSignerThumbprint",
      signerThumbprint,
      "-OpenSshApprovedRootThumbprint",
      rootThumbprint,
      "-WireGuardPackagePath",
      "C:\\input\\wireguard.msi",
      "-WireGuardPackageSource",
      "local-pinned",
      "-WireGuardPackageVersion",
      "1.0.0",
      "-WireGuardPackageSha256",
      artifactSha256,
      "-WireGuardApprovedSignerThumbprint",
      signerThumbprint,
      "-WireGuardApprovedRootThumbprint",
      rootThumbprint,
      "-MaintenanceSshCaPublicKeyPath",
      "C:\\input\\maintenance-ca.pub",
      "-MaintenanceSshCaPublicKeySha256",
      artifactSha256,
      "-MaintenanceRunnerSourceAllowlist",
      "10.0.0.0/8",
      "-MaintenanceMaintainerSourceAllowlist",
      "10.0.0.0/8",
      "-MaintenanceWireGuardListenAddress",
      "10.66.0.1",
      ...(isProduction
        ? [
            "-FactoryMediaRoot",
            "C:\\Factory Media\\VEM",
            "-VisionConfigurationSourcePath",
            "C:\\Factory Media\\VEM\\vision-site-config.json",
          ]
        : []),
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `prepare projection failed:\n${result.stdout}\n${result.stderr}`,
  );
  const projection = JSON.parse(result.stdout);
  writeFileSync(projectionPath, JSON.stringify(projection));

  const verifier = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "scripts/windows/verify-factory-runtime.ps1",
      "-ProjectionPath",
      projectionPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    verifier.status,
    0,
    `projection verifier failed:\n${verifier.stdout}\n${verifier.stderr}`,
  );
  assert.equal(JSON.parse(verifier.stdout).ok, true);

  const rust = spawnSync(
    "cargo",
    [
      "test",
      "-p",
      "vending-daemon",
      "config::tests::prepare_projection_from_powershell_deserializes_daemon_factory_manifest",
      "--",
      "--exact",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        VEM_FACTORY_RUNTIME_PROJECTION: JSON.stringify(projection),
      },
    },
  );
  assert.equal(
    rust.status,
    0,
    `Rust projection parse failed:\n${rust.stdout}\n${rust.stderr}`,
  );
  return { directory, projection };
}

describe("transient SSH operation retry", () => {
  it("retries a legacy SCP upload after a startup-window connection reset", async () => {
    const calls = [];
    const sleeps = [];
    const scpCommand = buildScpCommand(
      "/tmp/run.ps1",
      "C:\\Windows\\Temp\\vem-factory-acceptance-run.ps1",
      CERTIFICATE_SSH_OPTIONS,
    );
    const results = [
      {
        status: 255,
        stdout: "",
        stderr:
          "kex_exchange_identification: read: Connection reset by peer\nConnection reset by 192.0.2.10 port 22",
      },
      { status: 0, stdout: "uploaded", stderr: "" },
    ];

    const result = await runTransientSshOperation(
      scpCommand[0],
      scpCommand.slice(1),
      {
        run: async (command, args) => {
          calls.push({ command, args });
          return results.shift();
        },
        sleep: async (milliseconds) => sleeps.push(milliseconds),
        maxAttempts: 3,
        retryDelayMs: 25,
      },
    );

    assert.equal(result.status, 0);
    assert.deepEqual(calls, [
      { command: "scp", args: scpCommand.slice(1) },
      { command: "scp", args: scpCommand.slice(1) },
    ]);
    assert.deepEqual(sleeps, [25]);
  });

  it("checks cancellation again after an asynchronous retry delay", async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      runTransientSshOperation("scp", ["source", "target"], {
        run: async () => {
          calls += 1;
          return {
            status: 255,
            stdout: "",
            stderr: "Connection refused",
          };
        },
        sleep: async () => {
          controller.abort(new Error("cancelled by SIGTERM"));
        },
        signal: controller.signal,
      }),
      /cancelled by SIGTERM/,
    );
    assert.equal(calls, 1);
  });

  it("honors cancellation received during a successful upload", async () => {
    const controller = new AbortController();
    await assert.rejects(
      runTransientSshOperation("scp", ["source", "target"], {
        run: async () => {
          controller.abort(new Error("cancelled by SIGINT"));
          return { status: 0, stdout: "uploaded", stderr: "" };
        },
        signal: controller.signal,
      }),
      /cancelled by SIGINT/,
    );
  });

  it("aborts an in-flight SSH child instead of waiting for forced runner cleanup", async () => {
    const controller = new AbortController();
    const cancellation = setTimeout(
      () => controller.abort(new Error("cancelled by SIGTERM")),
      25,
    );
    try {
      await assert.rejects(
        runTransientSshOperation(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { signal: controller.signal },
        ),
        /cancelled by SIGTERM/,
      );
    } finally {
      clearTimeout(cancellation);
    }
  });

  it("does not retry authentication or remote path failures", async () => {
    let calls = 0;
    const result = await runTransientSshOperation("scp", ["source", "target"], {
      run: async () => {
        calls += 1;
        return {
          status: 255,
          stdout: "",
          stderr: "Permission denied (publickey).",
        };
      },
      sleep: async () => assert.fail("non-transient failure must not sleep"),
    });

    assert.equal(result.status, 255);
    assert.equal(calls, 1);
  });

  it("retains verifier evidence when a reset follows structured stdout", async () => {
    const evidence = {
      schemaVersion: "factory-preclaim-verification/v1",
      kind: "factory-preclaim-verification",
      ok: true,
    };
    let calls = 0;
    const result = await runTransientSshOperation("ssh", ["factory"], {
      run: async () => {
        calls += 1;
        return {
          status: 255,
          stdout: JSON.stringify(evidence),
          stderr: "Connection reset by peer",
        };
      },
      sleep: async () => assert.fail("verifier evidence must suppress retry"),
    });

    assert.equal(calls, 1);
    assert.equal(result.status, 255);
    assert.deepEqual(
      parseStructuredSshVerifierEvidence(result.stdout),
      evidence,
    );
  });
});

describe("simulated hardware serial acceptance evidence", () => {
  it("accepts one rendered customer binding and rejects a second serial sale binding", () => {
    const input = completedSerialSaleEvidence();
    const conformance = input.serialConformance;
    conformance.profile = "installed-kiosk-sale";
    conformance.customerUiSale = {
      orderId: "ORDER-180",
      paymentId: "PAYMENT-180",
      orderNo: "ORDER-NO-180",
      scenarioSha256: "a".repeat(64),
    };
    delete conformance.failureMatrix;
    resignSerialConformance(conformance);
    assert.doesNotThrow(() =>
      validateSerialConformanceReport(conformance, {
        expectedRunnerPublicKey: input.expectedRunnerPublicKey,
        expectedAdapterIdentity: input.expectedAdapterIdentity,
      }),
    );
    const duplicateSaleBindings = [
      ...conformance.reports.inject.request.serialSession.saleBindings,
      { ...conformance.reports.inject.request.serialSession.saleBindings[0] },
    ];
    conformance.requests.inject.serialSession.saleBindings =
      duplicateSaleBindings;
    conformance.reports.inject.request.serialSession.saleBindings =
      duplicateSaleBindings;
    resignSerialConformance(conformance);
    assert.throws(
      () =>
        validateSerialConformanceReport(conformance, {
          expectedRunnerPublicKey: input.expectedRunnerPublicKey,
          expectedAdapterIdentity: input.expectedAdapterIdentity,
        }),
      /must bind every requested sale correlation identity/,
    );
  });

  it("runs the canonical kiosk-sale CLI through fixture, rendered binding, serial completion, and cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-installed-kiosk-cli-"));
    const runtimeReport = join(root, "runtime-acceptance.json");
    const output = join(root, "profile", "installed-kiosk-sale.json");
    const scannerInput = join(root, "caller-scanner-code.txt");
    writeFileSync(scannerInput, "CALLER-SCANNER-CODE\n", { mode: 0o600 });
    const input = completedSerialSaleEvidence();
    const serial = input.serialConformance;
    serial.profile = "installed-kiosk-sale";
    serial.customerUiSale = {
      orderId: "ORDER-180",
      paymentId: "PAYMENT-180",
      orderNo: "ORDER-NO-180",
      scenarioSha256: "a".repeat(64),
    };
    delete serial.failureMatrix;
    resignSerialConformance(serial);
    writeFileSync(
      runtimeReport,
      JSON.stringify({
        ok: true,
        runtimeAcceptanceReport: {
          schemaVersion: "runtime-acceptance-report/v1",
          kioskRuntime: {
            sessionUser: "VEMKiosk",
            sessionId: 1,
            url: "http://tauri.localhost/#/catalog",
            cdpTargetId: "normal-target",
          },
        },
      }),
      "utf8",
    );
    const calls = [];
    try {
      const report = await runInstalledKioskSaleAcceptanceCli(
        {
          run_id: "RUN-180-EVIDENCE",
          machine_code: "VEM-TESTBED-WINVM-RUN-180-EVIDENCE",
          platform_target: "ephemeral-run-180",
          ephemeral_platform_evidence: join(root, "ephemeral-platform.json"),
          runtime_acceptance_report: runtimeReport,
          remote: "YKDZ@vm.example.test",
          identity: join(root, "identity"),
          certificate: join(root, "identity-cert.pub"),
          adapter: FAKE_VM_HOST_ADAPTER,
          target_identity: "vm-target://runtime-testbed",
          approved_runtime_base: `factory-cas://sha256/${"a".repeat(64)}`,
          profile: "vm-route-competition",
          scanner_code_file: scannerInput,
          ssh_known_hosts_path: join(root, "known-hosts"),
          ssh_host_key_alias: "vem-installed-kiosk-run-180",
          out: output,
        },
        {
          runCommand(command, label) {
            calls.push(label);
            const out = command[command.indexOf("--out") + 1];
            if (label === "simulated hardware fixture") {
              writeFileSync(
                out,
                JSON.stringify({
                  schemaVersion: "simulated-hardware-sale-fixture/v1",
                  phase: "fixture",
                  result: {
                    simulatedHardwareReady: { status: "fixture_ready" },
                  },
                }),
                "utf8",
              );
              return { status: 0 };
            }
            const scannerCodePath =
              command[command.indexOf("--scanner-code-file") + 1];
            assert.notEqual(scannerCodePath, scannerInput);
            assert.equal(
              readFileSync(scannerCodePath, "utf8"),
              "CALLER-SCANNER-CODE\n",
            );
            rmSync(scannerCodePath, { force: true });
            const completion = JSON.parse(
              command[command.indexOf("--sale-complete-command-json") + 1],
            );
            const completionOut = completion[completion.indexOf("--out") + 1];
            writeFileSync(
              completionOut,
              JSON.stringify({
                simulatedHardwareSaleFlow: {
                  sale: {
                    orderId: "ORDER-180",
                    paymentId: "PAYMENT-180",
                    orderNo: "ORDER-NO-180",
                    paymentStatus: "succeeded",
                    vendingCommandId: "VEND-180",
                    dispenseResult: "dispensed",
                  },
                  platformState: {
                    reservation: {
                      exposed: false,
                      source: "not_exposed",
                      rawRecordCount: 0,
                    },
                    postSaleDispenseMovement: {
                      movementId: "MOVEMENT-180",
                      orderId: "ORDER-180",
                      vendingCommandId: "VEND-180",
                      deltaQuantity: -1,
                      status: "accepted",
                    },
                    observedIdentities: {
                      orderIds: ["ORDER-180"],
                      paymentIds: ["PAYMENT-180"],
                      reservationIds: [],
                      orderNos: ["ORDER-NO-180"],
                      commandIds: ["VEND-180"],
                      movementIds: ["MOVEMENT-180"],
                    },
                  },
                },
              }),
              "utf8",
            );
            writeFileSync(out, JSON.stringify(serial), "utf8");
            return { status: 0 };
          },
          runRemote(_options, script) {
            if (script.includes("VEMInstalledKioskSaleRestore")) {
              calls.push("cleanup");
              return {
                daemonRunning: true,
                cdpListenerCount: 0,
                normal: {
                  principal: "VEM\\VEMKiosk",
                  sessionId: 1,
                  route: "#/catalog",
                  routeEvidence: {
                    source: "remote_cdp",
                    targetId: "restored-normal-target",
                    targetUrl:
                      "http://127.0.0.1:9222/devtools/page/restored-normal-target",
                    route: "#/catalog",
                    processId: 4243,
                    principal: "VEM\\VEMKiosk",
                    sessionId: 1,
                  },
                },
              };
            }
            calls.push("launch");
            return {
              prelaunch: {
                principal: "VEM\\VEMKiosk",
                sessionId: 1,
                executablePath: "C:\\VEM\\bringup\\machine.exe",
              },
              machine: {
                principal: "VEM\\VEMKiosk",
                sessionId: 1,
                executablePath: "C:\\VEM\\bringup\\machine.exe",
              },
              debugTarget: {
                id: "debug-target",
                url: "http://127.0.0.1:9222/devtools/page/debug-target",
              },
            };
          },
          async drive(options) {
            assert.equal(
              options.expectedRuntimeAttestation.targetId,
              "debug-target",
            );
            assert.ok(
              options.steps.some(
                (step) =>
                  step.type === "route-action" &&
                  step.stimulus === "history-back",
              ),
            );
            assert.equal(
              options.tunnelOptions.sshKnownHostsPath,
              join(root, "known-hosts"),
            );
            assert.equal(
              options.tunnelOptions.sshHostKeyAlias,
              "vem-installed-kiosk-run-180",
            );
            return {
              schemaVersion: "machine-ui-cdp-sale-scenario/v3",
              status: "passed",
              target: { id: "debug-target" },
              evidence: [
                { type: "route-barrier", forbiddenRoutes: ["/catalog"] },
                {
                  type: "route-action",
                  stimulus: "history-back",
                  routeBefore: "#/payment",
                  triggerAcknowledged: true,
                },
              ],
            };
          },
          async capture({ selector }) {
            if (selector.includes("payment-surface")) {
              return {
                targetId: "debug-target",
                route: "#/payment",
                orderId: "ORDER-180",
                paymentId: "PAYMENT-180",
                orderNo: "ORDER-NO-180",
              };
            }
            return {
              targetId: "debug-target",
              route: "#/result",
              orderId: "ORDER-180",
              paymentId: "PAYMENT-180",
              orderNo: "ORDER-NO-180",
              commandId: "VEND-180",
            };
          },
        },
      );
      assert.equal(report.schemaVersion, "installed-kiosk-sale-acceptance/v2");
      assert.equal(
        report.runtimeBinding.normal.normalTargetId,
        "normal-target",
      );
      assert.equal(report.runtimeBinding.debug.targetId, "debug-target");
      assert.equal(report.correlation.exactOnce.commandCount, 1);
      assert.equal(report.correlation.exactOnce.orderNoCount, 1);
      assert.equal(report.correlation.exactOnce.reservationCount, 0);
      assert.equal(readFileSync(scannerInput, "utf8"), "CALLER-SCANNER-CODE\n");
      assert.deepEqual(calls, [
        "simulated hardware fixture",
        "launch",
        "serial conformance",
        "cleanup",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parses nested production failure commands and executes the command array", () => {
    const failedSaleOutput = JSON.stringify({
      ok: false,
      simulatedHardwareSaleFlow: {
        phase: "complete",
        sale: {
          orderId: "ORDER-FAILED",
          paymentId: "PAYMENT-FAILED",
          vendingCommandId: "VEND-FAILED",
          dispenseResult: "failed",
        },
      },
    });
    const executable = [process.execPath, "-e", "process.exit(0)"];
    const failureCommands = readFailureMatrixCommands(
      JSON.stringify({
        "swapped-roles": {
          salePrepareCommand: executable,
          runtimeRecoveryCommand: executable,
        },
        "missing-device": {
          salePrepareCommand: executable,
          runtimeRecoveryCommand: executable,
        },
        "scanner-timeout": { salePrepareCommand: executable },
        "dispense-failed": {
          saleCompleteCommand: [
            process.execPath,
            "-e",
            `process.stdout.write(${JSON.stringify(failedSaleOutput)}); process.exit(1)`,
          ],
        },
      }),
    );

    assert.deepEqual(
      runFailedDispenseCommand(
        failureCommands["dispense-failed"].saleCompleteCommand,
        "sale-correlation://failed-sale",
      ),
      {
        saleCorrelationId: "sale-correlation://failed-sale",
        orderId: "ORDER-FAILED",
        paymentId: "PAYMENT-FAILED",
        vendingCommandId: "VEND-FAILED",
      },
    );
  });

  it("binds the completed sale to real Windows COM mappings and guest frames", () => {
    const evidence = evaluateSimulatedHardwareSerialEvidence(
      completedSerialSaleEvidence(),
    );

    assert.deepEqual(
      { status: evidence.status, asserted: evidence.asserted },
      { status: "passed", asserted: true },
      JSON.stringify(evidence.diagnostics),
    );
    assert.deepEqual(evidence.diagnostics, []);
  });

  it("rejects serial frames relabeled after sale completion", () => {
    const input = completedSerialSaleEvidence();
    const relabeledSale = {
      orderId: "ORDER-ATTACKER",
      paymentId: "PAYMENT-ATTACKER",
      vendingCommandId: "VEND-ATTACKER",
    };
    input.saleFlow.simulatedHardwareSaleFlow.sale = relabeledSale;
    input.serialConformance.reports.collect.serialEvidence.records =
      input.serialConformance.reports.collect.serialEvidence.records.map(
        (record) => ({
          ...record,
          saleBinding: record.saleBinding === null ? null : relabeledSale,
        }),
      );

    const evidence = evaluateSimulatedHardwareSerialEvidence(input);

    assert.equal(evidence.status, "failed");
    assert.ok(
      evidence.diagnostics.some(
        (diagnostic) => diagnostic.code === "serial_conformance_report_invalid",
      ),
    );
  });

  it("rejects a serial report relabeled into another run", () => {
    const input = completedSerialSaleEvidence();
    const conformance = input.serialConformance;
    conformance.runId = "RUN-ATTACKER";
    for (const name of ["start", "inject", "collect"]) {
      conformance.requests[name].runId = "RUN-ATTACKER";
      conformance.reports[name].request.runId = "RUN-ATTACKER";
    }

    const evidence = evaluateSimulatedHardwareSerialEvidence(input);

    assert.equal(evidence.status, "failed");
    assert.ok(
      evidence.diagnostics.some(
        (diagnostic) => diagnostic.code === "serial_conformance_report_invalid",
      ),
    );
  });

  it("rejects a correctly signed report that combines another VM lifecycle", () => {
    const input = completedSerialSaleEvidence();
    const report = input.serialConformance.reports.firstStop;
    report.observed.vmIdentity = "vm-instance://different-runtime";
    report.observed.overlayIdentity = "vm-overlay://different-runtime";
    resignSerialConformance(input.serialConformance);

    assert.throws(
      () =>
        validateSerialConformanceReport(input.serialConformance, {
          expectedRunnerPublicKey: input.expectedRunnerPublicKey,
          expectedAdapterIdentity: input.expectedAdapterIdentity,
        }),
      /must bind one trusted adapter and VM lifecycle/,
    );

    const evidence = evaluateSimulatedHardwareSerialEvidence(input);

    assert.equal(evidence.status, "failed");
    assert.ok(
      evidence.diagnostics.some(
        (diagnostic) => diagnostic.code === "serial_conformance_report_invalid",
      ),
    );
  });

  for (const [name, mutate, code] of [
    [
      "mock hardware adapter",
      (input) => {
        input.saleFlow.simulatedHardwareSaleFlow.daemonSerialConfiguration.hardwareAdapter =
          "mock";
      },
      "serial_adapter_evidence_required",
    ],
    [
      "TCP lower controller path",
      (input) => {
        input.saleFlow.simulatedHardwareSaleFlow.daemonSerialConfiguration.lowerControllerPort =
          "tcp://127.0.0.1:17991";
      },
      "windows_com_path_evidence_required",
    ],
    [
      "reused COM mapping",
      (input) => {
        input.saleFlow.simulatedHardwareSaleFlow.daemonSerialConfiguration.scannerPort =
          "COM31";
      },
      "distinct_virtual_com_mapping_required",
    ],
    [
      "software scanner injection",
      (input) => {
        input.serialConformance.reports.collect.serialEvidence.records.find(
          (record) => record.role === "scanner",
        ).capturedFrame.source = "software-injection";
      },
      "guest_serial_frame_evidence_required",
    ],
    [
      "missing lower controller frame",
      (input) => {
        input.serialConformance.reports.collect.serialEvidence.records.pop();
      },
      "guest_serial_frame_evidence_required",
    ],
  ]) {
    it(`fails closed for ${name}`, () => {
      const input = completedSerialSaleEvidence();
      mutate(input);
      const evidence = evaluateSimulatedHardwareSerialEvidence(input);

      assert.equal(evidence.status, "failed");
      assert.equal(evidence.asserted, false);
      assert.ok(
        evidence.diagnostics.some((diagnostic) => diagnostic.code === code),
      );
    });
  }
  for (const [name, mutate] of [
    [
      "missing repeated stop evidence",
      (input) => {
        delete input.serialConformance.reports.repeatedStop;
      },
    ],
    [
      "non-idempotent repeated stop",
      (input) => {
        input.serialConformance.reports.repeatedStop.serialSession.simulatorCleanup.idempotencyVerified = false;
      },
    ],
    [
      "surviving simulator process",
      (input) => {
        input.serialConformance.reports.repeatedStop.serialSession.simulatorCleanup.survivingProcessCount = 1;
      },
    ],
    [
      "incomplete failure matrix",
      (input) => {
        input.serialConformance.failureMatrix.pop();
      },
    ],
    [
      "mismatched failure diagnostic",
      (input) => {
        input.serialConformance.failureMatrix[0].diagnosticCode =
          "serial_device_disconnected";
      },
    ],
    [
      "missing mapping recovery",
      (input) => {
        const mappingFailure = input.serialConformance.failureMatrix.find(
          (entry) => entry.failureMode === "swapped-roles",
        );
        delete mappingFailure.recovery;
      },
    ],
    [
      "failure operation relabeling",
      (input) => {
        input.serialConformance.failureMatrix[0].operation = "cleanup";
      },
    ],
    [
      "failure business identity relabeling",
      (input) => {
        input.serialConformance.failureMatrix[0].orderId = "ORDER-OTHER";
      },
    ],
    [
      "mapping fail-closed session relabeling",
      (input) => {
        const mappingFailure = input.serialConformance.failureMatrix.find(
          (entry) => entry.failureMode === "missing-device",
        );
        mappingFailure.daemonFailClosed.adapterSession.serialSessionId =
          "serial-session://other";
      },
    ],
    [
      "coordinated failed-sale relabeling",
      (input) => {
        for (const failureMode of ["scanner-timeout", "dispense-failed"]) {
          const failure = input.serialConformance.failureMatrix.find(
            (entry) => entry.failureMode === failureMode,
          );
          failure.orderId = "ORDER-OTHER";
          failure.paymentId = "PAYMENT-OTHER";
        }
      },
    ],
    [
      "coordinated mapping session relabeling",
      (input) => {
        const failure = input.serialConformance.failureMatrix.find(
          (entry) => entry.failureMode === "swapped-roles",
        );
        for (const key of [
          "serialSessionId",
          "startOperationReference",
          "deviceMappingDigest",
        ]) {
          failure.startSerialSession[key] = `other-${key}`;
          failure.daemonFailClosed.adapterSession[key] = `other-${key}`;
        }
      },
    ],
    [
      "empty coordinated mapping session",
      (input) => {
        const failure = input.serialConformance.failureMatrix.find(
          (entry) => entry.failureMode === "missing-device",
        );
        for (const key of [
          "serialSessionId",
          "startOperationReference",
          "deviceMappingDigest",
        ]) {
          failure.startSerialSession[key] = "";
          failure.daemonFailClosed.adapterSession[key] = "";
        }
      },
    ],
    [
      "mapping start and fault source splicing",
      (input) => {
        const missing = input.serialConformance.failureMatrix.find(
          (entry) => entry.failureMode === "missing-device",
        );
        const swapped = input.serialConformance.failureMatrix.find(
          (entry) => entry.failureMode === "swapped-roles",
        );
        missing.source.start = structuredClone(swapped.source.start);
        missing.startSerialSession = structuredClone(
          swapped.startSerialSession,
        );
        missing.daemonFailClosed.adapterSession = structuredClone(
          swapped.daemonFailClosed.adapterSession,
        );
      },
    ],
  ]) {
    it(`rejects runner-signed conformance tampered by ${name}`, () => {
      const input = completedSerialSaleEvidence();
      mutate(input);
      resignSerialConformance(input.serialConformance);
      const evidence = evaluateSimulatedHardwareSerialEvidence(input);

      assert.equal(evidence.status, "failed");
      assert.equal(evidence.asserted, false);
      assert.ok(
        evidence.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "serial_conformance_report_invalid",
        ),
      );
    });
  }

  it("rejects a runner-signed report with incomplete mapping recovery semantics", () => {
    const input = completedSerialSaleEvidence();
    const mappingFailure = input.serialConformance.failureMatrix.find(
      (entry) => entry.failureMode === "missing-device",
    );
    delete mappingFailure.daemonFailClosed.saleBindingCreated;
    resignSerialConformance(input.serialConformance);

    assert.throws(
      () =>
        validateSerialConformanceReport(input.serialConformance, {
          expectedRunnerPublicKey: input.expectedRunnerPublicKey,
          expectedAdapterIdentity: input.expectedAdapterIdentity,
        }),
      /mapping failure is not fail-closed and recovered/,
    );

    const evidence = evaluateSimulatedHardwareSerialEvidence(input);
    assert.equal(evidence.status, "failed");
    assert.ok(
      evidence.diagnostics.some(
        (diagnostic) => diagnostic.code === "serial_conformance_report_invalid",
      ),
    );
  });

  it("rejects a runner-resigned scanner timeout source that already has a vending command", () => {
    const input = completedSerialSaleEvidence();
    const scannerTimeout = input.serialConformance.failureMatrix.find(
      (entry) => entry.failureMode === "scanner-timeout",
    );
    scannerTimeout.source.fault.request.serialSession.saleBindings[0].vendingCommandId =
      "VEND-ATTACKER";
    scannerTimeout.source.fault.report.request.serialSession.saleBindings[0].vendingCommandId =
      "VEND-ATTACKER";
    resignSerialConformance(input.serialConformance);

    assert.throws(
      () =>
        validateSerialConformanceReport(input.serialConformance, {
          expectedRunnerPublicKey: input.expectedRunnerPublicKey,
          expectedAdapterIdentity: input.expectedAdapterIdentity,
        }),
      /scanner timeout and failed dispense must bind one failed sale/,
    );

    const evidence = evaluateSimulatedHardwareSerialEvidence(input);
    assert.equal(evidence.status, "failed");
    assert.ok(
      evidence.diagnostics.some(
        (diagnostic) => diagnostic.code === "serial_conformance_report_invalid",
      ),
    );
  });

  it("rejects a runner-resigned mapping fault backed by completed-sale collect evidence", () => {
    const input = completedSerialSaleEvidence();
    const conformance = input.serialConformance;
    const mappingFailure = conformance.failureMatrix.find(
      (entry) => entry.failureMode === "missing-device",
    );
    mappingFailure.source = {
      start: {
        request: structuredClone(conformance.requests.start),
        report: structuredClone(conformance.reports.start),
      },
      fault: {
        request: structuredClone(conformance.requests.collect),
        report: structuredClone(conformance.reports.collect),
      },
    };
    mappingFailure.source.fault.report.diagnostics = [
      { code: mappingFailure.diagnosticCode },
    ];
    const mainSession = conformance.reports.start.serialSession;
    mappingFailure.startSerialSession = {
      serialSessionId: mainSession.serialSessionId,
      startOperationReference: mainSession.startOperationReference,
      deviceMappingDigest: mainSession.deviceMappingDigest,
    };
    mappingFailure.daemonFailClosed.adapterSession = {
      ...mappingFailure.startSerialSession,
      faultStartedAt: conformance.reports.start.timestamps.startedAt,
    };
    resignSerialConformance(conformance);

    assert.throws(
      () =>
        validateSerialConformanceReport(conformance, {
          expectedRunnerPublicKey: input.expectedRunnerPublicKey,
          expectedAdapterIdentity: input.expectedAdapterIdentity,
        }),
      /missing-device source does not prove the declared fault/,
    );

    const evidence = evaluateSimulatedHardwareSerialEvidence(input);
    assert.equal(evidence.status, "failed");
    assert.ok(
      evidence.diagnostics.some(
        (diagnostic) => diagnostic.code === "serial_conformance_report_invalid",
      ),
    );
  });
});

describe("factory acceptance cancellation cleanup", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    it(`fails closed after ${signal} when remote staging cleanup cannot be verified`, () => {
      const signalSource = new EventEmitter();
      const cleanupCalls = [];
      const controller = createFactoryAcceptanceCancellationController({
        cleanupRemoteFactoryStaging: () => {
          cleanupCalls.push("remote");
          return false;
        },
        cleanupLocalFactoryStaging: () => {
          cleanupCalls.push("local-staging");
          return true;
        },
        removeLocalTempDirectory: () => {
          cleanupCalls.push("local-temp");
          return true;
        },
      });
      const removeSignalHandlers = installFactoryAcceptanceSignalHandlers(
        controller,
        signalSource,
      );
      signalSource.emit(signal);
      removeSignalHandlers();

      assert.throws(
        () => controller.throwIfCancellationRequested(),
        new RegExp(`cancelled by ${signal}`),
      );
      assert.throws(
        () => controller.finalize(),
        new RegExp(
          `cleanup verification failed after ${signal}: remote factory staging cleanup verification failed`,
        ),
      );
      assert.deepEqual(cleanupCalls, ["local-staging", "remote", "local-temp"]);
      assert.deepEqual(controller.state, {
        cancellationSignal: signal,
        cleanupFailure: "remote factory staging cleanup verification failed",
      });
    });
  }

  it("independently deletes and verifies deterministic local and remote staging", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-cleanup-"));
    try {
      mkdirSync(join(root, "factory-personalization"));
      const cleanup = cleanupFactoryAcceptanceStaging(
        {
          mode: "clean-base-factory-acceptance",
          remote: "YKDZ@testbed.invalid",
          identity: "/tmp/maintenance-key",
          certificate: "/tmp/maintenance-cert.pub",
        },
        {
          localTempDirectory: root,
          spawn(command, args) {
            assert.equal(command, "ssh");
            assert.match(args.at(-1), /vem-factory-acceptance-staging/);
            assert.doesNotMatch(args.at(-1), /password|mediaId|private key/i);
            return { status: 0 };
          },
        },
      );
      assert.deepEqual(cleanup, { localCleaned: true, remoteCleaned: true });
      assert.equal(existsSync(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the local snapshot even when remote cleanup cannot start", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-factory-cleanup-failure-"));
    try {
      mkdirSync(join(root, "factory-personalization"));
      assert.throws(
        () =>
          cleanupFactoryAcceptanceStaging(
            {
              mode: "clean-base-factory-acceptance",
              remote: "YKDZ@testbed.invalid",
              identity: "/tmp/maintenance-key",
            },
            { localTempDirectory: root },
          ),
        /certificate-only SSH requires --identity and --certificate/,
      );
      assert.equal(existsSync(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const CERTIFICATE_SSH_OPTIONS = {
  identity: "/tmp/maintenance-key",
  certificate: "/tmp/maintenance-key-cert.pub",
};
const CERTIFICATE_SSH_ARGS = [
  "-o",
  "IdentityFile=/tmp/maintenance-key",
  "-o",
  "CertificateFile=/tmp/maintenance-key-cert.pub",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "IdentityAgent=none",
  "-o",
  "BatchMode=yes",
  "-o",
  "PasswordAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "PreferredAuthentications=publickey",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ConnectTimeout=30",
];

function runtimeAcceptanceFacts(overrides = {}) {
  return {
    mode: "fresh_bring_up",
    target: {
      testbedName: "win10-vem-e2e",
      machineCode: "VEM-TESTBED-WINVM-01",
      platformTarget: "vem-vps",
    },
    artifacts: {
      daemonSha256: "a".repeat(64),
      machineUiSha256: "b".repeat(64),
    },
    displayEvidence: {
      hostDisplayBaseline: {
        status: "passed",
        widthPx: 1080,
        heightPx: 1920,
      },
      interactiveDesktopDisplayBaseline: {
        status: "passed",
        widthPx: 1080,
        heightPx: 1920,
        sessionUser: "VEMKiosk",
        sessionId: 3,
      },
      sshServiceSessionScreenDimensions: {
        status: "observed",
        widthPx: 1024,
        heightPx: 768,
      },
      portraitKioskAcceptance: {
        status: "passed",
        widthPx: 1080,
        heightPx: 1920,
        sessionUser: "VEMKiosk",
        sessionId: 3,
        source: "interactive_kiosk_session",
      },
    },
    serviceState: {
      daemonService: {
        installed: true,
        running: true,
        startupType: "automatic",
      },
      machineUiTask: {
        name: "VEMMachineUI",
        exists: true,
        enabled: true,
        runAsUser: "VEMKiosk",
      },
    },
    startupBringup: {
      configuredBy: "scripts/windows/setup-scheduled-tasks.ps1",
      productionBringup: true,
      daemonOwnedInitialization: false,
      autoLogon: {
        configured: true,
        user: "VEMKiosk",
        domain: "DESKTOP-2STVS5B",
        force: true,
      },
      machineUiStartup: {
        configured: true,
        mode: "scheduled_task",
        runAsUser: "VEMKiosk",
        command: "C:\\Windows\\System32\\wscript.exe",
      },
      startupCommands: [
        {
          name: "VEMMachineUI",
          exists: true,
          enabled: true,
          runAsUser: "VEMKiosk",
          command: "C:\\Windows\\System32\\wscript.exe",
          arguments: '"C:\\VEM\\bringup\\launch-machine-ui.vbs"',
          workingDirectory: "C:\\VEM\\bringup",
        },
      ],
    },
    readyFile: {
      exists: true,
      readableByKioskUser: true,
      ipcEndpointPresent: true,
      tokenPresent: true,
    },
    provisioning: {
      provisioned: true,
      usedDaemonIpcTaskExecute: true,
      machineCode: "VEM-TESTBED-WINVM-01",
    },
    daemonRuntime: {
      ipcReachable: true,
      healthz: {
        backendOnline: true,
        mqttConnected: true,
        hardwareOnline: false,
        scannerOnline: false,
      },
      readyz: {
        ready: true,
      },
    },
    kioskRuntime: {
      webviewRunning: true,
      url: "http://tauri.localhost/#/",
      sessionUser: "VEMKiosk",
      sessionId: 3,
      processId: 500,
      cdpAvailable: true,
      cdpListenerProcessId: 600,
      cdpListenerSessionId: 3,
      cdpMachineAncestorProcessId: 500,
    },
    kioskDesktopEscape: {
      desktopVisible: false,
      taskbarVisible: false,
      startMenuVisible: false,
      edgeReachable: false,
      fileExplorerReachable: false,
    },
    ...overrides,
  };
}

function ephemeralPlatformEvidence(overrides = {}) {
  return {
    runId: "RUN-180",
    stack: {
      apiBaseUrl: "http://127.0.0.1:26849/api",
      mqttUrl: "mqtt://127.0.0.1:1883",
      databaseTarget: "explicit",
    },
    testbedMachine: {
      id: "machine-180",
      code: "VEM-TESTBED-WINVM-01",
      created: true,
      claim: {
        claimCode: "ABCD-2345",
        claimCodeId: "claim-180",
        expiresAt: "2026-07-04T22:00:00.000Z",
        path: "/api/machines/claim",
        closedClaimCodeIds: [],
      },
    },
    hardwareSlotTopology: {
      identity: "vem-prod-24",
      version: "2026-06-adr0026",
      slots: [],
    },
    seededData: {
      products: [],
      planogram: {
        planogramVersion: "TESTBED-RUN-180",
        status: "published",
        slotCount: 2,
      },
      stockSetup: [],
      paymentReadiness: {
        ready: true,
        mockProviderStatus: "enabled",
        serviceRequiresPaymentMockEnabled: true,
        runtimePaymentMockEnabled: true,
        mockPaymentAcknowledged: true,
      },
    },
    verificationPaths: {
      provisioningClaim: "/api/machines/claim",
      machineAuthToken: "/api/machine-auth/token",
      publishedPlanogram:
        "/api/machines/VEM-TESTBED-WINVM-01/planogram-versions/published",
      planogramAck:
        "/api/machines/VEM-TESTBED-WINVM-01/planogram-versions/TESTBED-RUN-180/ack",
      stockSnapshot: "/api/machines/VEM-TESTBED-WINVM-01/stock-snapshot",
      machineOrders: "/api/machine-orders",
    },
    ...overrides,
  };
}

function cleanBaseFactoryAcceptanceEvidence(overrides = {}) {
  const runId = overrides.runId ?? "RUN-182";
  const evidenceRoot = `C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\${runId}`;
  const preparationOutput = `${evidenceRoot}\\factory-runtime-preparation.json`;
  const verificationAction = `${evidenceRoot}\\factory-runtime-verification-action.json`;
  const verifierEvidence = `${evidenceRoot}\\factory-runtime-verification.json`;
  return {
    schemaVersion: "clean-base-factory-acceptance-report/v1",
    kind: "clean-base-factory-acceptance",
    runId,
    result: "passed",
    ok: true,
    dryRun: false,
    factoryProfile: "testbed",
    source: {
      kind: "clean-windows-base",
      uri: "factory-media://clean-windows-base",
      snapshot: "vem-clean-base-before-factory-prep",
      identity: {
        hostName: "WIN10-VEM-CLEAN",
        adapterTargetId: "win10-vem-clean-base",
      },
    },
    factoryWindowsBaselinePolicy: {
      schemaVersion: "factory-windows-baseline-policy/v1",
      model: "allowlist",
      requiredCapabilities: [
        "defender_enabled",
        "firewall_enabled",
        "no_default_product_remote_ingress",
        "vem_runtime_defender_exclusions",
        "openssh_server_for_maintenance_users",
        "tailscale_not_installed_by_default",
        "kiosk_account_denied_remote_access",
        "windows_event_logging",
        "powershell_management",
        "networking_certificates_time_sync",
        "webview2_runtime_support",
        "display_touch_usb_serial_drivers",
        "fonts_input_methods",
      ],
      disabledRuntimeInterference: [
        "windows_auto_update_installation",
        "windows_auto_update_auto_restart",
        "sleep",
        "hibernation",
        "testsigning",
        "store_automatic_app_updates",
        "consumer_experience_autostart",
        "consumer_experience_foreground_popups",
        "consumer_experience_kiosk_foreground_takeover_best_effort",
      ],
      evidenceFields: {
        windowsUpdatePolicy: "assertions.windowsUpdatePolicy",
        powerPolicy: "assertions.powerPolicy",
        bootPolicy: "assertions.bootPolicy",
        securityPosture: "assertions.securityPosture",
        remoteMaintenanceCapability:
          "assertions.factoryRemoteMaintenanceCapability",
        consumerExperienceInterference:
          "assertions.consumerExperienceInterference",
      },
    },
    artifacts: {
      daemonSha256: "a".repeat(64),
      machineUiSha256: "b".repeat(64),
    },
    readiness: {
      cleanBasePreparationAcceptance: "passed",
      dirtyHostResetAcceptance: "not_asserted",
      runtimeReady: "not_asserted",
      simulatedHardwareReady: "not_asserted",
      sellReady: "not_asserted",
    },
    assertions: {
      displayOrientationResolution: {
        status: "passed",
        orientation: "portrait",
        widthPx: 1080,
        heightPx: 1920,
      },
      sshReachability: { status: "passed", remote: "YKDZ@clean-base" },
      tailscaleDefaultAbsent: {
        status: "passed",
        name: "win10-vem-clean-base",
      },
      windowsUpdatePolicy: {
        status: "passed",
        automaticUpdateInstallation: "disabled",
        automaticRestart: "disabled",
      },
      powerPolicy: {
        status: "passed",
        sleep: "disabled",
        hibernation: "disabled",
      },
      bootPolicy: { status: "passed", testsigning: "off" },
      securityPosture: {
        status: "passed",
        defender: "enabled",
        firewall: "enabled",
        defenderExclusions: ["C:\\VEM\\bringup", "C:\\ProgramData\\VEM"],
        inboundFirewallRules: [],
        enabledVemInboundRules: [],
        fileAndPrinterSharing: "not_enabled",
      },
      factoryRemoteMaintenanceCapability: {
        status: "passed",
        opensshServer: "available",
        tailscale: "not_installed_by_default",
        kioskRemoteAccess: "denied",
        maintenanceUsersOnly: true,
        sshdConfigDeniesKioskUser: true,
        maintenanceInOpenSshUsers: true,
        kioskInOpenSshUsers: false,
        kioskInRemoteDesktopUsers: false,
      },
      consumerExperienceInterference: {
        status: "passed",
        componentAutostart: "policy_configured",
        foregroundPopups: "policy_configured",
        storeAutomaticAppUpdates: "disabled",
        kioskForegroundTakeover: "best_effort_policy_configured",
      },
      sleepDisabled: { status: "passed", states: ["S3", "S4"] },
      testsigningOff: { status: "passed" },
      autologonConfigured: { status: "passed", user: "VEMKiosk" },
      startupLauncherMode: {
        status: "passed",
        mode: "scheduled_task",
      },
      daemonService: { status: "passed", name: "VemVendingDaemon" },
      uiLauncherTask: { status: "passed", name: "VEMMachineUI" },
      runtimeResetGateClean: { status: "passed" },
      hardwareProfileMode: {
        status: "passed",
        profile: "testbed",
        mode: "simulated",
      },
      startupReachesBringUpOrSalesEligible: {
        status: "passed",
        state: "bring_up",
      },
      preflightNoMachineIdentity: { status: "passed" },
      preflightNoProvisioningProfile: { status: "passed" },
      preflightNoProtectedSecrets: { status: "passed" },
      preflightNoDaemonState: { status: "passed" },
      preflightNoPreviousVemEvidence: { status: "passed" },
    },
    evidence: {
      factoryProfile: "testbed",
      preparationOutput,
      verificationAction,
      verifierEvidence,
      factoryRuntimeVerification: {
        ok: true,
        manifestPath:
          "C:\\ProgramData\\VEM\\factory\\factory-runtime-manifest.json",
        failures: [],
        checks: {
          manifest: {
            schemaVersion: "vem-factory-runtime-manifest/v1",
            factoryProfile: "testbed",
            hardwareMode: "simulated",
            hardwareModel: "win10-clean-base",
            topologyIdentity: "clean-base-factory-runtime",
            topologyVersion: "clean-base-v1",
          },
        },
      },
      actions: [
        {
          name: "run scripted clean-base factory runtime preparation",
          status: "succeeded",
          outputPath: preparationOutput,
        },
        {
          name: "run scripted clean-base factory runtime verifier",
          status: "succeeded",
          outputPath: verificationAction,
        },
      ],
    },
    ...overrides,
  };
}

function commandArg(command, flag) {
  const index = command.indexOf(flag);
  return index === -1 ? undefined : command[index + 1];
}

function approvedPreclaimBaseEvidence() {
  return {
    schemaVersion: "factory-preclaim-verification/v1",
    kind: "factory-preclaim-verification",
    ok: true,
  };
}

describe("win10-vem-e2e reset planning", () => {
  it("stages the complete Vision installer closure for canonical clean-base Factory acceptance", () => {
    const source = readFileSync("scripts/testbed/win10-vem-e2e.mjs", "utf8");

    assert.match(
      source,
      /const FACTORY_SUPPORT_SCRIPT_NAMES = \[[\s\S]*?"install-vision-release\.ps1"[\s\S]*?"vision-release-materialization\.psm1"[\s\S]*?"vision-diagnostic-redaction\.psm1"[\s\S]*?\];/,
    );
    assert.match(
      source,
      /foreach \(\$scriptName in \$\{psArray\(FACTORY_SUPPORT_SCRIPT_NAMES\)\}\)[\s\S]*?Copy-Item -LiteralPath \$source -Destination \(Join-Path \$scriptRoot \$scriptName\)/,
    );
    assert.match(
      source,
      /for \(const scriptName of FACTORY_SUPPORT_SCRIPT_NAMES\)[\s\S]*?scripts\/windows\/\$\{scriptName\}/,
    );
  });

  it("requires the exact protected GitHub gate and runner identity before secret media can be opened", () => {
    const trusted = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REPOSITORY: "vem/vem",
      GITHUB_REPOSITORY_OWNER: "vem",
      GITHUB_ACTOR: "vem",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF:
        "vem/vem/.github/workflows/factory-image-acceptance.yml@refs/heads/main",
      VEM_FACTORY_PERSONALIZATION_TRUSTED_GATE: "approved",
      VEM_FACTORY_PERSONALIZATION_TRUSTED_RUNNER_NAME: "vem-factory-01",
      VEM_FACTORY_PERSONALIZATION_RUNNER_NAME: "vem-factory-01",
      VEM_FACTORY_PERSONALIZATION_RUNNER_LABELS: JSON.stringify([
        "self-hosted",
        "Linux",
        "X64",
        "vem-factory",
      ]),
    };
    assert.equal(
      assertTrustedProtectedFactoryPersonalizationGate(trusted).runnerName,
      "vem-factory-01",
    );
    const workflow = readFileSync(
      ".github/workflows/factory-image-acceptance.yml",
      "utf8",
    );
    assert.match(workflow, /environment: vem-factory-production/);
    assert.match(workflow, /VEM_FACTORY_PERSONALIZATION_TRUSTED_RUNNER_NAME/);
    assert.match(workflow, /VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH/);
    assert.doesNotMatch(workflow, /VEM_FACTORY_PERSONALIZATION_RUN_ARGS_JSON/);
    for (const environment of [
      { ...trusted, VEM_FACTORY_PERSONALIZATION_TRUSTED_GATE: "" },
      { ...trusted, VEM_FACTORY_PERSONALIZATION_RUNNER_NAME: "other-runner" },
      {
        ...trusted,
        GITHUB_WORKFLOW_REF: "vem/vem/.github/workflows/ci.yml@refs/heads/main",
      },
      { ...trusted, VEM_FACTORY_PERSONALIZATION_RUNNER_LABELS: "[]" },
    ]) {
      assert.throws(
        () => assertTrustedProtectedFactoryPersonalizationGate(environment),
        /protected GitHub gate|protected factory runner/i,
      );
    }
  });

  it("rejects profile promotion when clean-base or verifier evidence does not bind the same profile", () => {
    for (const evidence of [
      cleanBaseFactoryAcceptanceEvidence({ factoryProfile: "production" }),
      cleanBaseFactoryAcceptanceEvidence({
        evidence: {
          ...cleanBaseFactoryAcceptanceEvidence().evidence,
          factoryProfile: "production",
        },
      }),
      cleanBaseFactoryAcceptanceEvidence({
        evidence: {
          ...cleanBaseFactoryAcceptanceEvidence().evidence,
          factoryRuntimeVerification: {
            ...cleanBaseFactoryAcceptanceEvidence().evidence
              .factoryRuntimeVerification,
            checks: {
              manifest: {
                ...cleanBaseFactoryAcceptanceEvidence().evidence
                  .factoryRuntimeVerification.checks.manifest,
                factoryProfile: "production",
              },
            },
          },
        },
      }),
    ]) {
      assert.throws(
        () =>
          buildFactoryImageDeliveryUnitReport({
            cleanBaseAcceptance: evidence,
          }),
        /factoryProfile|completed prep run evidence/i,
      );
    }
  });

  it("keeps remote personalization staging deterministic, ACL-verified, and cleanup-scannable", () => {
    const source = readFileSync("scripts/testbed/win10-vem-e2e.mjs", "utf8");
    assert.match(source, /vem-factory-acceptance-staging/);
    assert.match(source, /vem-factory-acceptance-staging"\)/);
    assert.match(
      source,
      /factory stale staging cleanup verification failed before retry/,
    );
    assert.match(
      source,
      /installFactoryAcceptanceSignalHandlers\(cancellation\)/,
    );
    assert.match(source, /cancellation\.finalize\(\)/);
    assert.doesNotMatch(source, /process\.exit\(128\)/);
    assert.match(source, /icacls\.exe .*\/inheritance:r .*\/grant:r/s);
    assert.match(
      source,
      /\$LASTEXITCODE -ne 0.*icacls failed to protect factory personalization/s,
    );
    assert.match(
      source,
      /Factory Personalization Media ACL verification failed before Windows reads it/,
    );
  });
  it("rejects retired Factory modes and caller-controlled SSH transport arguments", () => {
    const canonicalArgs = [
      "--mode",
      "clean-base-factory-acceptance",
      "--run-id",
      "RUN-190",
      "--clean-base-source",
      "factory-media://clean-windows-base",
      "--daemon-artifact-sha256",
      "a".repeat(64),
      "--machine-ui-artifact-sha256",
      "b".repeat(64),
      "--dry-run",
    ];
    const retiredInvocations = [
      [
        "--mode",
        "dirty-host-factory-acceptance",
        "--run-id",
        "RUN-190",
        "--dry-run",
      ],
      [...canonicalArgs, "--ssh-config"],
      [...canonicalArgs, "--proxy-command", "ssh -W %h:%p arbitrary.example"],
      [...canonicalArgs, "--allow-testbed-remote-alias"],
      [...canonicalArgs, "--use-existing-remote-artifacts"],
    ];

    for (const args of retiredInvocations) {
      const result = spawnSync(
        process.execPath,
        ["scripts/testbed/win10-vem-e2e.mjs", ...args],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /unknown argument|unsupported mode/);
    }
  });

  it("requires an active VEMKiosk interactive Windows session for display acceptance", () => {
    assert.equal(
      findActiveKioskSession([
        {
          user: "YKDZ",
          sessionId: 0,
          state: "Active",
          source: "ssh_service_session",
        },
      ]),
      null,
    );

    const activeKioskSession = findActiveKioskSession([
      {
        user: "VEMKiosk",
        sessionName: "console",
        sessionId: 3,
        state: "Active",
        source: "quser",
      },
    ]);

    assert.deepEqual(activeKioskSession, {
      user: "VEMKiosk",
      sessionName: "console",
      sessionId: 3,
      state: "Active",
      source: "quser",
    });

    assert.deepEqual(
      findActiveKioskSession([
        {
          user: "vemkiosk",
          sessionName: "console",
          sessionId: 1,
          state: "运行中",
          source: "quser",
        },
      ]),
      {
        user: "vemkiosk",
        sessionName: "console",
        sessionId: 1,
        state: "运行中",
        source: "quser",
      },
    );

    assert.deepEqual(
      buildInteractiveDesktopDisplayBaseline({
        activeSession: null,
        screen: { widthPx: 1080, heightPx: 1920 },
      }),
      {
        status: "missing",
        widthPx: 0,
        heightPx: 0,
        sessionUser: "unknown",
        sessionId: null,
        source: "interactive_desktop_screen",
      },
    );
  });

  it("does not accept SSH-only 1024x768 dimensions as the interactive desktop baseline", () => {
    const activeSession = findActiveKioskSession([
      {
        user: "VEMKiosk",
        sessionId: 3,
        state: "Active",
        source: "quser",
      },
    ]);

    const baseline = buildInteractiveDesktopDisplayBaseline({
      activeSession,
      screen: {
        widthPx: 1024,
        heightPx: 768,
        source: "ssh_service_session",
      },
    });

    assert.deepEqual(baseline, {
      status: "failed",
      widthPx: 1024,
      heightPx: 768,
      sessionUser: "VEMKiosk",
      sessionId: 3,
      source: "interactive_desktop_screen",
    });
    assert.deepEqual(buildPortraitKioskAcceptance(baseline), {
      status: "failed",
      widthPx: 1024,
      heightPx: 768,
      sessionUser: "VEMKiosk",
      sessionId: 3,
      source: "interactive_kiosk_session",
    });

    assert.equal(
      buildInteractiveDesktopDisplayBaseline({
        activeSession,
        screen: {
          widthPx: 1080,
          heightPx: 1920,
          source: "ssh_service_session",
        },
      }).status,
      "failed",
    );
  });

  it("requires a strict tauri.localhost hash-route URL for WebView runtime acceptance", () => {
    assert.equal(isStrictTauriHashRouteUrl("http://tauri.localhost/#/"), true);
    assert.equal(
      isStrictTauriHashRouteUrl("http://tauri.localhost/#/maintenance"),
      true,
    );
    assert.equal(isStrictTauriHashRouteUrl("http://tauri.localhost/"), false);
    assert.equal(
      isStrictTauriHashRouteUrl("http://tauri.localhost.evil/#/"),
      false,
    );
    assert.equal(
      isStrictTauriHashRouteUrl("http://127.0.0.1/?u=tauri.localhost/#/"),
      false,
    );
  });

  it("accepts debug CDP or production WebView2 evidence from the active VEMKiosk session", () => {
    const activeSession = {
      user: "VEMKiosk",
      sessionId: 3,
      state: "Active",
      source: "quser",
    };
    const machineProcesses = [
      { processId: 500, ownerUser: "VEMKiosk", sessionId: 3 },
    ];

    assert.deepEqual(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        cdpTargets: [],
      }),
      {
        webviewRunning: false,
        url: "unavailable:no-tauri-hash-route-target",
        sessionUser: "VEMKiosk",
        sessionId: 3,
        processId: 500,
        webView2ProcessId: null,
        cdpListenerProcessId: null,
        cdpListenerSessionId: null,
        cdpMachineAncestorProcessId: null,
        cdpTargetId: null,
        cdpAvailable: true,
        error: "kiosk_webview_not_verified",
      },
    );

    assert.equal(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        cdpTargets: [{ url: "http://tauri.localhost/" }],
      }).webviewRunning,
      false,
    );

    assert.equal(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses: [
          { processId: 501, ownerUser: "VEMKiosk", sessionId: 7 },
        ],
        cdpTargets: [
          { id: "cdp-target-runtime-001", url: "http://tauri.localhost/#/" },
        ],
      }).webviewRunning,
      false,
    );

    assert.equal(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        cdpListener: {
          processId: 600,
          sessionId: 3,
          machineAncestorProcessId: 500,
        },
        cdpTargets: [
          { id: "cdp-target-runtime-001", url: "http://tauri.localhost/#/" },
        ],
      }).webviewRunning,
      true,
    );

    for (const cdpListener of [
      null,
      { processId: 600, sessionId: 7, machineAncestorProcessId: 500 },
      { processId: 600, sessionId: 3, machineAncestorProcessId: 999 },
    ]) {
      assert.equal(
        buildKioskRuntimeEvidence({
          activeSession,
          machineProcesses,
          cdpListener,
          cdpTargets: [
            { id: "cdp-target-runtime-001", url: "http://tauri.localhost/#/" },
          ],
        }).webviewRunning,
        false,
      );
    }

    assert.deepEqual(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        webView2Processes: [
          { processId: 600, ownerUser: "VEMKiosk", sessionId: 3 },
        ],
        cdpTargets: [],
        cdpAvailable: false,
      }),
      {
        webviewRunning: true,
        url: "unavailable:production-cdp-disabled",
        sessionUser: "VEMKiosk",
        sessionId: 3,
        processId: 500,
        webView2ProcessId: 600,
        cdpListenerProcessId: null,
        cdpListenerSessionId: null,
        cdpMachineAncestorProcessId: null,
        cdpTargetId: null,
        cdpAvailable: false,
        error: null,
      },
    );

    assert.equal(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        webView2Processes: [
          { processId: 601, ownerUser: "VEMKiosk", sessionId: 7 },
        ],
        cdpTargets: [],
        cdpAvailable: false,
      }).webviewRunning,
      false,
    );
  });

  it("plans production bring-up through the shared Windows setup script", () => {
    const plan = buildBringUpPlan();

    assert.equal(
      plan.setupScript,
      "C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks.ps1",
    );
    assert.deepEqual(plan.requiredSecretEnvironment, [
      "VEM_KIOSK_PASSWORD",
      "VEM_MAINTENANCE_PASSWORD",
      "VEM_AUTOLOGON_PASSWORD",
    ]);
    assert.equal(plan.arguments.KioskUser, "VEMKiosk");
    assert.equal(plan.arguments.MaintenanceUser, "YKDZ");
    assert.equal(plan.arguments.RunAsUser, "YKDZ");
    assert.equal(plan.arguments.KioskPassword, "$env:VEM_KIOSK_PASSWORD");
    assert.equal(
      plan.arguments.MaintenancePassword,
      "$env:VEM_MAINTENANCE_PASSWORD",
    );
    assert.equal(
      plan.arguments.AutoLogonPassword,
      "$env:VEM_AUTOLOGON_PASSWORD",
    );
    assert.deepEqual(plan.switches, [
      "ConfigureKioskAccounts",
      "UseKioskAccount",
      "ConfigureAutoLogon",
    ]);
  });

  it("configures a per-user Winlogon shell only with Shell Launcher", () => {
    const script = readFileSync(
      "scripts/windows/setup-scheduled-tasks.ps1",
      "utf8",
    );

    assert.match(script, /function Set-PerUserWinlogonShell/);
    assert.match(script, /Shell Launcher SetCustomShell for \$User/);
    assert.match(
      script,
      /Set-PerUserWinlogonShell -User \$User -Sid \$sid -ShellCommand \$shellCommand/,
    );
    assert.match(script, /Shell Launcher kiosk startup evidence/);
    assert.match(script, /VEMMachineUI logon task is the sole kiosk UI owner/);
    assert.match(script, /function Ensure-KioskDisplayProbeScript/);
    assert.match(script, /capture-kiosk-display\.ps1/);
    assert.match(script, /kiosk-display-evidence\.json/);
  });

  it("falls back to a VEMKiosk logon task when Shell Launcher is unavailable", () => {
    const setupScript = readFileSync(
      "scripts/windows/setup-scheduled-tasks.ps1",
      "utf8",
    );
    const prepareScript = readFileSync(
      "scripts/windows/prepare-factory-runtime.ps1",
      "utf8",
    );

    assert.match(setupScript, /function Test-ShellLauncherAvailable/);
    assert.match(
      setupScript,
      /\$ShellLauncherOwnsStartup = \[bool\]\$ConfigureKioskShell -and \(Test-ShellLauncherAvailable\)/,
    );
    assert.match(setupScript, /if \(-not \$ShellLauncherOwnsStartup\)/);
    assert.match(
      setupScript,
      /Registered VEMMachineUI logon task because Shell Launcher is unavailable/,
    );
    assert.match(prepareScript, /function Test-ShellLauncherAvailable/);
    assert.match(
      prepareScript,
      /\$machineUiStartupMode = if \(Test-ShellLauncherAvailable\) \{ "shell_launcher" \} else \{ "scheduled_task" \}/,
    );
    assert.match(
      prepareScript,
      /machineUiStartupMode = \$machineUiStartupMode/,
    );
  });

  it("requires Shell Launcher evidence to include its per-user Winlogon shell", () => {
    const script = readFileSync(
      "scripts/windows/verify-factory-runtime.ps1",
      "utf8",
    );

    assert.match(script, /shellLauncherEvidence = \[pscustomobject\]@{/);
    assert.match(script, /winlogonConfigured = Test-ShellCommandMatches/);
    assert.match(script, /Shell Launcher \+ per-user Winlogon shell/);
    assert.match(script, /winlogonShell = \$shell/);
    assert.doesNotMatch(
      script,
      /return \[pscustomobject\]@\{\s*mode = "Shell Launcher"/,
    );
  });

  it("plans only VEM runtime and registration artifacts for reset", () => {
    const plan = buildResetPlan();

    assert.deepEqual(plan.stopServices, ["VemVendingDaemon"]);
    assert.deepEqual(plan.unregisterScheduledTasks, [
      "VEMMachineUI",
      "VEMMaintenanceUI",
      "VEM\\StartVisionServer",
    ]);
    assert.deepEqual(plan.removeDirectories, [
      "C:\\VEM\\bringup",
      "C:\\VEM\\updates",
      "C:\\VEM\\vision",
      "C:\\ProgramData\\VEM\\vending-daemon",
    ]);
    assert.deepEqual(plan.removeFiles, [
      "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json",
    ]);
    assert.deepEqual(plan.preservedResources, [
      "Windows OS",
      "display setup",
      "OpenSSH",
      "Controlled Maintenance Ingress configuration",
      "WebView2",
      "YKDZ maintenance account",
      "base networking",
    ]);

    assert.doesNotThrow(() => assertResetPlanPreservesTestbed(plan));
  });

  it("rejects reset plans that target preserved testbed prerequisites", () => {
    const protectedPaths = [
      "C:\\Windows\\System32\\OpenSSH",
      "C:\\Program Files\\Tailscale",
      "C:\\Program Files\\OpenSSH",
      "C:\\Program Files (x86)\\Microsoft\\EdgeWebView",
      "C:\\Users\\YKDZ",
      "C:\\ProgramData\\Tailscale",
      "C:\\ProgramData\\ssh",
    ];

    for (const path of protectedPaths) {
      assert.throws(
        () =>
          assertResetPlanPreservesTestbed({
            ...buildResetPlan(),
            removeDirectories: [path],
          }),
        /protected testbed resource/,
      );
    }

    for (const service of ["Tailscale", "sshd"]) {
      assert.throws(
        () =>
          assertResetPlanPreservesTestbed({
            ...buildResetPlan(),
            stopServices: [service],
          }),
        /protected testbed resource/,
      );
    }

    for (const task of [
      "Tailscale",
      "sshd",
      "MicrosoftEdgeUpdateTaskMachineCore",
    ]) {
      assert.throws(
        () =>
          assertResetPlanPreservesTestbed({
            ...buildResetPlan(),
            unregisterScheduledTasks: [task],
          }),
        /protected testbed resource/,
      );
    }
  });

  it("builds an inventory-and-reset script with required evidence and idempotent cleanup", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory-reset",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /Get-CimInstance Win32_OperatingSystem/);
    assert.match(script, /WindowsIdentity/);
    assert.match(script, /Test-LocalAdmin/);
    assert.doesNotMatch(script, /Get-CommandEvidence "tailscale"/);
    assert.doesNotMatch(script, /Get-ServiceStateOrNull -Name "Tailscale"/);
    assert.match(script, /Get-ServiceStateOrNull -Name "sshd"/);
    assert.match(script, /Get-WebView2Presence/);
    assert.match(script, /Get-DisplayEvidence/);
    assert.match(script, /artifactConsumerPrerequisites/);
    assert.match(script, /Stop-Service -Name 'VemVendingDaemon'/);
    assert.match(script, /Unregister-ScheduledTask -TaskName 'VEMMachineUI'/);
    assert.match(
      script,
      /Unregister-ScheduledTask -TaskName 'VEMMaintenanceUI'/,
    );
    assert.match(
      script,
      /Unregister-ScheduledTask -TaskName 'StartVisionServer' -TaskPath '\\VEM\\'/,
    );
    assert.match(script, /Remove-Item -LiteralPath 'C:\\VEM\\bringup'/);
    assert.match(script, /-ErrorAction SilentlyContinue/);
    assert.match(script, /maintenanceUiTask/);
    assert.match(script, /runtimeAcceptanceFactsSubset/);
    assert.doesNotMatch(script, /Remove-Item -LiteralPath 'C:\\Windows/);
    assert.doesNotMatch(script, /Remove-LocalUser/);
    assert.doesNotMatch(script, /Remove-Item -LiteralPath 'C:\\Users\\YKDZ/);
    assert.doesNotMatch(
      script,
      /Remove-Item -LiteralPath 'C:\\ProgramData\\Tailscale/,
    );
    assert.doesNotMatch(
      script,
      /Remove-Item -LiteralPath 'C:\\ProgramData\\ssh/,
    );
  });

  it("quotes PowerShell literals without expanding variable or subexpression syntax", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "target's-$($bad)",
      machineCode: "VEM-TESTBED-$($env:USERNAME)-01",
    });

    assert.match(script, /machineCode = 'VEM-TESTBED-\$\(\$env:USERNAME\)-01'/);
    assert.match(script, /platformTarget = 'target''s-\$\(\$bad\)'/);
    assert.doesNotMatch(
      script,
      /machineCode = "VEM-TESTBED-\$\(\$env:USERNAME\)-01"/,
    );
  });

  it("reports cleanup and reset postcondition failures instead of masking them", () => {
    const script = buildRemotePowerShellScript({ mode: "inventory-reset" });

    assert.match(
      script,
      /Stop-Service -Name 'VemVendingDaemon' -Force -ErrorAction Stop/,
    );
    assert.match(
      script,
      /Unregister-ScheduledTask -TaskName 'VEMMachineUI' -TaskPath '\\' -Confirm:\$false -ErrorAction Stop/,
    );
    assert.match(
      script,
      /Remove-Item -LiteralPath 'C:\\VEM\\bringup' -Recurse -Force -ErrorAction Stop/,
    );
    assert.doesNotMatch(
      script,
      /Stop-Service -Name 'VemVendingDaemon'[^\n]*SilentlyContinue/,
    );
    assert.doesNotMatch(
      script,
      /Unregister-ScheduledTask -TaskName 'VEMMachineUI'[^\n]*SilentlyContinue/,
    );
    assert.doesNotMatch(
      script,
      /Remove-Item -LiteralPath 'C:\\VEM\\bringup'[^\n]*SilentlyContinue/,
    );
    assert.match(script, /function Assert-ResetPostcondition/);
    assert.match(
      script,
      /Assert-ResetPostcondition \$resetActions "service VemVendingDaemon removed"/,
    );
    assert.match(
      script,
      /Assert-ResetPostcondition \$resetActions "scheduled task VEMMachineUI removed"/,
    );
    assert.match(
      script,
      /Assert-ResetPostcondition \$resetActions "directory C:\\VEM\\bringup removed"/,
    );
    assert.match(script, /\$LASTEXITCODE -ne 0/);
  });

  it("emits a runtime acceptance facts subset using shared-contract field shapes", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Convert-DisplayDimensionsEvidence/);
    assert.match(script, /runtimeAcceptanceFactsSubset = \[ordered\]@{/);
    assert.doesNotMatch(script, /runtimeAcceptanceFragment/);
    assert.doesNotMatch(script, /compatibleWith/);
    assert.match(script, /mode = "fresh_bring_up"/);
    assert.match(script, /testbedName = "win10-vem-e2e"/);
    assert.match(script, /hostDisplayBaseline = \$displayDimensionsEvidence/);
    assert.match(
      script,
      /sshServiceSessionScreenDimensions = \$displayDimensionsEvidence/,
    );
    assert.match(
      script,
      /interactiveDesktopDisplayBaseline = \$interactiveDesktopDisplayBaseline/,
    );
    assert.match(script, /portraitKioskAcceptance = \$portraitKioskAcceptance/);
    assert.match(script, /status = "observed"/);
    assert.match(script, /widthPx = \[int\]\$screen.widthPx/);
    assert.match(script, /heightPx = \[int\]\$screen.heightPx/);
    assert.match(script, /serviceState = \[ordered\]@{/);
    assert.match(script, /startupBringup = \$startupBringup/);
    assert.match(script, /function Get-StartupBringupEvidence/);
    assert.match(
      script,
      /C:\\ProgramData\\VEM\\vending-daemon\\startup-bringup-evidence\.json/,
    );
    assert.match(script, /configuredBy = "missing"/);
    assert.match(script, /productionBringup = \$false/);
    assert.match(script, /daemonOwnedInitialization = \$true/);
    assert.match(script, /startupCommands = \$startupCommands/);
    assert.match(script, /readyFile = \[ordered\]@{/);
    assert.match(script, /provisioning = \[ordered\]@{/);
    assert.match(script, /runtimeAcceptanceReportPreparation = \[ordered\]@{/);
    assert.match(script, /completeness = "partial_missing_required_facts"/);
    assert.match(
      script,
      /missingRequiredFacts = @\("artifacts", "daemonRuntime"\)/,
    );
    assert.match(script, /runtimeReadyAssertion = \[ordered\]@{/);
    assert.match(script, /status = "not_asserted"/);
    assert.match(script, /factsSubset = \$runtimeAcceptanceFactsSubset/);
  });

  it("builds kiosk acceptance from interactive VEMKiosk evidence instead of SSH display dimensions", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Get-InteractiveDesktopDisplayEvidence/);
    assert.match(script, /function Get-InteractiveWindowsSessionEvidence/);
    assert.match(script, /quser 2>&1/);
    assert.match(script, /activeKioskSessionId/);
    assert.match(script, /function Get-CurrentDesktopScreenDimensions/);
    assert.match(script, /kiosk-display-evidence\.json/);
    assert.match(script, /kiosk_logon_display_probe/);
    assert.match(script, /EnumDisplaySettings/);
    assert.match(
      script,
      /function Convert-InteractiveDisplayDimensionsEvidence/,
    );
    assert.match(script, /function Convert-PortraitKioskAcceptanceEvidence/);
    assert.match(script, /"interactive_kiosk_session"/);
    assert.match(script, /"VEMKiosk"/);
    assert.match(script, /sessionId = if \(\$null -ne \$Display\.sessionId\)/);
    assert.match(
      script,
      /widthPx -eq 1080 -and \$Dimensions.heightPx -eq 1920/,
    );
    assert.match(script, /portraitKioskAcceptance = \$portraitKioskAcceptance/);
    assert.doesNotMatch(
      script,
      /portraitKioskAcceptance = \$displayDimensionsEvidence/,
    );
    assert.doesNotMatch(
      script,
      /interactiveDesktopDisplayBaseline = \$displayDimensionsEvidence/,
    );
    assert.doesNotMatch(script, /GetWindowRect/);
    assert.doesNotMatch(script, /machine\.exe-main-window/);
  });

  it("builds kiosk runtime evidence from same-session machine.exe and WebView2", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Get-KioskRuntimeEvidence/);
    assert.match(script, /Win32_Process -Filter "name = 'machine.exe'"/);
    assert.match(script, /Win32_Process -Filter "name = 'msedgewebview2.exe'"/);
    assert.match(script, /Invoke-CimMethod .* -MethodName GetOwner/);
    assert.match(script, /http:\/\/127\.0\.0\.1:9222\/json/);
    assert.match(script, /function Test-TauriHashRouteUrl/);
    assert.match(script, /\$uri\.Host -eq "tauri\.localhost"/);
    assert.match(script, /\$uri\.Fragment\.StartsWith\("#\/"\)/);
    assert.match(script, /\$_\.sessionId -eq \$ActiveKioskSession\.sessionId/);
    assert.match(script, /webviewRunning = \$kioskRuntime.webviewRunning/);
    assert.match(script, /url = \$kioskRuntime.url/);
    assert.match(script, /cdpTargetId = \$kioskRuntime.cdpTargetId/);
    assert.match(
      script,
      /webView2ProcessId = \$kioskRuntime.webView2ProcessId/,
    );
    assert.match(script, /production-cdp-disabled/);
    assert.match(script, /sessionUser = \$kioskRuntime.sessionUser/);
    assert.match(script, /sessionId = \$kioskRuntime.sessionId/);
  });

  it("builds a bring-up script that invokes production setup with testbed-safe arguments", () => {
    const script = buildRemotePowerShellScript({ mode: "bring-up" });

    assert.match(script, /function Invoke-ProductionBringUp/);
    assert.match(
      script,
      /\$setupScript = 'C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks\.ps1'/,
    );
    assert.match(script, /Assert-RequiredSecretEnvironment \$secretName/);
    assert.match(script, /'VEM_KIOSK_PASSWORD'/);
    assert.match(script, /'VEM_MAINTENANCE_PASSWORD'/);
    assert.match(script, /'VEM_AUTOLOGON_PASSWORD'/);
    assert.match(script, /'KioskUser' = 'VEMKiosk'/);
    assert.match(script, /'MaintenanceUser' = 'YKDZ'/);
    assert.match(script, /'RunAsUser' = 'YKDZ'/);
    assert.match(script, /'KioskPassword' = \$env:VEM_KIOSK_PASSWORD/);
    assert.match(
      script,
      /'MaintenancePassword' = \$env:VEM_MAINTENANCE_PASSWORD/,
    );
    assert.match(script, /'AutoLogonPassword' = \$env:VEM_AUTOLOGON_PASSWORD/);
    assert.match(script, /\$setupArgs\['ConfigureKioskAccounts'\] = \$true/);
    assert.match(script, /\$setupArgs\['UseKioskAccount'\] = \$true/);
    assert.match(script, /\$setupArgs\['ConfigureAutoLogon'\] = \$true/);
    assert.match(
      script,
      /'DaemonExe' = 'C:\\VEM\\bringup\\vending-daemon.exe'/,
    );
    assert.match(script, /'MachineUiExe' = 'C:\\VEM\\bringup\\machine.exe'/);
    assert.match(
      script,
      /'StartupBringupEvidenceFile' = 'C:\\ProgramData\\VEM\\vending-daemon\\startup-bringup-evidence.json'/,
    );
    assert.match(script, /& \$setupScript @setupArgs/);
    assert.doesNotMatch(script, /1256987/);
    assert.doesNotMatch(script, /AllowBlankAutoLogonPassword/);
  });

  it("passes Controlled Maintenance Ingress allowlist into production setup", () => {
    const plan = buildBringUpPlan({
      maintenanceIngressSourceAllowlist: "10.91.1.10",
    });

    assert.equal(
      plan.arguments.MaintenanceIngressSourceAllowlist,
      "10.91.1.10",
    );
    assert.ok(plan.switches.includes("ConfigureControlledMaintenanceIngress"));

    const script = buildRemotePowerShellScript({
      mode: "bring-up",
      maintenanceIngressSourceAllowlist: "10.91.1.10",
    });

    assert.match(
      script,
      /'MaintenanceIngressSourceAllowlist' = '10\.91\.1\.10'/,
    );
    assert.match(
      script,
      /\$setupArgs\['ConfigureControlledMaintenanceIngress'\] = \$true/,
    );
    assert.doesNotMatch(script, /ConfigureRemoteMaintenanceAccess/);
  });

  it("rejects a reset-plus-bring-up shortcut that would delete the setup script before using it", () => {
    assert.throws(
      () =>
        buildRemotePowerShellScript({
          mode: "inventory-reset-bring-up",
        }),
      /unsupported mode: inventory-reset-bring-up/,
    );

    const script = buildRemotePowerShellScript({ mode: "bring-up" });

    assert.doesNotMatch(script, /inventory-reset-bring-up/);
    assert.match(script, /\$mode -eq "bring-up"/);
    assert.match(script, /Invoke-ProductionBringUp \$bringUpActions/);
    assert.match(script, /inventoryAfterBringUp/);
  });

  it("builds a provision script that claims through daemon IPC without direct secret writes", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
      platformTarget: "vem-vps",
    });

    assert.match(script, /function Invoke-TestbedProvisioningClaim/);
    assert.match(
      script,
      /C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready\.json/,
    );
    assert.match(script, /Authorization = "Bearer \$\(\$ready\.ipcToken\)"/);
    assert.match(
      script,
      /Invoke-IpcJson "GET" "\$baseUrl\/v1\/config\/summary" \$headers/,
    );
    assert.match(script, /Get-ConfigSnapshotFromRuntimeSummary/);
    assert.doesNotMatch(script, /"\$baseUrl\/v1\/config" \$headers/);
    assert.match(
      script,
      /Factory bootstrap provisioning endpoint does not match the isolated Testbed platform/,
    );
    assert.match(script, /preClaimFactoryConfigVerified = \$true/);
    assert.match(
      script,
      /Invoke-IpcJson "GET" "\$baseUrl\/v1\/bring-up" \$headers/,
    );
    assert.match(script, /mutation = \[ordered\]@\{ type = "probe_network" \}/);
    assert.match(script, /networkProbe = \[ordered\]@\{/);
    assert.match(script, /daemon IPC existing-network probe failed/);
    assert.match(script, /taskId = \[string\]\$currentTask\.taskId/);
    assert.match(script, /taskVersion = \[uint64\]\$currentTask\.taskVersion/);
    assert.match(script, /kind = \[string\]\$currentTask\.kind/);
    assert.match(script, /intent = \[string\]\$currentTask\.intent/);
    assert.match(
      script,
      /Invoke-IpcJson "POST" "\$baseUrl\/v1\/bring-up\/tasks\/execute"/,
    );
    assert.match(script, /usedDaemonIpcTaskExecute = \$true/);
    assert.match(script, /machineCode = \$claimResult\.machineCode/);
    assert.match(script, /provisioned = \$configEvidence\.provisioned/);
    assert.match(script, /claimResult = \[ordered\]@{/);
    assert.match(script, /restartRequested = \$null/);
    assert.match(script, /credentialFlags = \[ordered\]@{/);
    assert.match(script, /machineSecretConfigured = \$false/);
    assert.match(script, /mqttSigningSecretConfigured = \$false/);
    assert.match(script, /mqttPasswordConfigured = \$false/);
    assert.match(script, /provisioningIssues = @\(\)/);
    assert.match(script, /healthzAfterClaim = Get-SafeHealthzEvidence/);
    assert.match(script, /readyzAfterClaim = Get-SafeReadyzEvidence/);
    assert.match(script, /testbed-provisioning-evidence\.json/);
    assert.match(script, /Set-Content -LiteralPath \$provisioningEvidencePath/);
    assert.doesNotMatch(script, /machineSecret\s*=/);
    assert.doesNotMatch(script, /mqttSigningSecret\s*=/);
    assert.doesNotMatch(script, /mqttPassword\s*=/);
    assert.doesNotMatch(script, /vms_local/);
  });

  it("uses the daemon cursor to probe the existing network before obtaining the claim cursor", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
      platformTarget: "vem-vps",
    });
    const waitFunctionStart = script.indexOf("function Wait-DaemonIpc(");
    const provisioningStart = script.indexOf(
      "function Invoke-TestbedProvisioningClaim($Actions)",
    );
    const daemonIpcWait = script.indexOf(
      "$daemonIpc = Wait-DaemonIpc ",
      provisioningStart,
    );
    const configRead = script.indexOf(
      'Invoke-IpcJson "GET" "$baseUrl/v1/config/summary" $headers',
      provisioningStart,
    );
    const taskSnapshot = script.indexOf(
      'Invoke-IpcJson "GET" "$baseUrl/v1/bring-up" $headers',
      provisioningStart,
    );
    const networkProbe = script.indexOf(
      'Invoke-IpcJson "POST" "$baseUrl/v1/bring-up/tasks/execute" $headers $probePayload',
      provisioningStart,
    );
    const claimTaskSnapshot = script.indexOf(
      'Invoke-IpcJson "GET" "$baseUrl/v1/bring-up" $headers',
      taskSnapshot + 1,
    );
    const claim = script.indexOf(
      'Invoke-IpcJson "POST" "$baseUrl/v1/bring-up/tasks/execute" $headers $claimPayload',
      provisioningStart,
    );
    const generationSnapshot = script.indexOf(
      "$preClaimReadyGeneration = [long](Get-Item ",
      provisioningStart,
    );
    const convergence = script.indexOf(
      "$recoveredIpc = Wait-DaemonIpcAfterProvisioning ",
      provisioningStart,
    );
    const claimHttpCatch = script.indexOf("} catch {", claim);
    const waitFunction = script.slice(waitFunctionStart, provisioningStart);
    const serviceStart = waitFunction.indexOf(
      'Start-Service -Name "VemVendingDaemon"',
    );
    const readyRead = waitFunction.indexOf("Read-JsonFile $ReadyFilePath");
    const healthz = waitFunction.indexOf(
      'Invoke-IpcJson "GET" "$baseUrl/healthz" @{}',
    );

    assert.notEqual(waitFunctionStart, -1);
    assert.ok(serviceStart >= 0);
    assert.ok(serviceStart < readyRead);
    assert.ok(readyRead < healthz);
    assert.ok(daemonIpcWait >= provisioningStart);
    assert.ok(daemonIpcWait < configRead);
    assert.ok(configRead < taskSnapshot);
    assert.ok(taskSnapshot < networkProbe);
    assert.ok(networkProbe < claimTaskSnapshot);
    assert.ok(claimTaskSnapshot < claim);
    assert.ok(claimTaskSnapshot < generationSnapshot);
    assert.ok(generationSnapshot < claim);
    assert.ok(claim < claimHttpCatch);
    assert.ok(claimHttpCatch < convergence);
    assert.match(
      script,
      /if \(-not \[bool\]\$evidence\.claimResult\.restartRequested\) \{/,
    );
    assert.match(
      script,
      /throw "daemon Claim did not request the required runtime reconfigure"/,
    );
    assert.match(
      script,
      /\$RecoveryEvidence\["runtimeReconfigureObserved"\] = \$true/,
    );
    assert.match(
      script,
      /\$RecoveryEvidence\["recoveredAfterReconfigure"\] = \$true/,
    );
    assert.match(script, /recoveryFailure = \$_\.Exception\.Message/);
    assert.match(script, /claimStatus = "provisioned"/);
    assert.match(script, /claimHttpStatus = 200/);
  });

  it("starts a stopped daemon service and waits for delayed IPC readiness", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });
    const result = runPowerShellSemanticHarness(
      extractPowerShellFunction(script, "Wait-DaemonIpc"),
      `
$calls = [System.Collections.Generic.List[string]]::new()
$serviceChecks = 0
$readyReads = 0

function Get-Service {
  param([string]$Name, $ErrorAction)
  $calls.Add("get-service")
  $script:serviceChecks += 1
  [pscustomobject]@{ Status = if ($script:serviceChecks -eq 1) { "Stopped" } else { "Running" } }
}

function Start-Service {
  param([string]$Name, $ErrorAction)
  $calls.Add("start-service")
}

function Read-JsonFile {
  param([string]$Path)
  $calls.Add("read-ready")
  $script:readyReads += 1
  if ($script:readyReads -eq 1) { throw "ready file not yet published" }
  [pscustomobject]@{ ipcToken = "token"; healthzUrl = "http://127.0.0.1:7891/healthz" }
}

function Get-IpcBaseUrl { param($Ready) "http://127.0.0.1:7891" }
function Invoke-IpcJson {
  param([string]$Method, [string]$Uri, $Headers, $Body = $null, [int]$TimeoutSec = 20)
  $calls.Add("health:$TimeoutSec")
  [pscustomobject]@{ status = "ok" }
}
function Start-Sleep {
  param([int]$Milliseconds)
  $calls.Add("sleep:$Milliseconds")
}

$daemonIpc = Wait-DaemonIpc "C:\\daemon-ready.json" 3 1
@{ calls = @($calls); attempts = $daemonIpc.attempts; observedHealth = $daemonIpc.observedHealth } | ConvertTo-Json -Compress
`,
    );

    assert.deepEqual(result.calls, [
      "get-service",
      "start-service",
      "read-ready",
      "sleep:1",
      "get-service",
      "read-ready",
      "health:2",
    ]);
    assert.equal(result.attempts, 2);
    assert.equal(result.observedHealth, true);
    assert.match(script, /\[int\]\$MaxAttempts = 20/);
    assert.match(script, /\[int\]\$RetryDelayMilliseconds = 1000/);
    assert.match(
      script,
      /Invoke-IpcJson "GET" "\$baseUrl\/healthz" @\{\} -TimeoutSec 2/,
    );
  });

  it("retains Start-Service failures in the daemon IPC diagnostic", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });
    const result = runPowerShellSemanticHarness(
      extractPowerShellFunction(script, "Wait-DaemonIpc"),
      `
$calls = [System.Collections.Generic.List[string]]::new()
function Get-Service {
  param([string]$Name, $ErrorAction)
  $calls.Add("get-service")
  [pscustomobject]@{ Status = "Stopped" }
}
function Start-Service {
  param([string]$Name, $ErrorAction)
  $calls.Add("start-service")
  throw "SCM access denied"
}
function Read-JsonFile { throw "ready file must not be read after Start-Service fails" }
function Get-IpcBaseUrl { throw "not reached" }
function Invoke-IpcJson { throw "not reached" }
function Start-Sleep {
  param([int]$Milliseconds)
  $calls.Add("sleep:$Milliseconds")
}

$failure = $null
try {
  Wait-DaemonIpc "C:\\daemon-ready.json" 2 1 | Out-Null
} catch {
  $failure = $_.Exception.Message
}
@{ calls = @($calls); failure = $failure } | ConvertTo-Json -Compress
`,
    );

    assert.deepEqual(result.calls, [
      "get-service",
      "start-service",
      "sleep:1",
      "get-service",
      "start-service",
    ]);
    assert.match(result.failure, /Start-Service.*SCM access denied/);
    assert.match(result.failure, /last service start error.*SCM access denied/);
  });

  it("observes a new ready-file generation before accepting daemon-owned post-claim recovery", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });
    const result = runPowerShellSemanticHarness(
      `${extractPowerShellFunction(script, "Get-ConfigSnapshotFromRuntimeSummary")}\n${extractPowerShellFunction(script, "Wait-DaemonIpcAfterProvisioning")}`,
      `
$calls = [System.Collections.Generic.List[string]]::new()
$calls.Add("claim")
$recovery = [ordered]@{
  runtimeReconfigureObserved = $false
  previousReadyGeneration = $null
  observedReadyGeneration = $null
  observedHealthAfterReconfigure = $null
  observedMachineCodeAfterReconfigure = $null
  observedProvisionedAfterReconfigure = $null
  recoveredAfterReconfigure = $null
  recoveryAttempts = $null
  recoveryEvidence = $null
}
function Get-Service {
  param([string]$Name, $ErrorAction)
  $calls.Add("get-service")
  [pscustomobject]@{ Status = "Running" }
}
function Get-Item {
  param([string]$LiteralPath, $ErrorAction)
  $calls.Add("get-ready-generation")
  $generation = if (($calls | Where-Object { $_ -eq "get-ready-generation" }).Count -eq 1) { 100 } else { 101 }
  [pscustomobject]@{ LastWriteTimeUtc = [pscustomobject]@{ Ticks = $generation } }
}
function Read-JsonFile {
  param([string]$Path)
  $calls.Add("read-ready")
  [pscustomobject]@{ ipcToken = "token-2"; healthzUrl = "http://127.0.0.1:7891/healthz" }
}
function Get-IpcBaseUrl { param($Ready) "http://127.0.0.1:7891" }
function Invoke-IpcJson {
  param([string]$Method, [string]$Uri, $Headers, $Body = $null, [int]$TimeoutSec = 20)
  if ($Uri.EndsWith("/healthz")) {
    $calls.Add("health:$TimeoutSec")
    return [pscustomobject]@{ status = "ok" }
  }
  $calls.Add("summary:$TimeoutSec")
  [pscustomobject]@{
    effectivePublic = [pscustomobject]@{ machineCode = "VEM-TESTBED-WINVM-01"; mqttUsername = $null }
    configuredState = [pscustomobject]@{
      provisioningProfileCache = $true
      machineSecretConfigured = $true
      mqttSigningSecretConfigured = $true
      mqttPasswordConfigured = $false
      maintenancePinConfigured = $true
      factoryManifest = $true
    }
  }
}
function Start-Sleep {
  param([int]$Milliseconds)
  $calls.Add("sleep:$Milliseconds")
}

$daemonIpc = Wait-DaemonIpcAfterProvisioning "C:\\daemon-ready.json" 100 "VEM-TESTBED-WINVM-01" $recovery 3000 1
@{
  calls = @($calls)
  recovered = $daemonIpc.recovered
  attempts = $daemonIpc.attempts
  recoveryEvidence = $daemonIpc.recoveryEvidence
  persistedEvidence = $recovery
} | ConvertTo-Json -Compress
`,
    );

    assert.deepEqual(result.calls, [
      "claim",
      "get-service",
      "get-ready-generation",
      "sleep:1",
      "get-service",
      "get-ready-generation",
      "read-ready",
      "health:2",
      "summary:2",
    ]);
    assert.equal(result.recovered, true);
    assert.equal(result.attempts, 2);
    assert.equal(
      result.recoveryEvidence,
      "daemon_ready_generation_advanced_then_runtime_healthy",
    );
    assert.equal(result.persistedEvidence.previousReadyGeneration, 100);
    assert.equal(result.persistedEvidence.observedReadyGeneration, 101);
    assert.equal(result.persistedEvidence.runtimeReconfigureObserved, true);
    assert.equal(result.persistedEvidence.observedHealthAfterReconfigure, true);
    assert.equal(
      result.persistedEvidence.observedMachineCodeAfterReconfigure,
      "VEM-TESTBED-WINVM-01",
    );
    assert.equal(
      result.persistedEvidence.observedProvisionedAfterReconfigure,
      true,
    );
    assert.equal(result.persistedEvidence.recoveredAfterReconfigure, true);
    const waitFunction = extractPowerShellFunction(
      script,
      "Wait-DaemonIpcAfterProvisioning",
    );
    assert.doesNotMatch(waitFunction, /Start-Service|Restart-Service/);
  });

  it("fails post-claim recovery when the daemon service leaves Running", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });
    const result = runPowerShellSemanticHarness(
      `${extractPowerShellFunction(script, "Get-ConfigSnapshotFromRuntimeSummary")}\n${extractPowerShellFunction(script, "Wait-DaemonIpcAfterProvisioning")}`,
      `
$calls = [System.Collections.Generic.List[string]]::new()
$calls.Add("claim")
$recovery = [ordered]@{ runtimeReconfigureObserved = $false }
function Get-Service {
  param([string]$Name, $ErrorAction)
  $calls.Add("get-service")
  [pscustomobject]@{ Status = "Stopped" }
}
function Get-Item { throw "not reached" }
function Read-JsonFile { throw "not reached" }
function Get-IpcBaseUrl { throw "not reached" }
function Invoke-IpcJson { throw "not reached" }
function Start-Sleep { throw "not reached" }

$failure = $null
try {
  Wait-DaemonIpcAfterProvisioning "C:\\daemon-ready.json" 100 "VEM-TESTBED-WINVM-01" $recovery 3000 1 | Out-Null
} catch {
  $failure = $_.Exception.Message
}
@{ calls = @($calls); failure = $failure } | ConvertTo-Json -Compress
`,
    );

    assert.deepEqual(result.calls, ["claim", "get-service"]);
    assert.match(result.failure, /left Running during post-claim reconfigure/);
  });

  for (const fixture of [
    {
      name: "ready generation does not advance",
      generation: 100,
      machineCode: "VEM-TESTBED-WINVM-01",
      provisioned: true,
      expected: /ready generation has not advanced/,
    },
    {
      name: "runtime exposes the wrong machine code",
      generation: 101,
      machineCode: "WRONG-MACHINE",
      provisioned: true,
      expected: /daemon runtime machineCode is WRONG-MACHINE/,
    },
    {
      name: "runtime is not provisioned",
      generation: 101,
      machineCode: "VEM-TESTBED-WINVM-01",
      provisioned: false,
      expected: /daemon runtime config is not provisioned/,
    },
  ]) {
    it(`fails closed when post-claim ${fixture.name}`, () => {
      const script = buildRemotePowerShellScript({
        mode: "provision",
        claimCode: "ABCD-2345",
        machineCode: "VEM-TESTBED-WINVM-01",
      });
      const result = runPowerShellSemanticHarness(
        `${extractPowerShellFunction(script, "Get-ConfigSnapshotFromRuntimeSummary")}\n${extractPowerShellFunction(script, "Wait-DaemonIpcAfterProvisioning")}`,
        `
$recovery = [ordered]@{ runtimeReconfigureObserved = $false }
function Get-Service { [pscustomobject]@{ Status = "Running" } }
function Get-Item { [pscustomobject]@{ LastWriteTimeUtc = [pscustomobject]@{ Ticks = ${fixture.generation} } } }
function Read-JsonFile { [pscustomobject]@{ ipcToken = "token"; healthzUrl = "http://127.0.0.1:7891/healthz" } }
function Get-IpcBaseUrl { "http://127.0.0.1:7891" }
function Invoke-IpcJson {
  param([string]$Method, [string]$Uri)
  if ($Uri.EndsWith("/healthz")) { return [pscustomobject]@{ status = "ok" } }
  [pscustomobject]@{
    effectivePublic = [pscustomobject]@{ machineCode = ${JSON.stringify(fixture.machineCode)}; mqttUsername = $null }
    configuredState = [pscustomobject]@{
      provisioningProfileCache = ${fixture.provisioned ? "$true" : "$false"}
      machineSecretConfigured = ${fixture.provisioned ? "$true" : "$false"}
      mqttSigningSecretConfigured = ${fixture.provisioned ? "$true" : "$false"}
      mqttPasswordConfigured = $false
      maintenancePinConfigured = ${fixture.provisioned ? "$true" : "$false"}
      factoryManifest = $true
    }
  }
}
$failure = $null
try {
  Wait-DaemonIpcAfterProvisioning "C:\\daemon-ready.json" 100 "VEM-TESTBED-WINVM-01" $recovery 20 1 | Out-Null
} catch { $failure = $_.Exception.Message }
@{ failure = $failure; recovery = $recovery } | ConvertTo-Json -Compress
`,
      );

      assert.match(result.failure, /did not converge within 20 ms/);
      assert.match(result.failure, fixture.expected);
      assert.equal(result.recovery.observedReadyGeneration, fixture.generation);
      assert.equal(
        result.recovery.runtimeReconfigureObserved,
        fixture.generation > 100,
      );
    });
  }

  it("emits provision diagnostics for missing ready file and token failures", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(
      script,
      /Read-JsonFile 'C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready\.json'/,
    );
    assert.match(script, /throw "file not found: \$Path"/);
    assert.match(script, /ipcToken missing from daemon ready file/);
    assert.match(script, /healthzUrl missing from daemon ready file/);
    assert.match(script, /invalid healthzUrl in daemon ready file/);
  });

  it("classifies failed daemon IPC claim responses in provision evidence", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Get-HttpErrorInfo/);
    assert.match(script, /function Convert-ClaimFailureClassification/);
    assert.match(script, /claimStatus = "failed"/);
    assert.match(
      script,
      /claimFailureCode = Convert-ClaimFailureClassification \$claimError/,
    );
    assert.match(script, /claimHttpStatus = \$claimError.statusCode/);
    assert.match(
      script,
      /Invoke-IpcJson "GET" "\$baseUrl\/v1\/maintenance\/status" \$headers/,
    );
    assert.match(script, /maintenanceStatusAfterClaimFailure\.lastError = if/);
    assert.match(
      script,
      /daemon IPC claim failed: \$\(\$evidence.claimFailureCode\)/,
    );
    assert.match(script, /claimStatus = "provisioned"/);
  });

  it("rejects non-testbed identities before generating provisioning orchestration", () => {
    assert.throws(
      () =>
        buildRemotePowerShellScript({
          mode: "provision",
          claimCode: "ABCD-2345",
          machineCode: "VEM-WIN10-REAL-01",
        }),
      /dedicated testbed identity/,
    );

    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(
      script,
      /refusing to provision over non-testbed configured identity/,
    );
    assert.match(script, /daemon IPC claim returned non-testbed identity/);
    assert.match(
      script,
      /daemon IPC claim returned unexpected testbed identity/,
    );
  });

  it("derives provisioning facts from daemon config and actual claim action evidence", () => {
    assert.deepEqual(
      buildProvisioningFacts({
        configSnapshot: {
          provisioned: true,
          public: { machineCode: "VEM-TESTBED-WINVM-01" },
          machineSecretConfigured: true,
          mqttSigningSecretConfigured: true,
          mqttPasswordConfigured: false,
          provisioningIssues: [],
        },
        actions: [
          {
            evidence: {
              usedDaemonIpcTaskExecute: true,
              endpoint: "http://127.0.0.1:3921/v1/bring-up/tasks/execute",
              claimStatus: "provisioned",
            },
          },
        ],
      }),
      {
        provisioned: true,
        usedDaemonIpcTaskExecute: true,
        machineCode: "VEM-TESTBED-WINVM-01",
        machineSecretConfigured: true,
        mqttSigningSecretConfigured: true,
        mqttPasswordConfigured: false,
        provisioningIssues: [],
      },
    );

    assert.equal(
      buildProvisioningFacts({
        configSnapshot: { provisioned: false, public: {} },
        actions: [
          {
            evidence: {
              usedDaemonIpcTaskExecute: true,
              endpoint: "http://127.0.0.1:3921/v1/config",
              claimStatus: "not_attempted",
            },
          },
        ],
      }).usedDaemonIpcTaskExecute,
      false,
    );
    assert.equal(
      buildProvisioningFacts({
        configSnapshot: {
          provisioned: false,
          public: {},
          provisioningIssues: ["machine_profile_persistence_failed"],
        },
        actions: [
          {
            evidence: {
              usedDaemonIpcTaskExecute: true,
              endpoint: "http://127.0.0.1:3921/v1/bring-up/tasks/execute",
              claimStatus: "failed",
              claimFailureCode: "machine_profile_persistence_failed",
            },
          },
        ],
      }).usedDaemonIpcTaskExecute,
      true,
    );
  });

  it("requires same-run non-shared ephemeral platform setup evidence for sale-flow mode", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-ephemeral-evidence-"));
    try {
      const evidencePath = join(temp, "ephemeral-platform.json");
      writeFileSync(
        evidencePath,
        JSON.stringify(ephemeralPlatformEvidence()),
        "utf8",
      );

      assert.deepEqual(
        readEphemeralPlatformSetupEvidence({
          mode: "simulated-hardware-sale-flow",
          runId: "RUN-180",
          machineCode: "VEM-TESTBED-WINVM-01",
          platformTarget: "ephemeral-run-180",
          ephemeralPlatformEvidence: evidencePath,
        }),
        {
          status: "prepared",
          runId: "RUN-180",
          target: "ephemeral-run-180",
          machineCode: "VEM-TESTBED-WINVM-01",
          apiBaseUrl: "http://127.0.0.1:26849/api",
          mqttUrl: "mqtt://127.0.0.1:1883",
          claimCode: "ABCD-2345",
          claimCodeId: "claim-180",
          claimPath: "/api/machines/claim",
          mockPaymentReady: true,
          hardwareTopologyIdentity: "vem-prod-24",
          hardwareTopologyVersion: "2026-06-adr0026",
          planogramVersion: "TESTBED-RUN-180",
        },
      );

      assert.throws(
        () =>
          readEphemeralPlatformSetupEvidence({
            mode: "simulated-hardware-sale-flow",
            runId: "OLDER-RUN",
            machineCode: "VEM-TESTBED-WINVM-01",
            platformTarget: "ephemeral-run-180",
            ephemeralPlatformEvidence: evidencePath,
          }),
        /same run id/,
      );

      assert.throws(
        () =>
          readEphemeralPlatformSetupEvidence({
            mode: "simulated-hardware-sale-flow",
            runId: "RUN-180",
            machineCode: "VEM-TESTBED-WINVM-01",
            platformTarget: "vem-vps",
            ephemeralPlatformEvidence: evidencePath,
          }),
        /shared platform target/,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("allows provision to use same-run ephemeral target evidence instead of the static allowlist", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-provision-evidence-"));
    try {
      const evidencePath = join(root, "ephemeral-platform.json");
      writeFileSync(
        evidencePath,
        JSON.stringify(ephemeralPlatformEvidence()),
        "utf8",
      );
      const script = buildRemotePowerShellScript({
        mode: "provision",
        runId: "RUN-180",
        machineCode: "VEM-TESTBED-WINVM-01",
        platformTarget: "ephemeral-run-180",
        ephemeralPlatformEvidence: evidencePath,
      });
      assert.match(script, /http:\/\/127\.0\.0\.1:26849\/api/);
      assert.match(script, /mqtt:\/\/127\.0\.0\.1:1883/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a read-only preclaim verifier from the Factory ISO-installed verifier", () => {
    const script = buildFactoryPreclaimVerificationScript({
      runId: "RUN-180",
      machineCode: "VEM-TESTBED-WINVM-01",
    });
    assert.match(
      script,
      /C:\\VEM\\bringup\\scripts\\verify-factory-runtime\.ps1/,
    );
    assert.match(script, /factory-preclaim-verification\/v1/);
    assert.match(
      script,
      /failureCount = @\(\$factoryVerification\.failures\)\.Count/,
    );
    assert.match(script, /failures = @\(\$factoryVerification\.failures/);
    assert.match(
      script,
      /machineUiStartup = \$factoryVerification\.checks\.machineUiStartup/,
    );
    assert.doesNotMatch(
      script,
      /machineUiTask = \$factoryVerification\.checks\.machineUiTask/,
    );
    assert.match(script, /absentMachineIdentity/);
    assert.match(script, /oobe-bootstrap-status\.json/);
    assert.match(script, /OOBEInProgress/);
    assert.match(script, /SystemSetupInProgress/);
    assert.match(script, /VEMFactoryOobeCleanup/);
    assert.match(script, /VEM_PERSONALIZATION/);
    assert.match(script, /oobe-unattend\.xml/);
    assert.match(script, /oobe-kiosk-autologon-password/);
    assert.match(script, /retainedKioskAutologonHandoffPresent/);
    assert.match(script, /-not \$retainedKioskAutologonHandoffPresent/);
    assert.match(script, /Get-LocalUser -Name 'VEMOobeBootstrap'/);
    assert.match(script, /oobe-cleanup-status\.json/);
    assert.match(script, /cleanupStatus\.phase -ceq 'complete'/);
    assert.match(script, /rebootOriginBootIdentity/);
    assert.match(script, /Win32_OperatingSystem/);
    assert.match(
      script,
      /\$completedBootIdentity -cne \$rebootOriginBootIdentity/,
    );
    assert.match(
      script,
      /\$currentBootIdentity -cne \$rebootOriginBootIdentity/,
    );
    assert.doesNotMatch(
      script,
      /\[string\]\$cleanupStatus\.completedBootIdentity -ceq \[string\]\$currentBootIdentity/,
    );
    assert.match(script, /postRebootBootIdentityChanged = \$cleanupComplete/);
    assert.match(script, /Win32_ComputerSystem/);
    assert.match(script, /activeVemKioskConsoleSession/);
    assert.match(script, /-and \$oobeComplete/);
    assert.match(script, /AddMinutes\(30\)/);
    assert.match(script, /Start-Sleep -Seconds 10/);
    assert.doesNotMatch(script, /prepare-factory-runtime\.ps1/);
  });

  it("accepts an unclaimed factory machine config but rejects retained identity or credentials", () => {
    const script = buildFactoryPreclaimVerificationScript({
      runId: "RUN-180",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(
      script,
      /Get-Content -LiteralPath \$machineConfigPath -Raw \| ConvertFrom-Json/,
    );
    assert.match(script, /\$null -eq \$machineCodeProperty\.Value/);
    assert.match(script, /machineCode.*machineId.*machineName.*mqttClientId/s);
    assert.match(
      script,
      /machineSecret.*mqttSigningSecret.*mqttPassword.*mqttUsername/s,
    );
    assert.match(script, /\$machineConfig\.unclaimed =/);
    assert.match(script, /machineConfig = \[ordered\]@\{/);
    assert.doesNotMatch(script, /\$identityPaths = .*machine-config\.json/s);
  });

  it("classifies sale-flow target mismatches before mutation is allowed", () => {
    assert.deepEqual(
      assertSimulatedSaleFlowPreMutationTarget({
        target: {
          machineCode: "VEM-TESTBED-WINVM-01",
          platformTarget: "ephemeral-run-180",
        },
        daemonMachineCode: "VEM-TESTBED-WINVM-01",
        daemonApiBaseUrl: "http://127.0.0.1:26849/api",
        daemonMqttUrl: "mqtt://127.0.0.1:1883",
        hardwareMode: "simulated",
        platformSetup: {
          target: "ephemeral-run-180",
          apiBaseUrl: "http://127.0.0.1:26849/api",
          mqttUrl: "mqtt://127.0.0.1:1883",
          evidenceStatus: "prepared",
        },
      }),
      { ok: true, code: "pre_mutation_target_verified" },
    );

    for (const [overrides, code] of [
      [
        { daemonMachineCode: "VEM-TESTBED-OLD-01" },
        "daemon_machine_identity_mismatch",
      ],
      [
        { daemonApiBaseUrl: "http://127.0.0.1:9999/api" },
        "ephemeral_platform_target_mismatch",
      ],
      [{ hardwareMode: "production" }, "simulated_hardware_mode_required"],
      [
        {
          platformSetup: {
            target: "vem-vps",
            apiBaseUrl: "http://118.25.104.160:26849/api",
            mqttUrl: "mqtt://118.25.104.160:1883",
            evidenceStatus: "prepared",
          },
        },
        "shared_platform_target_rejected",
      ],
      [
        {
          platformSetup: {
            target: "ephemeral-run-180",
            apiBaseUrl: "http://127.0.0.1:26849/api",
            mqttUrl: "mqtt://127.0.0.1:1883",
            evidenceStatus: "missing",
          },
        },
        "ephemeral_platform_evidence_required",
      ],
    ]) {
      const result = assertSimulatedSaleFlowPreMutationTarget({
        target: {
          machineCode: "VEM-TESTBED-WINVM-01",
          platformTarget: "ephemeral-run-180",
        },
        daemonMachineCode: "VEM-TESTBED-WINVM-01",
        daemonApiBaseUrl: "http://127.0.0.1:26849/api",
        daemonMqttUrl: "mqtt://127.0.0.1:1883",
        hardwareMode: "simulated",
        platformSetup: {
          target: "ephemeral-run-180",
          apiBaseUrl: "http://127.0.0.1:26849/api",
          mqttUrl: "mqtt://127.0.0.1:1883",
          evidenceStatus: "prepared",
        },
        ...overrides,
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, code);
    }
  });

  it("summarizes daemon ready evidence for missing ready, token, and endpoint failures", () => {
    assert.deepEqual(buildReadyFileEvidence(null), {
      exists: false,
      ipcEndpointPresent: false,
      tokenPresent: false,
      error: "ready_file_missing",
    });
    assert.deepEqual(
      buildReadyFileEvidence({
        healthzUrl: "http://127.0.0.1:3921/healthz",
      }),
      {
        exists: true,
        ipcEndpointPresent: true,
        tokenPresent: false,
        error: "ipc_token_missing",
      },
    );
    assert.deepEqual(
      buildReadyFileEvidence({
        ipcToken: "token-1",
        healthzUrl: "http://127.0.0.1:3921/status",
      }),
      {
        exists: true,
        ipcEndpointPresent: true,
        tokenPresent: true,
        error: "healthz_url_invalid",
      },
    );
  });

  it("rejects stale real or testbed config before first-claim provisioning", () => {
    assert.deepEqual(evaluateFirstClaimPrecondition({ public: {} }), {
      ok: true,
      code: "ready_for_first_claim",
      message: null,
    });
    assert.equal(
      evaluateFirstClaimPrecondition({
        provisioned: true,
        public: { machineCode: "VEM-TESTBED-WINVM-01" },
      }).code,
      "already_provisioned",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: {},
        machineSecretConfigured: true,
      }).code,
      "credentials_configured",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: { machineCode: "VEM-WIN10-REAL-01" },
      }).code,
      "non_testbed_identity",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: { machineCode: "VEM-TESTBED-OLD-01" },
      }).code,
      "stale_final_identity",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: {
          runtimeEndpoints: { machineApiBasePath: "/api/machines/M001" },
        },
      }).code,
      "stale_final_identity",
    );
  });

  it("builds pre-claim public config with platform endpoints and no final identity/profile fields", () => {
    assert.deepEqual(
      buildPreClaimPublicConfig(
        {
          machineCode: "VEM-TESTBED-OLD-01",
          machineId: "machine-id",
          machineName: "old",
          machineStatus: "active",
          machineLocationLabel: "old site",
          apiBaseUrl: "http://old/api",
          mqttUrl: "mqtt://old",
          mqttUsername: "old-user",
          mqttClientId: "old-client",
          hardwareAdapter: "serial",
          scannerAdapter: "serial_text",
          runtimeEndpoints: { machineApiBasePath: "/api/machines/old" },
          hardwareProfile: { profile: "production" },
          paymentCapability: { profile: "production" },
          provisioningMetadata: { profileVersion: 1 },
        },
        {
          apiBaseUrl: "http://118.25.104.160:26849/api",
          mqttUrl: "mqtt://118.25.104.160:1883",
        },
      ),
      {
        machineCode: null,
        machineId: null,
        machineName: null,
        machineStatus: null,
        machineLocationLabel: null,
        apiBaseUrl: "http://118.25.104.160:26849/api",
        mqttUrl: "mqtt://118.25.104.160:1883",
        mqttUsername: null,
        mqttClientId: null,
        hardwareAdapter: "serial",
        scannerAdapter: "serial_text",
        runtimeEndpoints: null,
        hardwareProfile: null,
        paymentCapability: null,
        provisioningMetadata: null,
      },
    );
  });

  it("classifies provision claim failures without exposing claim codes or secrets", () => {
    assert.equal(
      classifyProvisioningFailure({
        statusCode: 400,
        body: { code: "machine_claim_invalid_or_expired" },
      }),
      "machine_claim_invalid_or_expired",
    );
    assert.equal(
      classifyProvisioningFailure({
        statusCode: 503,
        body: { code: "machine_claim_backend_unavailable" },
      }),
      "machine_claim_backend_unavailable",
    );
    assert.equal(
      classifyProvisioningFailure({
        statusCode: 500,
        body: { code: "machine_profile_persistence_failed" },
      }),
      "machine_profile_persistence_failed",
    );
    assert.equal(classifyProvisioningFailure({ statusCode: 502 }), "http_502");
    assert.equal(classifyProvisioningFailure({}), "request_failed");
  });

  it("builds a full runtime acceptance report workflow that saves VM evidence for pullback", () => {
    const script = buildRemotePowerShellScript({
      mode: "runtime-acceptance",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Get-RuntimeAcceptanceReport/);
    assert.match(script, /Get-PersistedProvisioningActions/);
    assert.match(script, /runtimeAcceptanceReportPath/);
    assert.match(
      script,
      /C:\\ProgramData\\VEM\\vending-daemon\\runtime-acceptance-report\.json/,
    );
    assert.match(script, /artifacts = \[ordered\]@{/);
    assert.match(script, /daemonSha256 = Get-ArtifactSha256/);
    assert.match(script, /machineUiSha256 = Get-ArtifactSha256/);
    assert.match(script, /daemonRuntime = \[ordered\]@{/);
    assert.match(script, /healthz = \$daemonRuntime.healthz/);
    assert.match(script, /readyz = \$daemonRuntime.readyz/);
    assert.match(
      script,
      /kioskDesktopEscape = \$factsSubset.kioskDesktopEscape/,
    );
    assert.match(script, /Classify-RuntimeAcceptanceReport/);
    assert.match(script, /simulatedHardwareReady = \[ordered\]@{/);
    assert.match(script, /sellReady = \[ordered\]@{/);
    assert.match(script, /status = "not_asserted"/);
    assert.match(
      script,
      /Set-Content -LiteralPath \$runtimeAcceptanceReportPath/,
    );
    assert.match(script, /runtimeAcceptanceReport = \$runtimeAcceptanceReport/);
  });

  it("builds a simulated hardware sale-flow workflow with distinct readiness evidence", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-sale-flow-evidence-"));
    let script;
    try {
      const evidencePath = join(temp, "ephemeral-platform.json");
      writeFileSync(
        evidencePath,
        JSON.stringify(ephemeralPlatformEvidence()),
        "utf8",
      );

      assert.throws(
        () =>
          buildRemotePowerShellScript({
            mode: "simulated-hardware-sale-flow",
            platformTarget: "ephemeral-run-180",
            machineCode: "VEM-TESTBED-WINVM-01",
            runId: "RUN-180",
          }),
        /requires --ephemeral-platform-evidence/,
      );

      assert.throws(
        () =>
          buildRemotePowerShellScript({
            mode: "simulated-hardware-sale-flow",
            platformTarget: "vem-vps",
            machineCode: "VEM-TESTBED-WINVM-01",
            runId: "RUN-180",
            ephemeralPlatformEvidence: evidencePath,
          }),
        /shared platform target/,
      );

      script = buildRemotePowerShellScript({
        mode: "simulated-hardware-sale-flow",
        platformTarget: "ephemeral-run-180",
        machineCode: "VEM-TESTBED-WINVM-01",
        runId: "RUN-180",
        ephemeralPlatformEvidence: evidencePath,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }

    assert.match(script, /function Invoke-SimulatedHardwareSaleFlow/);
    assert.match(script, /function Classify-SimulatedHardwareSaleFlowReport/);
    assert.match(script, /function Assert-SimulatedSaleFlowPreMutationTarget/);
    const fixtureStart = script.indexOf(
      "function Invoke-SimulatedHardwareSaleFlow(",
    );
    const fixtureEnd = script.indexOf(
      "\nfunction Invoke-ResetStep",
      fixtureStart,
    );
    assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart);
    const fixtureFlow = script.slice(fixtureStart, fixtureEnd);
    assert.match(script, /simulated-hardware-sale-flow\.json/);
    assert.match(script, /schemaVersion = "simulated-hardware-sale-flow\/v1"/);
    assert.match(script, /hardwareMode = if \(\$null -ne \$bringUp/);
    assert.match(script, /\$Facts\.runtimeState\.hardwareMode -ne "simulated"/);
    assert.match(script, /bringUpState = if \(\$null -ne \$bringUp/);
    assert.match(
      script,
      /hardwareOnline = \[bool\]\$daemonIpc\.healthz\.hardwareOnline/,
    );
    assert.match(
      script,
      /scannerOnline = \[bool\]\$daemonIpc\.healthz\.scannerOnline/,
    );
    assert.match(script, /daemonHealth = \$facts\.daemonHealth/);
    assert.match(script, /hardwareMappingFaultProbeRequired/);
    assert.match(
      fixtureFlow,
      /fixture-only sale setup requires healthy serial hardware before customer checkout/,
    );
    assert.match(
      script,
      /\$Facts\.runtimeState\.bringUpState -ne "simulated_hardware_ready"/,
    );
    assert.match(
      script,
      /Invoke-IpcJson "POST" "\$baseUrl\/v1\/stock\/planogram\/sync"/,
    );
    assert.match(
      script,
      /Invoke-IpcJson "POST" "\$baseUrl\/v1\/stock\/attestation"/,
    );
    assert.match(script, /function Wait-PlatformAcceptedStockAttestation/);
    assert.match(
      script,
      /\$stockAcceptance = Wait-PlatformAcceptedStockAttestation/,
    );
    assert.match(
      script,
      /PHYSICAL_STOCK_ATTESTATION_PENDING.*must not expose saleable stock/s,
    );
    assert.match(script, /\$physicalStockAttestation\.status -eq "ready"/);
    assert.match(fixtureFlow, /\$salePhase -eq "fixture"/);
    assert.match(fixtureFlow, /kind = "simulated_hardware_sale_fixture"/);
    assert.doesNotMatch(
      fixtureFlow,
      /create-order|successfulPrepare|\$createOrder/,
    );
    assert.match(
      script,
      /Invoke-IpcJson "GET" "\$baseUrl\/v1\/stock\/movements\/dispense-confirmation\?orderId=\$orderQuery&vendingCommandId=\$commandQuery" \$headers/,
    );
    assert.match(script, /\$attempt -lt 30/);
    assert.doesNotMatch(script, /VEM_TESTBED_MACHINE_AUTH_TOKEN/);
    assert.doesNotMatch(
      script,
      /machine-stock-movements\/dispense-confirmation/,
    );
    assert.doesNotMatch(script, /\/v1\/intents\/mock-payment/);
    assert.match(script, /paymentMethod = "payment_code"/);
    assert.match(script, /\$salePhase -eq "complete"/);
    assert.match(
      script,
      /Invoke-TestbedProvisioningClaim \$provisioningActions/,
    );
    assert.match(script, /claim = \[ordered\]@{/);
    assert.match(script, /profile = \[ordered\]@{/);
    assert.match(script, /acknowledgmentId =/);
    assert.match(script, /uploadStatus =/);
    assert.match(script, /paymentNo =/);
    assert.match(script, /vendingCommandId =/);
    assert.match(
      script,
      /simulatedHardwareReady = if \(\$diagnostics.Count -eq 0\)/,
    );
    assert.match(script, /sellReady = \[ordered\]@{/);
    assert.match(script, /status = "not_asserted"/);
    assert.ok(
      script.indexOf("Invoke-TestbedProvisioningClaim $provisioningActions") <
        script.indexOf("Invoke-SimulatedHardwareSaleFlow $provisioningActions"),
    );
    assert.ok(
      script.indexOf("Assert-SimulatedSaleFlowPreMutationTarget") <
        script.indexOf(
          'Invoke-IpcJson "POST" "$baseUrl/v1/stock/planogram/sync"',
        ),
    );
    assert.ok(
      script.indexOf("$selectedItem = @($saleView.items") <
        script.indexOf("platformMovementId ="),
    );
  });

  it("PowerShell-parses the generated simulated-sale fixture script", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-sale-flow-parse-"));
    try {
      const evidencePath = join(temp, "ephemeral-platform.json");
      const scriptPath = join(temp, "simulated-sale-fixture.ps1");
      const parserPath = join(temp, "parse-generated-script.ps1");
      writeFileSync(
        evidencePath,
        JSON.stringify(ephemeralPlatformEvidence()),
        "utf8",
      );
      writeFileSync(
        scriptPath,
        buildRemotePowerShellScript({
          mode: "simulated-hardware-sale-flow",
          salePhase: "fixture",
          platformTarget: "ephemeral-run-180",
          machineCode: "VEM-TESTBED-WINVM-01",
          runId: "RUN-180",
          ephemeralPlatformEvidence: evidencePath,
        }),
        "utf8",
      );
      writeFileSync(
        parserPath,
        `param([string]$Path)
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) {
  $errors | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }
  exit 1
}
`,
        "utf8",
      );
      const parsed = spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-File", parserPath, scriptPath],
        { encoding: "utf8" },
      );
      assert.equal(
        parsed.status,
        0,
        `generated fixture PowerShell failed to parse:\n${parsed.stdout}\n${parsed.stderr}`,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("factory preparation uses production serial adapters for simulated hardware", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts/windows/prepare-factory-runtime.ps1"),
      "utf8",
    );

    assert.match(script, /apiBaseUrl = \$ProvisioningEndpoint/);
    assert.match(script, /mqttUrl = \$MqttUrl/);
    assert.match(script, /hardwareAdapter = "serial"/);
    assert.match(script, /serialPortPath = \$LowerControllerSerialPortPath/);
    assert.match(script, /scannerAdapter = "serial_text"/);
    assert.match(script, /scannerSerialPortPath = \$ScannerSerialPortPath/);
    assert.match(script, /visionEnabled = \$false/);
    assert.match(script, /kioskMode = \$true/);
    assert.match(
      script,
      /required machine UI sidecar missing next to machine\.exe/,
    );
    assert.match(script, /WebView2Loader\.dll/);
    assert.doesNotMatch(
      script,
      /hardwareAdapter = if \(\$HardwareMode -eq "simulated"\) \{ "simulated" \}/,
    );
    assert.doesNotMatch(
      script,
      /provisioningEndpoint = \$ProvisioningEndpoint\\n\\s+hardwareAdapter/,
    );
    assert.doesNotMatch(
      script,
      /hardwareModel = \$HardwareModel\\n\\s+topologyIdentity/,
    );
  });

  it("factory runtime verifier exposes hardware mode from the factory manifest", () => {
    const verifier = readFileSync(
      join(process.cwd(), "scripts/windows/verify-factory-runtime.ps1"),
      "utf8",
    );

    assert.match(verifier, /hardwareMode = \$manifest\.hardware\.mode/);
    assert.match(verifier, /hardwareModel = \$manifest\.hardware\.model/);
  });

  it("passes a deterministic deployment batch to canonical clean-base factory preparation", () => {
    const source = readFileSync("scripts/testbed/win10-vem-e2e.mjs", "utf8");

    assert.match(
      source,
      /DeploymentBatch = \$\{psString\(`clean-base-\$\{cleanBaseFactoryProfile\}-v1`\)\}/,
    );
  });

  it("plans VM runtime acceptance from an approved preclaim base", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-vm-acceptance-artifacts-"));
    try {
      const outputPath = join(temp, "vm-runtime-acceptance-plan.json");

      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/win10-vem-e2e.mjs",
          "--mode",
          "vm-runtime-acceptance",
          "--run-id",
          "RUN-181",
          "--platform-target",
          "ephemeral-run-181",
          "--ephemeral-database-url",
          "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_181",
          "--ephemeral-api-base-url",
          "http://127.0.0.1:26849/api",
          "--ephemeral-mqtt-url",
          "mqtt://127.0.0.1:1883",
          "--factory-guest-endpoint-json",
          JSON.stringify({
            protocol: "ssh",
            host: "10.91.2.10",
            port: 22,
            reachability: "discovered",
          }),
          "--expected-testbed-user",
          "YKDZ",
          "--ssh-known-hosts-path",
          "/tmp/vem-runtime-known-hosts",
          "--ssh-host-key-alias",
          "vem-runtime-run-181",
          "--identity",
          "/tmp/vem-runtime-id",
          "--certificate",
          "/tmp/vem-runtime-id-cert.pub",
          "--out",
          outputPath,
          "--dry-run",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      const writtenPlan = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(plan.schemaVersion, "vm-runtime-acceptance-plan/v1");
      assert.deepEqual(writtenPlan, plan);
      assert.equal(plan.mode, "vm-runtime-acceptance");
      assert.equal(plan.runId, "RUN-181");
      assert.equal(plan.target.machineCode, "VEM-TESTBED-WINVM-RUN-181");
      assert.equal(plan.target.platformTarget, "ephemeral-run-181");
      assert.equal(
        plan.evidenceRoot,
        "artifacts/vm-runtime-acceptance/RUN-181",
      );
      assert.equal(
        plan.artifacts.report,
        "artifacts/vm-runtime-acceptance/RUN-181/vm-runtime-acceptance-report.json",
      );
      assert.equal(
        plan.artifacts.ephemeralPlatformEvidence,
        "artifacts/vm-runtime-acceptance/RUN-181/ephemeral-platform.json",
      );
      assert.deepEqual(
        plan.steps.map((step) => step.name),
        [
          "approved preclaim base verification",
          "ephemeral platform setup",
          "runtime acceptance",
          "installed kiosk sale normal",
          "installed kiosk sale route competition",
        ],
      );
      assert.equal(plan.artifacts.source, "approved-preclaim-base");
      assert.equal(plan.steps[0].mode, "factory-preclaim-verify");
      assert.equal(commandArg(plan.steps[0].command, "--remote"), undefined);
      assert.equal(
        commandArg(plan.steps[0].command, "--factory-guest-endpoint-json"),
        JSON.stringify({
          protocol: "ssh",
          host: "10.91.2.10",
          port: 22,
          reachability: "discovered",
        }),
      );
      assert.equal(
        commandArg(plan.steps[0].command, "--ssh-host-key-alias"),
        "vem-runtime-run-181",
      );
      assert.equal(plan.steps[1].command[0], "pnpm");
      assert.deepEqual(plan.steps[1].cwd, "apps/service-api");
      assert.ok(
        plan.steps[1].command.includes("--allow-ephemeral-target"),
        "ephemeral setup must carry explicit safety flags",
      );
      assert.ok(
        plan.steps[1].command.includes("--allow-mock-payment"),
        "ephemeral setup must carry explicit mock-payment acknowledgement",
      );
      assert.equal(plan.steps[3].mode, "installed-kiosk-sale");
      assert.equal(plan.steps[4].mode, "installed-kiosk-sale");
      assert.equal(
        plan.steps[3].ephemeralPlatformEvidence,
        plan.artifacts.ephemeralPlatformEvidence,
      );
      assert.equal(
        plan.steps[4].ephemeralPlatformEvidence,
        plan.artifacts.ephemeralPlatformEvidence,
      );
      assert.equal(plan.readinessLevels.sellReady, "not_asserted");
      assert.deepEqual(plan.ci.requiredSecrets, []);
      assert.deepEqual(plan.ci.requiredCredentials, [
        "approved-preclaim-base",
        "certificate-only-ssh",
      ]);
      assert.equal(
        plan.steps.some(
          (step) => step.mode === "dirty-host-factory-acceptance",
        ),
        false,
      );
      assert.doesNotMatch(result.stdout, /pass@127\.0\.0\.1/);
      assert.doesNotMatch(
        readFileSync(outputPath, "utf8"),
        /pass@127\.0\.0\.1/,
      );
      assert.match(result.stdout, /\[REDACTED\]/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("launches a single temporary CDP kiosk UI and always restores the normal owner without daemon mutation", () => {
    const launch = buildInstalledKioskSaleLaunchScript();
    const cleanup = buildInstalledKioskSaleCleanupScript({
      principal: "VEM\\VEMKiosk",
      sessionId: 1,
      expectedRoute: "#/catalog",
    });

    assert.match(launch, /launch-machine-ui-debug\.vbs/);
    assert.match(launch, /VEMInstalledKioskSaleDebug/);
    assert.match(
      launch,
      /temporary CDP-enabled machine\.exe did not reach exactly-one process\/listener state/,
    );
    assert.match(launch, /WTSGetActiveConsoleSessionId/);
    assert.match(
      launch,
      /normal machine\.exe must belong exactly to the active console VEMKiosk principal and session/,
    );
    assert.match(
      launch,
      /debugTarget = \[ordered\]@\{ id = \[string\]\$targets\[0\]\.id/,
    );
    assert.doesNotMatch(launch, /Stop-Service -Name 'VemVendingDaemon'/);
    assert.doesNotMatch(launch, /Invoke-IpcJson .*create-order/);
    assert.match(cleanup, /Unregister-ScheduledTask -TaskName \$debugTask/);
    assert.match(cleanup, /CDP listener remained after debug UI cleanup/);
    assert.match(cleanup, /VEMInstalledKioskSaleRestore/);
    assert.match(cleanup, /VEMInstalledKioskSaleRestoreObserve/);
    assert.match(cleanup, /-LogonType InteractiveToken/);
    assert.match(
      cleanup,
      /restored normal machine\.exe principal or session differs from saved VEMKiosk owner/,
    );
    assert.match(
      cleanup,
      /daemon stopped during installed kiosk sale acceptance/,
    );
    assert.match(cleanup, /http:\/\/127\.0\.0\.1:9222\/json/);
    assert.match(cleanup, /source = 'remote_cdp'/);
    assert.match(
      cleanup,
      /restored normal machine\.exe CDP route differs from saved route/,
    );
    assert.doesNotMatch(cleanup, /route = \$expectedRoute/);
    assert.ok(
      cleanup.indexOf("Unregister-ScheduledTask -TaskName $debugTask") <
        cleanup.indexOf("Get-Service -Name 'VemVendingDaemon'"),
      "cleanup must remove the debug task/listener before daemon health is evaluated",
    );
  });

  it("plans clean-base factory acceptance with explicit clean-source evidence and destructive gates", () => {
    const plan = buildCleanBaseFactoryAcceptancePlan({
      runId: "RUN-182",
      cleanBaseSource: "factory-media://clean-windows-base",
      cleanBaseSnapshot: "vem-clean-base-before-factory-prep",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    assert.equal(plan.schemaVersion, "clean-base-factory-acceptance-plan/v1");
    assert.equal(plan.mode, "clean-base-factory-acceptance");
    assert.equal(plan.runId, "RUN-182");
    assert.equal(plan.cleanBase.source, "factory-media://clean-windows-base");
    assert.equal(plan.cleanBase.snapshot, "vem-clean-base-before-factory-prep");
    assert.equal(plan.cleanBase.requiresCleanWindowsBase, true);
    assert.deepEqual(plan.cleanBase.requiredBaseline, {
      displayOrientationResolution: {
        orientation: "portrait",
        widthPx: 1080,
        heightPx: 1920,
      },
      sshReachability: "required",
      tailscaleDefaultAbsent: "required",
      sleepDisabled: "required",
      testsigningOff: "required",
      autologonConfigured: "required",
      startupLauncherMode: ["shell_launcher", "scheduled_task"],
      daemonService: "VemVendingDaemon",
      uiLauncherTask: "VEMMachineUI",
      runtimeResetGateClean: "required",
      hardwareProfileMode: "required",
      startupReachesBringUpOrSalesEligible: "required",
    });
    assert.ok(
      plan.preflightAbsenceProbes.some(
        (probe) =>
          probe.code === "preflightNoMachineIdentity" &&
          probe.paths.includes(
            "C:\\ProgramData\\VEM\\vending-daemon\\machine-config.json",
          ),
      ),
    );
    assert.ok(
      plan.preflightAbsenceProbes.some(
        (probe) =>
          probe.code === "preflightNoDaemonState" &&
          probe.paths.includes("C:\\VEM\\bringup") &&
          probe.paths.includes("C:\\ProgramData\\VEM\\bringup") &&
          probe.paths.includes("C:\\ProgramData\\VEM\\vending-daemon") &&
          probe.services.includes("VemVendingDaemon") &&
          probe.tasks.includes("VEMMachineUI") &&
          probe.tasks.includes("VEM\\StartVisionServer"),
      ),
    );
    assert.ok(
      plan.steps
        .find((step) => step.name === "prepare factory runtime")
        .requires.includes("--allow-clean-base-prepare"),
    );
    assert.equal(plan.report, plan.artifacts.cleanBaseFactoryAcceptance);
    assert.equal(
      plan.reportContract.schemaVersion,
      "clean-base-factory-acceptance-report/v1",
    );
    assert.equal(plan.reportContract.kind, "clean-base-factory-acceptance");
    assert.ok(
      plan.reportContract.requiredAssertions.includes(
        "startupReachesBringUpOrSalesEligible",
      ),
    );
    assert.equal(
      plan.readinessLevels.cleanBasePreparationAcceptance,
      "asserted_by_clean_base_step",
    );
    assert.equal(plan.readinessLevels.runtimeReady, "not_asserted");
    assert.equal(plan.readinessLevels.simulatedHardwareReady, "not_asserted");
    assert.equal(plan.readinessLevels.sellReady, "not_asserted");
  });

  it("projects production Factory Vision media and configuration through the clean-base plan and child prepare entrypoint", () => {
    const factoryMediaRoot = "C:\\Factory Media\\VEM";
    const visionConfigurationSourcePath =
      "C:\\Factory Media\\VEM\\vision-site-config.json";
    const plan = buildCleanBaseFactoryAcceptancePlan({
      runId: "RUN-191",
      cleanBaseSource: "factory-media://clean-windows-base",
      cleanBaseSnapshot: "vem-clean-base-before-factory-prep",
      factoryProfile: "production",
      factoryMediaRoot,
      visionConfigurationSourcePath,
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });
    assert.deepEqual(plan.cleanBase.visionInputs, {
      factoryMediaRoot,
      visionConfigurationSourcePath,
    });

    const script = buildRemotePowerShellScript({
      mode: "clean-base-factory-acceptance",
      runId: "RUN-191",
      cleanBaseSource: "factory-media://clean-windows-base",
      cleanBaseSnapshot: "vem-clean-base-before-factory-prep",
      factoryProfile: "production",
      factoryMediaRoot,
      visionConfigurationSourcePath,
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
      remoteSupportScriptRoot: "C:\\Windows\\Temp\\vem-clean-base-support",
      remoteUploadedArtifactRoot:
        "C:\\Windows\\Temp\\vem-clean-base-support\\input-artifacts",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });
    assert.match(script, /FactoryMediaRoot = 'C:\\Factory Media\\VEM'/);
    assert.match(
      script,
      /VisionConfigurationSourcePath = 'C:\\Factory Media\\VEM\\vision-site-config\.json'/,
    );
    assert.match(script, /EnvironmentName = 'vps-fresh-production-clean-base'/);
    assert.match(script, /DeploymentBatch = 'clean-base-production-v1'/);
  });

  it("keeps batch-like testbed labels separate from the strict Factory profile", () => {
    const script = buildRemotePowerShellScript({
      mode: "clean-base-factory-acceptance",
      runId: "RUN-192",
      cleanBaseSource: "factory-media://clean-windows-base",
      cleanBaseSnapshot: "vem-clean-base-before-factory-prep",
      factoryProfile: "testbed",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
      remoteSupportScriptRoot: "C:\\Windows\\Temp\\vem-clean-base-support",
      remoteUploadedArtifactRoot:
        "C:\\Windows\\Temp\\vem-clean-base-support\\input-artifacts",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });
    assert.match(script, /FactoryProfile = 'testbed'/);
    assert.match(script, /EnvironmentName = 'vps-fresh-testbed-clean-base'/);
    assert.match(script, /DeploymentBatch = 'clean-base-testbed-v1'/);
  });

  it("carries production and testbed clean-base labels through PowerShell, Rust, and the verifier", () => {
    for (const profile of ["production", "testbed"]) {
      const result = projectFactoryRuntimeBoundary(profile);
      try {
        assert.equal(result.projection.factoryProfile, profile);
        assert.equal(
          result.projection.inputs.environmentName,
          `vps-fresh-${profile}-clean-base`,
        );
        assert.equal(
          result.projection.inputs.deploymentBatch,
          `clean-base-${profile}-v1`,
        );
        assert.equal(
          result.projection.daemonFactoryManifest.environment,
          profile,
        );
        assert.equal(
          Object.hasOwn(
            result.projection.daemonFactoryManifest,
            "environmentName",
          ),
          false,
        );
        assert.equal(
          Object.hasOwn(
            result.projection.daemonFactoryManifest,
            "deploymentBatch",
          ),
          false,
        );
        if (profile === "production") {
          assert.deepEqual(result.projection.inputs.visionInputs, {
            factoryMediaRoot: "C:\\Factory Media\\VEM",
            visionConfigurationSourcePath:
              "C:\\Factory Media\\VEM\\vision-site-config.json",
          });
        }
      } finally {
        rmSync(result.directory, { recursive: true, force: true });
      }
    }
  });

  it("declares the Factory Windows Baseline policy and evidence contract", () => {
    const plan = buildCleanBaseFactoryAcceptancePlan({
      runId: "RUN-184",
      cleanBaseSource: "factory-media://clean-windows-base",
      cleanBaseSnapshot: "vem-clean-base-before-factory-prep",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    assert.equal(
      plan.cleanBase.factoryWindowsBaselinePolicy.schemaVersion,
      "factory-windows-baseline-policy/v1",
    );
    assert.equal(
      plan.cleanBase.factoryWindowsBaselinePolicy.model,
      "allowlist",
    );
    assert.deepEqual(
      plan.cleanBase.factoryWindowsBaselinePolicy.requiredCapabilities,
      [
        "defender_enabled",
        "firewall_enabled",
        "no_default_product_remote_ingress",
        "vem_runtime_defender_exclusions",
        "openssh_server_for_maintenance_users",
        "tailscale_not_installed_by_default",
        "kiosk_account_denied_remote_access",
        "windows_event_logging",
        "powershell_management",
        "networking_certificates_time_sync",
        "webview2_runtime_support",
        "display_touch_usb_serial_drivers",
        "fonts_input_methods",
      ],
    );
    assert.deepEqual(
      plan.cleanBase.factoryWindowsBaselinePolicy.disabledRuntimeInterference,
      [
        "windows_auto_update_installation",
        "windows_auto_update_auto_restart",
        "sleep",
        "hibernation",
        "testsigning",
        "store_automatic_app_updates",
        "consumer_experience_autostart",
        "consumer_experience_foreground_popups",
        "consumer_experience_kiosk_foreground_takeover_best_effort",
      ],
    );
    assert.deepEqual(
      plan.cleanBase.factoryWindowsBaselinePolicy.evidenceFields,
      {
        windowsUpdatePolicy: "assertions.windowsUpdatePolicy",
        powerPolicy: "assertions.powerPolicy",
        bootPolicy: "assertions.bootPolicy",
        securityPosture: "assertions.securityPosture",
        remoteMaintenanceCapability:
          "assertions.factoryRemoteMaintenanceCapability",
        consumerExperienceInterference:
          "assertions.consumerExperienceInterference",
      },
    );
    assert.deepEqual(
      plan.reportContract.requiredAssertions.filter((name) =>
        [
          "windowsUpdatePolicy",
          "powerPolicy",
          "bootPolicy",
          "securityPosture",
          "factoryRemoteMaintenanceCapability",
          "consumerExperienceInterference",
        ].includes(name),
      ),
      [
        "windowsUpdatePolicy",
        "powerPolicy",
        "bootPolicy",
        "securityPosture",
        "factoryRemoteMaintenanceCapability",
        "consumerExperienceInterference",
      ],
    );
  });

  it("exposes clean-base factory acceptance as a dry-run CLI plan before touching a VM", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/testbed/win10-vem-e2e.mjs",
        "--mode",
        "clean-base-factory-acceptance",
        "--run-id",
        "RUN-182",
        "--clean-base-source",
        "factory-media://clean-windows-base",
        "--clean-base-snapshot",
        "vem-clean-base-before-factory-prep",
        "--daemon-artifact-sha256",
        "a".repeat(64),
        "--machine-ui-artifact-sha256",
        "b".repeat(64),
        "--dry-run",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, "clean-base-factory-acceptance");
    assert.equal(plan.runId, "RUN-182");
    assert.equal(plan.cleanBase.requiresCleanWindowsBase, true);
    assert.equal(plan.artifacts.daemonSha256, "a".repeat(64));
    assert.equal(plan.artifacts.machineUiSha256, "b".repeat(64));
  });

  it("writes the clean-base factory acceptance dry-run plan when --out is provided", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-clean-base-dry-run-"));
    try {
      const outputPath = join(temp, "clean-base-dry-run.json");
      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/win10-vem-e2e.mjs",
          "--mode",
          "clean-base-factory-acceptance",
          "--run-id",
          "RUN-190",
          "--clean-base-source",
          "factory-media://clean-windows-base",
          "--clean-base-snapshot",
          "vem-clean-base-before-factory-prep",
          "--daemon-artifact-sha256",
          "a".repeat(64),
          "--machine-ui-artifact-sha256",
          "b".repeat(64),
          "--dry-run",
          "--out",
          outputPath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(outputPath), true);
      const plan = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(plan.schemaVersion, "clean-base-factory-acceptance-plan/v1");
      assert.equal(plan.runId, "RUN-190");
      assert.equal(JSON.parse(result.stdout).runId, "RUN-190");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("refuses live clean-base preparation without the explicit destructive allow flag", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/testbed/win10-vem-e2e.mjs",
        "--mode",
        "clean-base-factory-acceptance",
        "--run-id",
        "RUN-185",
        "--clean-base-source",
        "factory-media://clean-windows-base",
        "--clean-base-snapshot",
        "vem-clean-base-before-factory-prep",
        "--daemon-artifact-sha256",
        "a".repeat(64),
        "--machine-ui-artifact-sha256",
        "b".repeat(64),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /clean-base factory acceptance live mode requires --allow-clean-base-prepare/,
    );
    assert.doesNotMatch(result.stderr, /not implemented/);
  });

  it("rejects the removed existing-remote-artifacts escape hatch", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/testbed/win10-vem-e2e.mjs",
        "--mode",
        "clean-base-factory-acceptance",
        "--run-id",
        "RUN-185",
        "--clean-base-source",
        "factory-media://clean-windows-base",
        "--clean-base-snapshot",
        "vem-clean-base-before-factory-prep",
        "--use-existing-remote-artifacts",
        "--allow-clean-base-prepare",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /unknown argument: --use-existing-remote-artifacts/,
    );
  });

  it("refuses known production clean-base remotes before live staging", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/testbed/win10-vem-e2e.mjs",
        "--mode",
        "clean-base-factory-acceptance",
        "--run-id",
        "RUN-185",
        "--clean-base-source",
        "factory-media://clean-windows-base",
        "--clean-base-snapshot",
        "vem-clean-base-before-factory-prep",
        "--daemon-artifact-sha256",
        "a".repeat(64),
        "--machine-ui-artifact-sha256",
        "b".repeat(64),
        "--remote",
        "vem",
        "--allow-clean-base-prepare",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /refuses production machine remote before staging/,
    );
    assert.doesNotMatch(result.stderr, /requires --daemon-artifact/);
  });

  it("builds live clean-base factory orchestration with staged inputs, verifier evidence, and clean-base-only readiness", () => {
    const script = buildRemotePowerShellScript({
      mode: "clean-base-factory-acceptance",
      runId: "RUN-185",
      cleanBaseSource: "factory-media://clean-windows-base",
      cleanBaseSnapshot: "vem-clean-base-before-factory-prep",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
      remoteSupportScriptRoot:
        "C:\\Users\\YKDZ\\AppData\\Local\\Temp\\vem-clean-base-support",
      remoteUploadedArtifactRoot:
        "C:\\Users\\YKDZ\\AppData\\Local\\Temp\\vem-clean-base-support\\input-artifacts",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    assert.match(script, /Invoke-CleanBaseFactoryAcceptance/);
    assert.match(script, /Assert-CleanBasePreflightAbsence/);
    assert.match(script, /Copy-FactoryAcceptanceInputs/);
    assert.match(script, /WebView2Loader\.dll/);
    assert.match(script, /run scripted clean-base factory runtime preparation/);
    assert.match(script, /ResetExistingVemState = \$false/);
    assert.match(script, /run scripted clean-base factory runtime verifier/);
    assert.match(script, /factory-runtime-preparation.json/);
    assert.match(script, /factory-runtime-verification.json/);
    assert.match(script, /clean-base-factory-acceptance.json/);
    assert.match(
      script,
      /schemaVersion = "clean-base-factory-acceptance-report\/v1"/,
    );
    assert.match(script, /kind = "clean-base-factory-acceptance"/);
    assert.match(script, /source = \[ordered\]@{/);
    assert.match(script, /uri = 'factory-media:\/\/clean-windows-base'/);
    assert.match(
      script,
      /factoryWindowsBaselinePolicy = \$factoryWindowsBaselinePolicy/,
    );
    assert.match(
      script,
      /cleanBasePreparationAcceptance = if \(\$passed\) \{ "passed" \} else \{ "failed" \}/,
    );
    assert.match(script, /runtimeReady = "not_asserted"/);
    assert.match(script, /simulatedHardwareReady = "not_asserted"/);
    assert.match(script, /sellReady = "not_asserted"/);
    assert.match(script, /function Test-CleanBaseFactoryAssertionsPassed/);
    assert.match(
      script,
      /\$assertionsPassed = Test-CleanBaseFactoryAssertionsPassed \$assertions/,
    );
    assert.match(
      script,
      /\$passed = \$diagnostics\.Count -eq 0 -and \$assertionsPassed/,
    );
    assert.match(script, /clean_base_assertions_failed/);
    assert.match(script, /clean_base_preflight_failed/);
    assert.match(script, /factory_preparation_failed/);
    assert.match(script, /factory_verifier_failed/);
  });

  it("generates clean-base preflight probes for retained paths, daemon service, and startup tasks", () => {
    const script = buildRemotePowerShellScript({
      mode: "clean-base-factory-acceptance",
      runId: "RUN-185",
      cleanBaseSource: "factory-media://clean-windows-base",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    assert.equal(script.includes("C:\\VEM\\bringup"), true);
    assert.equal(script.includes("C:\\ProgramData\\VEM\\bringup"), true);
    assert.equal(script.includes("C:\\ProgramData\\VEM\\provisioning"), true);
    assert.equal(script.includes("C:\\ProgramData\\VEM\\secrets"), true);
    assert.equal(script.includes("C:\\ProgramData\\VEM\\overrides"), true);
    assert.equal(script.includes("C:\\ProgramData\\VEM\\evidence"), true);
    assert.equal(script.includes("C:\\ProgramData\\VEM\\vending-daemon"), true);
    assert.match(script, /VemVendingDaemon/);
    assert.match(script, /VEMMachineUI/);
    assert.equal(script.includes("VEM\\StartVisionServer"), true);
    assert.match(script, /observedServices/);
    assert.match(script, /observedTasks/);
  });

  it("uses encoded read-only SSH probes and runs retained-state preflight before staging", () => {
    const identityCommand = buildCleanBaseRemoteIdentityProbeCommand();
    const preflightCommand = buildCleanBaseRemotePreflightAbsenceProbeCommand();
    const decode = (command) =>
      Buffer.from(command.split("-EncodedCommand ")[1], "base64").toString(
        "utf16le",
      );

    assert.match(identityCommand, /-EncodedCommand [A-Za-z0-9+/=]+$/);
    assert.match(preflightCommand, /-EncodedCommand [A-Za-z0-9+/=]+$/);
    assert.doesNotMatch(identityCommand, /[|{}]/);
    assert.doesNotMatch(preflightCommand, /[|{}]/);
    assert.match(
      decode(identityCommand),
      /hostName = \[string\]\$computer\.Name/,
    );
    assert.match(decode(identityCommand), /user = \[string\]\$identity\.Name/);
    assert.doesNotMatch(decode(identityCommand), /tailscale/i);
    assert.match(decode(preflightCommand), /Test-Path -LiteralPath/);
    assert.match(decode(preflightCommand), /Get-Service -Name \$serviceName/);
    assert.match(decode(preflightCommand), /Get-ScheduledTask -TaskName/);

    const source = readFileSync("scripts/testbed/win10-vem-e2e.mjs", "utf8");
    const preflightIndex = source.indexOf(
      "assertCleanBaseRemotePreflightAbsenceProbe(options, sshCommand)",
    );
    assert.ok(preflightIndex > 0);
    assert.ok(preflightIndex < source.indexOf("writeFileSync(localScriptPath"));
    assert.ok(preflightIndex < source.indexOf("createSupportRootCommand"));
    assert.ok(preflightIndex < source.indexOf("uploadArtifact"));
  });

  it("rejects dirty or production clean-base sources and malformed artifact hashes", () => {
    const baseOptions = {
      runId: "RUN-182",
      cleanBaseSource: "factory-media://clean-windows-base",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    };

    assert.throws(
      () =>
        buildCleanBaseFactoryAcceptancePlan({
          ...baseOptions,
          cleanBaseSource: "factory-media://dirty-windows-base",
        }),
      /known dirty-host source/,
    );
    assert.throws(
      () =>
        buildCleanBaseFactoryAcceptancePlan({
          ...baseOptions,
          cleanBaseSource: "ssh://Admin@100.66.207.119/VEM-WIN10-REAL-01",
        }),
      /production machine source/,
    );
    assert.throws(
      () =>
        buildCleanBaseFactoryAcceptancePlan({
          ...baseOptions,
          cleanBaseSource: "vem",
        }),
      /production machine source/,
    );
    assert.throws(
      () =>
        buildCleanBaseFactoryAcceptancePlan({
          ...baseOptions,
          daemonArtifactSha256: "A".repeat(64),
        }),
      /requires lowercase SHA-256 hash/,
    );
  });

  it("rejects dirty-source clean-base evidence through the validator CLI", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-clean-base-evidence-"));
    try {
      const evidencePath = join(temp, "clean-base-factory-acceptance.json");
      writeFileSync(
        evidencePath,
        JSON.stringify(
          cleanBaseFactoryAcceptanceEvidence({
            source: {
              kind: "clean-windows-base",
              uri: "factory-media://other-windows-base",
              identity: {
                hostName: "DESKTOP-2STVS5B",
              },
            },
          }),
        ),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/win10-vem-e2e.mjs",
          "--mode",
          "validate-clean-base-evidence",
          "--clean-base-evidence",
          evidencePath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      assert.equal(result.status, 1);
      const validation = JSON.parse(result.stdout);
      assert.equal(validation.status, "failed");
      assert.match(validation.message, /known dirty-host source/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects clean-base evidence when baseline posture fields overclaim", () => {
    const validation = validateCleanBaseFactoryAcceptanceEvidence(
      cleanBaseFactoryAcceptanceEvidence({
        assertions: {
          ...cleanBaseFactoryAcceptanceEvidence().assertions,
          windowsUpdatePolicy: {
            status: "passed",
            automaticUpdateInstallation: "disabled",
            automaticRestart: "enabled_or_unmanaged",
          },
        },
      }),
    );

    assert.equal(validation.status, "failed");
    assert.match(
      validation.message,
      /automatic installation and automatic restart/,
    );
  });

  it("rejects clean-base evidence when Factory Windows Baseline policy contract fields are incomplete", () => {
    const evidence = cleanBaseFactoryAcceptanceEvidence({
      factoryWindowsBaselinePolicy: {
        ...cleanBaseFactoryAcceptanceEvidence().factoryWindowsBaselinePolicy,
        requiredCapabilities: ["defender_enabled"],
      },
    });

    const validation = validateCleanBaseFactoryAcceptanceEvidence(evidence);

    assert.equal(validation.status, "failed");
    assert.match(validation.message, /requiredCapabilities mismatch/);
  });

  it("rejects clean-base evidence that overclaims consumer foreground takeover blocking", () => {
    const evidence = cleanBaseFactoryAcceptanceEvidence({
      assertions: {
        ...cleanBaseFactoryAcceptanceEvidence().assertions,
        consumerExperienceInterference: {
          status: "passed",
          componentAutostart: "disabled",
          foregroundPopups: "disabled",
          storeAutomaticAppUpdates: "disabled",
          kioskForegroundTakeover: "blocked",
        },
      },
    });

    const validation = validateCleanBaseFactoryAcceptanceEvidence(evidence);

    assert.equal(validation.status, "failed");
    assert.match(validation.message, /best-effort policy evidence/);
  });

  it("rejects clean-base evidence when any required assertion failed", () => {
    const validation = validateCleanBaseFactoryAcceptanceEvidence(
      cleanBaseFactoryAcceptanceEvidence({
        assertions: {
          ...cleanBaseFactoryAcceptanceEvidence().assertions,
          startupReachesBringUpOrSalesEligible: {
            status: "failed",
            state: "not_started",
          },
        },
      }),
    );

    assert.equal(validation.status, "failed");
    assert.match(validation.message, /required assertions are not all passed/);
    assert.deepEqual(validation.detail, {
      failedAssertions: ["startupReachesBringUpOrSalesEligible"],
    });
  });

  it("rejects clean-base evidence that overclaims runtime or simulated-hardware readiness", () => {
    for (const readinessName of ["runtimeReady", "simulatedHardwareReady"]) {
      const validation = validateCleanBaseFactoryAcceptanceEvidence(
        cleanBaseFactoryAcceptanceEvidence({
          readiness: {
            ...cleanBaseFactoryAcceptanceEvidence().readiness,
            [readinessName]: "passed",
          },
        }),
      );

      assert.equal(validation.status, "failed");
      assert.match(
        validation.message,
        new RegExp(`must not assert ${readinessName}`),
      );
    }
  });

  it("builds a sanitized Factory Image Delivery Unit report from completed clean-base evidence", () => {
    const acceptancePath =
      "artifacts/clean-base-factory-acceptance/RUN-186/clean-base-factory-acceptance.json";
    const report = buildFactoryImageDeliveryUnitReport({
      cleanBaseAcceptance: cleanBaseFactoryAcceptanceEvidence({
        runId: "RUN-186",
        source: {
          kind: "clean-windows-base",
          uri: "factory-media://clean-windows-base",
          snapshot: "vem-clean-base-before-factory-prep",
          identity: {
            hostName: "WIN10-VEM-CLEAN",
          },
        },
        artifacts: {
          daemonSha256: "a".repeat(64),
          machineUiSha256: "b".repeat(64),
          source: "uploaded_local_artifacts",
          webView2Sidecar:
            "C:\\Users\\factory\\AppData\\Local\\Temp\\WebView2Loader.dll",
        },
        diagnostics: [
          {
            code: "note",
            message:
              "claimCode=CLAIM-SECRET token=ipc-token password=plain secret=raw",
          },
        ],
        evidence: {
          factoryProfile: "testbed",
          preparationOutput:
            "C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\RUN-186\\factory-runtime-preparation.json",
          verificationAction:
            "C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\RUN-186\\factory-runtime-verification-action.json",
          verifierEvidence:
            "C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\RUN-186\\factory-runtime-verification.json",
          factoryRuntimeVerification: {
            ok: true,
            manifestPath:
              "C:\\ProgramData\\VEM\\factory\\factory-runtime-manifest.json",
            failures: [],
            checks: {
              manifest: {
                schemaVersion: "vem-factory-runtime-manifest/v1",
                factoryProfile: "testbed",
                hardwareMode: "simulated",
                hardwareModel: "win10-clean-base",
                topologyIdentity: "clean-base-factory-runtime",
                topologyVersion: "clean-base-v1",
              },
            },
          },
          actions: [
            {
              name: "run scripted clean-base factory runtime preparation",
              status: "succeeded",
              outputPath:
                "C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\RUN-186\\factory-runtime-preparation.json",
            },
          ],
        },
      }),
      cleanBaseAcceptancePath: acceptancePath,
    });

    assert.equal(report.schemaVersion, "factory-image-delivery-unit-report/v1");
    assert.equal(report.kind, "factory-image-delivery-unit");
    assert.equal(report.runId, "RUN-186");
    assert.deepEqual(report.imageSource, {
      kind: "clean-windows-base",
      uri: "factory-media://clean-windows-base",
      snapshot: "vem-clean-base-before-factory-prep",
      identity: {
        hostName: "WIN10-VEM-CLEAN",
      },
    });
    assert.equal(
      report.declaredBuildInputs.factoryManifest.path,
      "C:\\ProgramData\\VEM\\factory\\factory-runtime-manifest.json",
    );
    assert.equal(report.artifacts.daemonSha256, "a".repeat(64));
    assert.equal(report.artifacts.machineUiSha256, "b".repeat(64));
    assert.equal(report.preparationLogs.status, "indexed");
    assert.equal(
      report.verifierEvidence.factoryRuntimeVerification.path,
      "C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\RUN-186\\factory-runtime-verification.json",
    );
    assert.equal(
      report.cleanBaseAcceptanceReport.path,
      "artifacts/clean-base-factory-acceptance/RUN-186/clean-base-factory-acceptance.json",
    );
    assert.equal(report.evidenceReview.screenshots.status, "missing");
    assert.equal(report.evidenceReview.sessions.status, "missing");
    assert.deepEqual(report.readiness, {
      cleanBasePreparationAcceptance: {
        status: "passed",
        asserted: true,
      },
      runtimeReady: {
        status: "not_asserted",
        asserted: false,
      },
      simulatedHardwareReady: {
        status: "not_asserted",
        asserted: false,
      },
      sellReady: {
        status: "not_asserted",
        asserted: false,
      },
    });

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /CLAIM-SECRET/);
    assert.doesNotMatch(serialized, /ipc-token/);
    assert.doesNotMatch(serialized, /password=plain/);
    assert.doesNotMatch(serialized, /secret=raw/);
    assert.doesNotMatch(serialized, /VEM-WIN10-REAL-01|100\.66\.207\.119/);
    assert.match(serialized, /\[REDACTED\]/);
  });

  it("rejects Factory Image Delivery Unit reports without completed prep evidence", () => {
    for (const [name, evidence] of [
      [
        "missing preparation output",
        {
          ...cleanBaseFactoryAcceptanceEvidence().evidence,
          preparationOutput: null,
        },
      ],
      [
        "missing verifier evidence",
        {
          ...cleanBaseFactoryAcceptanceEvidence().evidence,
          verifierEvidence: "",
        },
      ],
      [
        "failed verifier",
        {
          ...cleanBaseFactoryAcceptanceEvidence().evidence,
          factoryRuntimeVerification: {
            ...cleanBaseFactoryAcceptanceEvidence().evidence
              .factoryRuntimeVerification,
            ok: false,
          },
        },
      ],
      [
        "missing manifest summary",
        {
          ...cleanBaseFactoryAcceptanceEvidence().evidence,
          factoryRuntimeVerification: {
            ...cleanBaseFactoryAcceptanceEvidence().evidence
              .factoryRuntimeVerification,
            checks: {},
          },
        },
      ],
    ]) {
      assert.throws(
        () =>
          buildFactoryImageDeliveryUnitReport({
            cleanBaseAcceptance: cleanBaseFactoryAcceptanceEvidence({
              evidence,
            }),
            cleanBaseAcceptancePath:
              "artifacts/clean-base-factory-acceptance/RUN-186/clean-base-factory-acceptance.json",
          }),
        /completed prep run evidence/,
        name,
      );
    }
  });

  it("redacts credentialed URIs, nested credential fields, dynamic sensitive keys, and production identity values", () => {
    const report = buildFactoryImageDeliveryUnitReport({
      cleanBaseAcceptance: cleanBaseFactoryAcceptanceEvidence({
        diagnostics: [
          {
            code: "sanitize",
            detail: {
              credentialedUri:
                "smb://factory-user:factory-pass@factory-share/images",
              nested: {
                wifiPassword: "wifi-secret",
                networkPassword: "network-secret",
                ssidPassword: "ssid-secret",
              },
              dynamic: {
                "prodSecret-super-secret": "key-name-leak",
                factoryTokenName: "dynamic-token-value",
              },
              productionMachineSource:
                "ssh://Admin@100.66.207.119/VEM-WIN10-REAL-01 DESKTOP-2IDRN2K Admin@desktop-2idrn2k",
            },
          },
        ],
      }),
      cleanBaseAcceptancePath:
        "artifacts/clean-base-factory-acceptance/RUN-186/clean-base-factory-acceptance.json",
    });

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /factory-user|factory-pass/);
    assert.doesNotMatch(serialized, /wifi-secret|network-secret|ssid-secret/);
    assert.doesNotMatch(
      serialized,
      /super-secret|key-name-leak|dynamic-token-value/,
    );
    assert.doesNotMatch(
      serialized,
      /VEM-WIN10-REAL-01|100\.66\.207\.119|DESKTOP-2IDRN2K|Admin@desktop-2idrn2k/i,
    );
    assert.match(serialized, /\[REDACTED\]/);
    assert.match(serialized, /\[REDACTED_KEY\]/);
  });

  it("loads sibling screenshot and session indexes and writes the default Factory Image Delivery Unit path", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-factory-delivery-index-"));
    try {
      const cleanBaseEvidencePath = join(
        temp,
        "clean-base-factory-acceptance.json",
      );
      const defaultOutputPath = join(
        temp,
        "factory-image-delivery-unit-report.json",
      );
      mkdirSync(join(temp, "screenshots"), { recursive: true });
      mkdirSync(join(temp, "sessions"), { recursive: true });
      writeFileSync(
        cleanBaseEvidencePath,
        JSON.stringify(cleanBaseFactoryAcceptanceEvidence(), null, 2),
        "utf8",
      );
      writeFileSync(
        join(temp, "screenshots", "index.json"),
        JSON.stringify(
          {
            schemaVersion: "vm-runtime-acceptance-screenshot-index/v1",
            status: "indexed",
            missingReason: null,
            screenshots: [{ path: "screenshots/kiosk.png" }],
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(
        join(temp, "sessions", "index.json"),
        JSON.stringify(
          {
            schemaVersion: "vm-runtime-acceptance-session-index/v1",
            status: "indexed",
            missingReason: null,
            sessions: [{ user: "VEMKiosk", sessionId: 3 }],
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/win10-vem-e2e.mjs",
          "--mode",
          "factory-image-delivery-unit",
          "--clean-base-evidence",
          cleanBaseEvidencePath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(defaultOutputPath), true);
      assert.match(result.stderr, /factory-image-delivery-unit-report\.json/);
      const report = JSON.parse(readFileSync(defaultOutputPath, "utf8"));
      assert.equal(report.reportPath, defaultOutputPath);
      assert.equal(report.evidenceReview.screenshots.status, "indexed");
      assert.equal(
        report.evidenceReview.screenshots.screenshots[0].path,
        "screenshots/kiosk.png",
      );
      assert.equal(report.evidenceReview.sessions.status, "indexed");
      assert.equal(report.evidenceReview.sessions.sessions[0].user, "VEMKiosk");
      assert.equal(JSON.parse(result.stdout).reportPath, defaultOutputPath);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("writes a Factory Image Delivery Unit report from the CLI", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-factory-delivery-unit-"));
    try {
      const cleanBaseEvidencePath = join(
        temp,
        "clean-base-factory-acceptance.json",
      );
      const outputPath = join(temp, "factory-image-delivery-unit-report.json");
      writeFileSync(
        cleanBaseEvidencePath,
        JSON.stringify(cleanBaseFactoryAcceptanceEvidence(), null, 2),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/win10-vem-e2e.mjs",
          "--mode",
          "factory-image-delivery-unit",
          "--clean-base-evidence",
          cleanBaseEvidencePath,
          "--out",
          outputPath,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /factory-image-delivery-unit-report\.json/);
      const report = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(
        report.schemaVersion,
        "factory-image-delivery-unit-report/v1",
      );
      assert.equal(
        report.cleanBaseAcceptanceReport.path,
        cleanBaseEvidencePath,
      );
      assert.equal(
        report.readiness.cleanBasePreparationAcceptance.status,
        "passed",
      );
      assert.equal(report.readiness.sellReady.status, "not_asserted");
      assert.equal(report.evidenceReview.screenshots.status, "missing");
      assert.equal(report.evidenceReview.sessions.status, "missing");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("uses one canonical run id and machine identity across VM runtime acceptance substeps", () => {
    const plan = buildVmRuntimeAcceptancePlan({
      runId: "run_181.local",
      platformTarget: "ephemeral-run-181",
      ephemeralDatabaseUrl:
        "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_181",
      ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
      ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
      machineCode: "VEM-TESTBED-CUSTOM-RUN-181-LOCAL",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    assert.equal(plan.runId, "RUN-181-LOCAL");
    assert.equal(
      plan.evidenceRoot,
      "artifacts/vm-runtime-acceptance/RUN-181-LOCAL",
    );
    assert.equal(plan.target.machineCode, "VEM-TESTBED-CUSTOM-RUN-181-LOCAL");

    for (const step of plan.steps) {
      assert.equal(commandArg(step.command, "--run-id"), "RUN-181-LOCAL");
    }
    assert.equal(
      commandArg(plan.steps[1].command, "--machine-code-prefix"),
      "VEM-TESTBED-CUSTOM",
    );
    assert.equal(
      commandArg(plan.steps[3].command, "--machine-code"),
      "VEM-TESTBED-CUSTOM-RUN-181-LOCAL",
    );
    const saleStep = plan.steps.find(
      (step) => step.name === "installed kiosk sale route competition",
    );
    const normalSaleStep = plan.steps.find(
      (step) => step.name === "installed kiosk sale normal",
    );
    assert.equal(
      saleStep.command[1],
      "scripts/testbed/installed-kiosk-sale-acceptance.mjs",
    );
    assert.equal(
      commandArg(saleStep.command, "--profile"),
      "vm-route-competition",
    );
    assert.equal(commandArg(normalSaleStep.command, "--profile"), "vm-normal");
    assert.equal(
      commandArg(saleStep.command, "--runtime-acceptance-report"),
      plan.artifacts.runtimeAcceptance,
    );
    assert.equal(
      commandArg(saleStep.command, "--out"),
      plan.artifacts.customerUiSaleRouteCompetition,
    );
    assert.equal(
      commandArg(normalSaleStep.command, "--out"),
      plan.artifacts.customerUiSaleNormal,
    );
    assert.equal(
      commandArg(saleStep.command, "--sale-prepare-command-json"),
      undefined,
    );
    assert.equal(
      commandArg(saleStep.command, "--sale-complete-command-json"),
      undefined,
    );
    assert.equal(saleStep.command.includes("--already-claimed"), true);
    assert.equal(normalSaleStep.command.includes("--already-claimed"), false);

    assert.throws(
      () =>
        buildVmRuntimeAcceptancePlan({
          runId: "run_181.local",
          platformTarget: "ephemeral-run-181",
          ephemeralDatabaseUrl:
            "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_181",
          ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
          ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
          machineCode: "VEM-TESTBED-CUSTOM",
          daemonArtifactSha256: "a".repeat(64),
          machineUiArtifactSha256: "b".repeat(64),
        }),
      /explicit --machine-code must end with canonical run id/,
    );
  });

  it("threads optional clean-base factory evidence through preclaim-based runtime acceptance", () => {
    const plan = buildVmRuntimeAcceptancePlan({
      runId: "RUN-182",
      platformTarget: "ephemeral-run-182",
      ephemeralDatabaseUrl:
        "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_182",
      ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
      ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
      cleanBaseEvidence:
        "artifacts/clean-base-factory-acceptance/RUN-182/clean-base-factory-acceptance.json",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    assert.equal(
      plan.artifacts.cleanBaseFactoryAcceptance,
      "artifacts/clean-base-factory-acceptance/RUN-182/clean-base-factory-acceptance.json",
    );
    assert.deepEqual(
      plan.steps.map((step) => step.name),
      [
        "clean-base factory preparation acceptance",
        "approved preclaim base verification",
        "ephemeral platform setup",
        "runtime acceptance",
        "installed kiosk sale normal",
        "installed kiosk sale route competition",
      ],
    );
    assert.equal(plan.steps[0].mode, "clean-base-factory-acceptance");
    assert.equal(
      commandArg(plan.steps[0].command, "--mode"),
      "validate-clean-base-evidence",
    );
    assert.equal(
      plan.steps[0].report,
      plan.artifacts.cleanBaseFactoryAcceptance,
    );
    assert.equal(plan.steps[0].blocksOnFailure, false);

    const report = buildVmRuntimeAcceptanceReport({
      plan,
      steps: [
        {
          ...plan.steps[0],
          status: "passed",
          parsed: cleanBaseFactoryAcceptanceEvidence(),
        },
        {
          ...plan.steps[1],
          status: "passed",
          parsed: approvedPreclaimBaseEvidence(),
        },
      ],
    });

    assert.equal(
      report.bringUpStateProgression.cleanBasePreparationAcceptance,
      "passed",
    );
    assert.deepEqual(report.finalReadiness.cleanBasePreparationAcceptance, {
      status: "passed",
      asserted: true,
    });
    assert.equal(report.finalReadiness.approvedPreclaimBase.status, "passed");
  });

  it("fails runtime acceptance when approved preclaim evidence lacks the expected schema or kind", () => {
    const plan = buildVmRuntimeAcceptancePlan({
      runId: "RUN-184",
      platformTarget: "ephemeral-run-184",
      ephemeralDatabaseUrl:
        "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_184",
      ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
      ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    for (const parsed of [
      { ok: true, kind: "factory-preclaim-verification" },
      { ok: true, schemaVersion: "factory-preclaim-verification/v1" },
      {
        ok: true,
        schemaVersion: "factory-preclaim-verification/v0",
        kind: "factory-preclaim-verification",
      },
      {
        ok: true,
        schemaVersion: "factory-preclaim-verification/v1",
        kind: "unexpected-preclaim-evidence",
      },
    ]) {
      const report = buildVmRuntimeAcceptanceReport({
        plan,
        steps: [
          {
            ...plan.steps[0],
            status: "passed",
            parsed,
            error: null,
          },
        ],
      });

      assert.deepEqual(report.finalReadiness.approvedPreclaimBase, {
        status: "failed",
        asserted: false,
      });
      assert.equal(report.preparationVerifierStatus, "failed");
      assert.equal(report.ok, false);
      assert.ok(
        report.diagnostics.some(
          (diagnostic) => diagnostic.code === "factory-preclaim-verify_invalid",
        ),
      );
    }
  });

  it("propagates run-scoped certificate SSH trust to every VM acceptance child command", () => {
    const plan = buildVmRuntimeAcceptancePlan({
      runId: "RUN-183",
      platformTarget: "ephemeral-run-183",
      ephemeralDatabaseUrl:
        "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_183",
      ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
      ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
      remote: "maintainer@relay-vm.example",
      sshPort: 22022,
      sshKnownHostsPath: "/tmp/vem-runtime-known-hosts",
      sshHostKeyAlias: "vem-runtime-run-183",
    });
    for (const step of plan.steps.filter((step) =>
      ["approved preclaim base verification", "runtime acceptance"].includes(
        step.name,
      ),
    )) {
      assert.equal(commandArg(step.command, "--ssh-port"), "22022");
      assert.equal(
        commandArg(step.command, "--ssh-known-hosts-path"),
        "/tmp/vem-runtime-known-hosts",
      );
      assert.equal(
        commandArg(step.command, "--ssh-host-key-alias"),
        "vem-runtime-run-183",
      );
    }
    for (const saleStep of plan.steps.filter(
      (step) => step.mode === "installed-kiosk-sale",
    )) {
      assert.equal(commandArg(saleStep.command, "--ssh-port"), "22022");
      assert.equal(
        commandArg(saleStep.command, "--ssh-known-hosts-path"),
        "/tmp/vem-runtime-known-hosts",
      );
      assert.equal(
        commandArg(saleStep.command, "--ssh-host-key-alias"),
        "vem-runtime-run-183",
      );
    }
  });

  it("does not assert clean-base acceptance from invalid or dry-run evidence", () => {
    const plan = buildVmRuntimeAcceptancePlan({
      runId: "RUN-182",
      platformTarget: "ephemeral-run-182",
      ephemeralDatabaseUrl:
        "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_182",
      ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
      ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
      cleanBaseEvidence:
        "artifacts/clean-base-factory-acceptance/RUN-182/clean-base-factory-acceptance.json",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });

    const report = buildVmRuntimeAcceptanceReport({
      plan,
      steps: [
        {
          ...plan.steps[0],
          status: "passed",
          parsed: {
            ok: false,
            dryRun: true,
            dirtyHostFactoryAcceptance: {
              result: "passed",
            },
          },
        },
        { ...plan.steps[1], status: "passed", parsed: {} },
      ],
    });

    assert.deepEqual(report.finalReadiness.cleanBasePreparationAcceptance, {
      status: "failed",
      asserted: false,
    });
    assert.equal(
      report.bringUpStateProgression.cleanBasePreparationAcceptance,
      "failed",
    );
    assert.ok(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "clean-base-factory-acceptance_invalid",
      ),
    );
  });

  it("redacts VM runtime acceptance final reports before writing CI artifacts", () => {
    const plan = buildVmRuntimeAcceptancePlan({
      runId: "RUN-181",
      platformTarget: "ephemeral-run-181",
      ephemeralDatabaseUrl:
        "postgres://vem_test:secret-db-pass@127.0.0.1:55432/vem_acceptance_run_181",
      ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
      ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
      daemonArtifactSha256: "a".repeat(64),
      machineUiArtifactSha256: "b".repeat(64),
    });
    const steps = [
      {
        ...plan.steps[0],
        status: "failed",
        exitCode: 1,
        stdoutPath: `${plan.artifacts.logsRoot}/01.stdout.log`,
        stderrPath: `${plan.artifacts.logsRoot}/01.stderr.log`,
        parsed: null,
        error:
          "postgres://vem_test:preclaim-db-pass@127.0.0.1:55432/vem_acceptance_run_181 token=preclaim-token password=preclaim-plain",
      },
      {
        ...plan.steps[1],
        status: "passed",
        exitCode: 0,
        stdoutPath: `${plan.artifacts.logsRoot}/02.stdout.log`,
        stderrPath: `${plan.artifacts.logsRoot}/02.stderr.log`,
        parsed: ephemeralPlatformEvidence({
          testbedMachine: {
            ...ephemeralPlatformEvidence().testbedMachine,
            claim: {
              ...ephemeralPlatformEvidence().testbedMachine.claim,
              claimCode: "CLAIM-SECRET-181",
            },
          },
        }),
        error: null,
      },
      {
        ...plan.steps[2],
        status: "failed",
        exitCode: 1,
        stdoutPath: `${plan.artifacts.logsRoot}/03.stdout.log`,
        stderrPath: `${plan.artifacts.logsRoot}/03.stderr.log`,
        parsed: null,
        error:
          'postgres://vem_test:secret-db-pass@127.0.0.1:55432/vem_acceptance_run_181 claimCode=CLAIM-SECRET-181 token=active-token password=plain {"claimCode":"CLAIM-SECRET-JSON","token":"json-token"}',
      },
    ];

    const report = buildVmRuntimeAcceptanceReport({ plan, steps });
    const serialized = JSON.stringify(report);

    assert.equal(report.steps[0].command, undefined);
    assert.equal(report.steps[0].parsed, undefined);
    assert.equal(report.steps[1].parsed, undefined);
    assert.doesNotMatch(serialized, /secret-db-pass/);
    assert.doesNotMatch(serialized, /preclaim-db-pass/);
    assert.doesNotMatch(serialized, /preclaim-token/);
    assert.doesNotMatch(serialized, /password=preclaim-plain/);
    assert.doesNotMatch(serialized, /CLAIM-SECRET-181/);
    assert.doesNotMatch(serialized, /active-ipc-token/);
    assert.doesNotMatch(serialized, /active-token/);
    assert.doesNotMatch(serialized, /CLAIM-SECRET-JSON/);
    assert.doesNotMatch(serialized, /json-token/);
    assert.doesNotMatch(serialized, /password=plain/);
    assert.match(serialized, /\[REDACTED\]/);
  });

  it("sanitizes factory preclaim verifier output before emitting CI evidence", () => {
    const sanitized = sanitizeFactoryPreclaimReport({
      failures: [
        "probe failed --api-key plain-api-key --credential=plain-credential",
        "retry --token plain-token --client-secret 'plain-client-secret'",
        "PowerShell -ApiKey powershell-api-key -Credential 'powershell-credential'",
      ],
      checks: {
        machineUiStartup: {
          arguments:
            "--private-key plain-private-key --password=plain-password -Token powershell-token -Password=powershell-password",
        },
      },
    });
    const serialized = JSON.stringify(sanitized);
    for (const secret of [
      "plain-api-key",
      "plain-credential",
      "plain-token",
      "plain-client-secret",
      "plain-private-key",
      "plain-password",
      "powershell-api-key",
      "powershell-credential",
      "powershell-token",
      "powershell-password",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(secret));
    }
    assert.match(serialized, /\[REDACTED\]/);

    const source = readFileSync(
      new URL("./win10-vem-e2e.mjs", import.meta.url),
      "utf8",
    );
    const preclaimBranch = source.slice(
      source.indexOf('if (options.mode === "factory-preclaim-verify")'),
      source.indexOf('if (options.mode === "vm-runtime-acceptance")'),
    );

    assert.match(preclaimBranch, /sanitizeFactoryPreclaimReport\(report\)/);
    assert.match(
      preclaimBranch,
      /writeJsonOutput\(options\.out, sanitizedReport\)/,
    );
    assert.doesNotMatch(
      preclaimBranch,
      /process\.stdout\.write\(result\.stdout\)/,
    );
  });

  it("indexes existing display and session evidence into VM runtime acceptance artifact directories", () => {
    const temp = mkdtempSync(join(tmpdir(), "vem-vm-evidence-index-"));
    try {
      const plan = buildVmRuntimeAcceptancePlan({
        runId: "RUN-181",
        evidenceRoot: temp,
        platformTarget: "ephemeral-run-181",
        ephemeralDatabaseUrl:
          "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_181",
        ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
        ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
        daemonArtifactSha256: "a".repeat(64),
        machineUiArtifactSha256: "b".repeat(64),
      });
      const steps = [
        {
          ...plan.steps[0],
          status: "passed",
          parsed: {
            inventory: {
              displayEvidence: {
                interactiveWindowsSessions: {
                  sessions: [
                    {
                      user: "VEMKiosk",
                      sessionId: 3,
                      state: "Active",
                      source: "quser",
                    },
                  ],
                },
              },
            },
          },
        },
        {
          ...plan.steps[2],
          status: "passed",
          report: plan.artifacts.runtimeAcceptance,
          parsed: {
            runtimeAcceptanceReport: runtimeAcceptanceFacts().displayEvidence
              ? {
                  displayEvidence: runtimeAcceptanceFacts().displayEvidence,
                }
              : null,
          },
        },
      ];

      writeVmRuntimeAcceptanceEvidenceIndexes({ plan, steps });

      const screenshotIndex = JSON.parse(
        readFileSync(`${plan.artifacts.screenshotsRoot}/index.json`, "utf8"),
      );
      const sessionIndex = JSON.parse(
        readFileSync(`${plan.artifacts.sessionsRoot}/index.json`, "utf8"),
      );

      assert.equal(screenshotIndex.status, "missing");
      assert.equal(screenshotIndex.displayEvidence.length, 2);
      assert.equal(screenshotIndex.missingReason, "no_screenshot_artifacts");
      assert.equal(sessionIndex.status, "indexed");
      assert.equal(sessionIndex.sessions.length, 1);
      assert.equal(sessionIndex.sessions[0].user, "VEMKiosk");
      assert.equal(sessionIndex.stepArtifacts.length, 2);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects VM runtime acceptance when the platform target is shared or sale-flow evidence cannot be same-run", () => {
    assert.throws(
      () =>
        buildVmRuntimeAcceptancePlan({
          runId: "RUN-181",
          platformTarget: "vem-vps",
          ephemeralDatabaseUrl:
            "postgres://vem_test:pass@127.0.0.1:55432/vem_acceptance_run_181",
          ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
          ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
          daemonArtifactSha256: "a".repeat(64),
          machineUiArtifactSha256: "b".repeat(64),
        }),
      /refuses shared platform target/,
    );

    assert.throws(
      () =>
        buildVmRuntimeAcceptancePlan({
          runId: "RUN-181",
          platformTarget: "ephemeral-run-181",
          ephemeralDatabaseUrl:
            "postgres://vem_test:pass@118.25.104.160:5432/vem_acceptance",
          ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
          ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
          daemonArtifactSha256: "a".repeat(64),
          machineUiArtifactSha256: "b".repeat(64),
        }),
      /refuses known VPS or production endpoint/,
    );

    assert.throws(
      () =>
        buildVmRuntimeAcceptancePlan({
          runId: "RUN-181",
          platformTarget: "ephemeral-run-181",
          ephemeralDatabaseUrl:
            "postgres://vem_test:pass@127.0.0.1:55432/vem_prod",
          ephemeralApiBaseUrl: "http://127.0.0.1:26849/api",
          ephemeralMqttUrl: "mqtt://127.0.0.1:1883",
          daemonArtifactSha256: "a".repeat(64),
          machineUiArtifactSha256: "b".repeat(64),
        }),
      /refuses known production database/,
    );
  });

  it("classifies a complete runtime acceptance report without asserting hardware or sell readiness", () => {
    const report = buildRuntimeAcceptanceReport(runtimeAcceptanceFacts());

    assert.equal(report.schemaVersion, "runtime-acceptance-report/v1");
    assert.equal(report.mode, "fresh_bring_up");
    assert.equal(report.provisioning.machineCode, "VEM-TESTBED-WINVM-01");
    assert.deepEqual(report.result.runtimeReady, {
      status: "passed",
      asserted: true,
    });
    assert.deepEqual(report.result.simulatedHardwareReady, {
      status: "not_asserted",
      asserted: false,
    });
    assert.deepEqual(report.result.sellReady, {
      status: "not_asserted",
      asserted: false,
    });
    assert.deepEqual(report.diagnostics, []);
  });

  it("does not pass runtime-ready when required report facts are missing", () => {
    const facts = runtimeAcceptanceFacts({
      readyFile: {
        exists: false,
        readableByKioskUser: false,
        ipcEndpointPresent: false,
        tokenPresent: false,
      },
      daemonRuntime: {
        ipcReachable: false,
        healthz: {
          backendOnline: false,
          mqttConnected: false,
          hardwareOnline: false,
          scannerOnline: false,
        },
        readyz: {
          ready: false,
        },
      },
    });

    const report = buildRuntimeAcceptanceReport(facts);

    assert.deepEqual(report.result.runtimeReady, {
      status: "failed",
      asserted: false,
    });
    assert.deepEqual(report.result.simulatedHardwareReady, {
      status: "not_asserted",
      asserted: false,
    });
    assert.deepEqual(report.result.sellReady, {
      status: "not_asserted",
      asserted: false,
    });
    assert.ok(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === "ready_file_missing",
      ),
    );
    assert.ok(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === "daemon_ipc_unreachable",
      ),
    );
  });

  it("fails runtime-ready when daemon config identity is missing, stale, or not the target testbed machine", () => {
    for (const [machineCode, expectedCode] of [
      [null, "daemon_config_machine_identity_missing"],
      ["VEM-WIN10-REAL-01", "daemon_config_machine_identity_required"],
      ["VEM-TESTBED-OLD-01", "daemon_config_machine_identity_mismatch"],
    ]) {
      const report = buildRuntimeAcceptanceReport(
        runtimeAcceptanceFacts({
          provisioning: {
            provisioned: true,
            usedDaemonIpcTaskExecute: true,
            machineCode,
          },
        }),
      );

      assert.deepEqual(report.result.runtimeReady, {
        status: "failed",
        asserted: false,
      });
      assert.ok(
        report.diagnostics.some(
          (diagnostic) => diagnostic.code === expectedCode,
        ),
      );
    }
  });

  it("validates scheduled-task startup command evidence in the script classifier", () => {
    for (const [mutate, expectedCode] of [
      [
        (facts) => {
          facts.startupBringup.startupCommands = [];
        },
        "machine_ui_startup_command_missing",
      ],
      [
        (facts) => {
          facts.startupBringup.startupCommands[0].runAsUser = "YKDZ";
        },
        "machine_ui_startup_command_user_mismatch",
      ],
      [
        (facts) => {
          facts.startupBringup.startupCommands[0].command =
            "C:\\VEM\\bringup\\machine.exe";
        },
        "machine_ui_startup_command_path_mismatch",
      ],
      [
        (facts) => {
          facts.startupBringup.startupCommands[0].arguments =
            '"C:\\VEM\\bringup\\test-only-launcher.vbs"';
        },
        "machine_ui_startup_arguments_mismatch",
      ],
      [
        (facts) => {
          facts.startupBringup.startupCommands[0].workingDirectory = "C:\\VEM";
        },
        "machine_ui_startup_working_directory_mismatch",
      ],
    ]) {
      const facts = runtimeAcceptanceFacts();
      mutate(facts);

      const report = buildRuntimeAcceptanceReport(facts);

      assert.deepEqual(report.result.runtimeReady, {
        status: "failed",
        asserted: false,
      });
      assert.ok(
        report.diagnostics.some(
          (diagnostic) => diagnostic.code === expectedCode,
        ),
      );
    }
  });

  it("preserves shell launcher allowance in the script classifier", () => {
    const facts = runtimeAcceptanceFacts();
    facts.serviceState.machineUiTask = {
      name: "VEMMachineUI",
      exists: false,
      enabled: false,
      runAsUser: "unknown",
    };
    facts.startupBringup.machineUiStartup = {
      configured: true,
      mode: "shell_launcher",
      runAsUser: "VEMKiosk",
      command: "C:\\VEM\\bringup\\machine.exe",
    };
    facts.startupBringup.startupCommands = [];

    const report = buildRuntimeAcceptanceReport(facts);

    assert.deepEqual(report.result.runtimeReady, {
      status: "passed",
      asserted: true,
    });
    assert.deepEqual(report.diagnostics, []);
  });

  it("fails runtime-ready when kiosk session ids are missing", () => {
    const facts = runtimeAcceptanceFacts();
    facts.displayEvidence.interactiveDesktopDisplayBaseline.sessionId = null;
    facts.displayEvidence.portraitKioskAcceptance.sessionId = null;
    facts.kioskRuntime.sessionId = null;

    const report = buildRuntimeAcceptanceReport(facts);

    assert.deepEqual(report.result.runtimeReady, {
      status: "failed",
      asserted: false,
    });
    assert.ok(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === "kiosk_session_id_missing",
      ),
    );
  });

  it("fails runtime-ready when normal kiosk UI can reach Windows desktop surfaces", () => {
    for (const [field, expectedCode] of [
      ["desktopVisible", "kiosk_desktop_visible"],
      ["taskbarVisible", "kiosk_taskbar_visible"],
      ["startMenuVisible", "kiosk_start_menu_visible"],
      ["edgeReachable", "kiosk_edge_reachable"],
      ["fileExplorerReachable", "kiosk_file_explorer_reachable"],
    ]) {
      const facts = runtimeAcceptanceFacts({
        kioskDesktopEscape: {
          desktopVisible: false,
          taskbarVisible: false,
          startMenuVisible: false,
          edgeReachable: false,
          fileExplorerReachable: false,
          [field]: true,
        },
      });

      const report = buildRuntimeAcceptanceReport(facts);

      assert.deepEqual(report.result.runtimeReady, {
        status: "failed",
        asserted: false,
      });
      assert.ok(
        report.diagnostics.some(
          (diagnostic) => diagnostic.code === expectedCode,
        ),
      );
    }
  });

  it("fails runtime-ready when desktop escape surfaces are not explicitly observed", () => {
    for (const kioskDesktopEscape of [
      undefined,
      {
        status: "not_asserted",
        source: "process_presence_only",
        interactiveProbe: {
          status: "not_available",
          message: "interactive desktop escape probe is not available",
        },
        processPresence: {
          explorer: [{ processId: 100, sessionId: 3, ownerUser: "VEMKiosk" }],
          edge: [],
          startMenu: [],
        },
      },
    ]) {
      const report = buildRuntimeAcceptanceReport(
        runtimeAcceptanceFacts({ kioskDesktopEscape }),
      );

      assert.deepEqual(report.result.runtimeReady, {
        status: "failed",
        asserted: false,
      });
      assert.ok(
        report.diagnostics.some((diagnostic) =>
          diagnostic.code.endsWith("_observation_missing"),
        ),
      );
    }
  });

  it("fails runtime-ready when CDP listener is not bound to machine.exe", () => {
    for (const kioskRuntime of [
      { ...runtimeAcceptanceFacts().kioskRuntime, cdpListenerProcessId: null },
      { ...runtimeAcceptanceFacts().kioskRuntime, cdpListenerSessionId: 7 },
      {
        ...runtimeAcceptanceFacts().kioskRuntime,
        cdpMachineAncestorProcessId: 999,
      },
    ]) {
      const report = buildRuntimeAcceptanceReport(
        runtimeAcceptanceFacts({ kioskRuntime }),
      );
      assert.equal(report.result.runtimeReady.status, "failed");
      assert.ok(
        report.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "kiosk_cdp_process_binding_missing",
        ),
      );
    }
  });

  it("uses runtime acceptance result when deciding local process exit status", () => {
    assert.equal(
      getRuntimeAcceptanceExitStatus({
        mode: "runtime-acceptance",
        sshStatus: 0,
        stdout: JSON.stringify({
          ok: true,
          runtimeAcceptanceReport: {
            result: {
              runtimeReady: { status: "failed", asserted: false },
            },
          },
        }),
      }),
      1,
    );
    assert.equal(
      getRuntimeAcceptanceExitStatus({
        mode: "runtime-acceptance",
        sshStatus: 0,
        stdout: JSON.stringify({
          ok: true,
          runtimeAcceptanceReport: {
            result: {
              runtimeReady: { status: "passed", asserted: true },
            },
          },
        }),
      }),
      0,
    );
    assert.equal(
      getRuntimeAcceptanceExitStatus({
        mode: "simulated-hardware-sale-flow",
        sshStatus: 0,
        stdout: JSON.stringify({
          ok: true,
          simulatedHardwareSaleFlow: {
            result: {
              simulatedHardwareReady: { status: "passed", asserted: true },
            },
          },
        }),
      }),
      1,
    );
    assert.equal(
      getRuntimeAcceptanceExitStatus({
        mode: "simulated-hardware-sale-flow",
        sshStatus: 0,
        stdout: JSON.stringify({
          ok: true,
          simulatedHardwareSaleFlow: {
            result: {
              simulatedHardwareReady: { status: "failed", asserted: false },
            },
          },
        }),
      }),
      1,
    );
    assert.equal(
      getRuntimeAcceptanceExitStatus({
        mode: "inventory",
        sshStatus: 0,
        stdout: "",
      }),
      0,
    );
  });

  it("builds Controlled Maintenance Ingress SSH commands without requiring the real VM in tests", () => {
    assert.throws(
      () => buildSshCommand(),
      /certificate-only SSH requires --identity and --certificate/,
    );
    assert.deepEqual(buildSshCommand(CERTIFICATE_SSH_OPTIONS), [
      "ssh",
      ...CERTIFICATE_SSH_ARGS,
      "-o",
      "ProxyCommand=none",
      "YKDZ@controlled-maintenance-ingress.local",
    ]);
    assert.deepEqual(
      buildSshCommand({
        ...CERTIFICATE_SSH_OPTIONS,
        remote: "maintainer@relay-vm.example",
        proxyCommand: "ssh -W %h:%p arbitrary.example",
      }),
      [
        "ssh",
        ...CERTIFICATE_SSH_ARGS,
        "-o",
        "ProxyCommand=none",
        "maintainer@relay-vm.example",
      ],
    );
  });

  it("applies the certificate-only SSH options to SCP", () => {
    assert.deepEqual(
      buildScpCommand(
        "/tmp/run.ps1",
        "C:\\Users\\YKDZ\\AppData\\Local\\Temp\\vem-win10-e2e-test.ps1",
        CERTIFICATE_SSH_OPTIONS,
      ),
      [
        "scp",
        "-O",
        ...CERTIFICATE_SSH_ARGS,
        "-o",
        "ProxyCommand=none",
        "/tmp/run.ps1",
        "YKDZ@controlled-maintenance-ingress.local:C:/Users/YKDZ/AppData/Local/Temp/vem-win10-e2e-test.ps1",
      ],
    );
  });

  it("uses uppercase SCP port forwarding while SSH children use lowercase -p", () => {
    const options = { ...CERTIFICATE_SSH_OPTIONS, sshPort: 22022 };
    assert.deepEqual(buildSshCommand(options).slice(-5, -1), [
      "-p",
      "22022",
      "-o",
      "ProxyCommand=none",
    ]);
    const scpCommand = buildScpCommand(
      "/tmp/run.ps1",
      "C:\\Temp\\run.ps1",
      options,
    );
    assert.deepEqual(
      scpCommand.slice(scpCommand.indexOf("-P"), scpCommand.indexOf("-P") + 2),
      ["-P", "22022"],
    );
  });

  it("executes generated PowerShell through a temporary remote script instead of an oversized encoded command", () => {
    assert.equal(
      buildRemotePowerShellCommand(
        "C:\\Users\\YKDZ\\AppData\\Local\\Temp\\vem-win10-e2e-test.ps1",
      ),
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& 'C:\\Users\\YKDZ\\AppData\\Local\\Temp\\vem-win10-e2e-test.ps1'\"",
    );
    assert.doesNotMatch(
      buildRemotePowerShellCommand(
        "C:\\Users\\YKDZ\\AppData\\Local\\Temp\\vem-win10-e2e-test.ps1",
      ),
      /EncodedCommand/,
    );
    assert.deepEqual(
      buildScpCommand(
        "/tmp/run.ps1",
        "C:\\Users\\YKDZ\\AppData\\Local\\Temp\\vem-win10-e2e-test.ps1",
        CERTIFICATE_SSH_OPTIONS,
      ),
      [
        "scp",
        "-O",
        ...CERTIFICATE_SSH_ARGS,
        "-o",
        "ProxyCommand=none",
        "/tmp/run.ps1",
        "YKDZ@controlled-maintenance-ingress.local:C:/Users/YKDZ/AppData/Local/Temp/vem-win10-e2e-test.ps1",
      ],
    );
  });
});
