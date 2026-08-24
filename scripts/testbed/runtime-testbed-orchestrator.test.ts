import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createRunId,
  guestAcceptanceExecuteCommand,
  identicalVisionCoreArtifactSnapshot,
  guestAcceptanceExecutionBudget,
  additionalStartupRebootObservationOrdinals,
  collectStartupRebootObservations,
  guardedRemovePowerShell,
  materializeVisionCoreArtifactSnapshot,
  parseOrchestratorOptions,
  processReplayGuestDirectory,
  powerShellFocusArgument,
  reconstructedAcceptancePasses,
  stageGuestInputs,
  summarizeGuestBusinessFailures,
  validateHostConfig,
  waitForGuestReboot,
} from "./runtime-testbed-orchestrator.ts";
import { parseTriggerOptions } from "./runtime-testbed-trigger.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

type Registry = NonNullable<
  Parameters<typeof guestAcceptanceExecutionBudget>[0]["registry"]
>;

const sha = "a".repeat(40);
const coreFocusedBusinessSets = [
  "visionExperience",
  "pickupProtocol",
  "presenceAndAudio",
  "paymentRecovery",
  "stockMaintenance",
  "localOperations",
];
const visionCore = (root: string) => ({
  runtimeArchive: {
    hostPath: join(root, "vision-runtime.zip"),
    sha256: "b".repeat(64),
    byteSize: 1,
    sourceCommit: "c".repeat(40),
  },
  recordedFixtureArchive: {
    hostPath: join(root, "recorded-fixtures.zip"),
    sha256: "d".repeat(64),
    byteSize: 1,
    sourceCommit: "e".repeat(40),
  },
});

function digest(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

describe("runtime testbed scheduler contract", () => {
  it("uses the host-adapter logical run identity", () => {
    assert.equal(
      createRunId("abcdef1234567890".padEnd(40, "0"), "fast", 1234),
      "RUN-1234-ABCDEF123456-FAST",
    );
  });

  it("keeps reconstruction pass identities uppercase", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /`\$\{runId\}-PASS-\$\{pass\}`/);
    assert.doesNotMatch(source, /`\$\{runId\}-pass-/);
  });

  it("summarizes guest business failures with set, reason, and report path", () => {
    assert.equal(
      summarizeGuestBusinessFailures({
        businessOutcome: {
          failures: [
            {
              set: "sale",
              reason: "DaemonUnavailableError: daemon request failed",
              reportPath: "C:\\ProgramData\\VEM\\testbed\\sale.json",
            },
          ],
        },
      }),
      "sale: DaemonUnavailableError: daemon request failed (report: C:\\ProgramData\\VEM\\testbed\\sale.json)",
    );
    assert.equal(
      summarizeGuestBusinessFailures({
        businessOutcome: { failures: [] },
      }),
      null,
    );
    assert.equal(summarizeGuestBusinessFailures(null), null);
  });
  it("accepts one committed revision and host-local config", () => {
    assert.deepEqual(
      parseOrchestratorOptions([
        "run",
        "--mode",
        "fast",
        "--commit",
        sha,
        "--config",
        "/etc/vem/testbed.json",
      ]),
      {
        command: "run",
        mode: "fast",
        commit: sha,
        focus: [],
        runId: undefined,
        configPath: "/etc/vem/testbed.json",
      },
    );
  });

  it("deduplicates selection later but preserves repeatable fast focus input", () => {
    assert.deepEqual(
      parseOrchestratorOptions([
        "run",
        "--mode",
        "fast",
        "--focus",
        "sale",
        "--focus",
        "sale",
        "--commit",
        sha,
        "--config",
        "/etc/vem/testbed.json",
      ]).focus,
      ["sale", "sale"],
    );
    assert.deepEqual(
      parseOrchestratorOptions([
        "run",
        "--mode",
        "full",
        "--focus",
        "startup",
        "--commit",
        sha,
        "--config",
        "/etc/vem/testbed.json",
      ]).focus,
      ["startup"],
    );
    assert.deepEqual(
      parseTriggerOptions([
        "run",
        "--mode",
        "full",
        "--focus",
        "startup",
        "--commit",
        sha,
        "--config",
        "/etc/vem/testbed.json",
        "--out",
        "/tmp/result.json",
      ]).focus,
      ["startup"],
    );
    assert.throws(
      () =>
        parseOrchestratorOptions([
          "run",
          "--mode",
          "clear_cache",
          "--focus",
          "sale",
          "--commit",
          sha,
          "--config",
          "/etc/vem/testbed.json",
        ]),
      /--focus is only valid with --mode fast or full/,
    );
    assert.throws(
      () =>
        parseTriggerOptions([
          "run",
          "--mode",
          "clear_cache",
          "--focus",
          "sale",
          "--commit",
          sha,
          "--config",
          "/etc/vem/testbed.json",
          "--out",
          "/tmp/result.json",
        ]),
      /--focus is only valid with --mode fast or full/,
    );
  });

  it("passes multiple focused sets as one PowerShell array parameter", () => {
    assert.equal(powerShellFocusArgument([]), "");
    assert.equal(
      powerShellFocusArgument(["sale", "scannerPayment", "name'quoted"]),
      " -Focus @('sale', 'scannerPayment', 'name''quoted')",
    );
  });

  it("只在显式开启时把过程回放环境注入 guest 执行命令", () => {
    const base = {
      guestScript: "C:\\source\\run-local-testbed-guest.ps1",
      mode: "fast",
      commit: sha,
      pass: 1,
      focusArgument: "",
    };
    assert.equal(
      guestAcceptanceExecuteCommand(base),
      `& 'C:\\source\\run-local-testbed-guest.ps1' -Mode 'fast' -Commit '${sha}' -Pass 1 -StartupPhase 'single'`,
    );
    const withReplay = guestAcceptanceExecuteCommand({
      ...base,
      guestEnvironment: [
        { name: "VEM_PROCESS_REPLAY", value: "1" },
        {
          name: "VEM_PROCESS_REPLAY_DIR",
          value: "C:\\ProgramData\\VEM\\testbed\\process-replay-pass-1",
        },
      ],
    });
    assert.match(withReplay, /^\$env:VEM_PROCESS_REPLAY = '1'; /);
    assert.match(
      withReplay,
      /\$env:VEM_PROCESS_REPLAY_DIR = 'C:\\ProgramData\\VEM\\testbed\\process-replay-pass-1'; /,
    );
    assert.match(withReplay, /-Pass 1 -StartupPhase 'single'$/);
    const withScenarios = guestAcceptanceExecuteCommand({
      ...base,
      guestEnvironment: [
        { name: "RUN_MANUAL", value: "1" },
        { name: "RUN_DEPARTURE", value: "1" },
      ],
    });
    assert.match(withScenarios, /^\$env:RUN_MANUAL = '1'; /);
    assert.match(withScenarios, /\$env:RUN_DEPARTURE = '1'; /);
    assert.match(
      guestAcceptanceExecuteCommand({
        ...base,
        mode: "full",
        startupPhase: "prepare_reboot",
      }),
      /-StartupPhase 'prepare_reboot'$/,
    );
  });

  it("显式过程回放同时支持 fast 与最终 full，并排除 clear_cache", () => {
    assert.equal(
      processReplayGuestDirectory({ enabled: true, mode: "fast", pass: 1 }),
      "C:\\ProgramData\\VEM\\testbed\\process-replay-pass-1",
    );
    assert.equal(
      processReplayGuestDirectory({ enabled: true, mode: "full", pass: 2 }),
      "C:\\ProgramData\\VEM\\testbed\\process-replay-pass-2",
    );
    assert.equal(
      processReplayGuestDirectory({
        enabled: true,
        mode: "clear_cache",
        pass: 1,
      }),
      null,
    );
    assert.equal(
      processReplayGuestDirectory({ enabled: false, mode: "full", pass: 1 }),
      null,
    );
  });

  it("清理尚不存在的过程回放目录时不污染 Windows PowerShell 退出码", () => {
    assert.deepEqual(guardedRemovePowerShell(null), []);
    assert.deepEqual(
      guardedRemovePowerShell(
        "C:\\ProgramData\\VEM\\testbed\\process-replay-pass-1",
        { recursive: true },
      ),
      [
        "$guardedRemovePath = 'C:\\ProgramData\\VEM\\testbed\\process-replay-pass-1'",
        "if (Test-Path -LiteralPath $guardedRemovePath) { Remove-Item -LiteralPath $guardedRemovePath -Recurse -Force -ErrorAction Stop }",
      ],
    );
  });

  it("首次重启观察没有旧文件时也使用无副作用的守卫清理", () => {
    assert.deepEqual(
      guardedRemovePowerShell(
        "C:\\ProgramData\\VEM\\testbed\\startup-reboot-observation.json",
      ),
      [
        "$guardedRemovePath = 'C:\\ProgramData\\VEM\\testbed\\startup-reboot-observation.json'",
        "if (Test-Path -LiteralPath $guardedRemovePath) { Remove-Item -LiteralPath $guardedRemovePath -Force -ErrorAction Stop }",
      ],
    );
  });

  it("waits for a reboot disconnect before accepting the reconnected guest", async () => {
    const observations = [true, true, false, false, true];
    let now = 0;
    await waitForGuestReboot({
      probe: async () => observations.shift() ?? true,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      pollMs: 10,
      disconnectTimeoutMs: 50,
      readyTimeoutMs: 50,
    });
    assert.deepEqual(observations, []);
  });

  it("rejects a reboot that never disconnects the old Windows boot", async () => {
    let now = 0;
    await assert.rejects(
      waitForGuestReboot({
        probe: async () => true,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        pollMs: 10,
        disconnectTimeoutMs: 30,
        readyTimeoutMs: 30,
      }),
      /did not disconnect/,
    );
  });

  it("runs full acceptance as prepare, real reboot, then resume", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    const prepare = source.indexOf('await runGuestPhase("prepare_reboot")');
    const reboot = source.indexOf(
      "await rebootGuestAfterOwnerInstall",
      prepare,
    );
    const resume = source.indexOf(
      'await runGuestPhase("resume_reboot")',
      reboot,
    );
    assert.ok(prepare >= 0 && prepare < reboot && reboot < resume);
  });

  it("uses one reconstructed pass for focused full and two for release full", () => {
    assert.equal(reconstructedAcceptancePasses("full", ["startup"]), 1);
    assert.equal(reconstructedAcceptancePasses("full", []), 2);
    assert.equal(reconstructedAcceptancePasses("fast", ["startup"]), 1);
  });

  it("adds eight lightweight same-install observations only after release full pass two", () => {
    assert.deepEqual(
      additionalStartupRebootObservationOrdinals({
        mode: "full",
        focus: [],
        pass: 2,
      }),
      [3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.deepEqual(
      additionalStartupRebootObservationOrdinals({
        mode: "full",
        focus: ["startup"],
        pass: 1,
      }),
      [],
    );
    assert.deepEqual(
      additionalStartupRebootObservationOrdinals({
        mode: "full",
        focus: [],
        pass: 1,
      }),
      [],
    );
    assert.deepEqual(
      additionalStartupRebootObservationOrdinals({
        mode: "fast",
        focus: [],
        pass: 1,
      }),
      [],
    );
  });

  it("stops the homogeneous reboot loop at the first failed observation", async () => {
    const invoked: number[] = [];
    const result = await collectStartupRebootObservations({
      ordinals: [3, 4, 5, 6],
      observe: async (ordinal) => {
        invoked.push(ordinal);
        return {
          ok: ordinal !== 4,
          reportPath: `/reports/reboot-${ordinal}.json`,
        };
      },
    });

    assert.deepEqual(invoked, [3, 4]);
    assert.deepEqual(result.reportPaths, [
      "/reports/reboot-3.json",
      "/reports/reboot-4.json",
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.firstFailureOrdinal, 4);
  });

  it("tells the guest which reconstructed pass owns the runtime build", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /-Pass \$\{pass\}/);
  });

  it("rejects abbreviated revisions and dirty snapshot modes", () => {
    assert.throws(
      () =>
        parseOrchestratorOptions([
          "run",
          "--mode",
          "debug",
          "--commit",
          "abc123",
          "--config",
          "/tmp/config.json",
        ]),
      /mode must be/,
    );
  });

  it("keeps host identity and paths in an external config", () => {
    const root = "/var/lib/vem-testbed";
    assert.deepEqual(
      validateHostConfig({
        schemaVersion: "vem-runtime-testbed-host/v1",
        mirrorPath: join(root, "mirror.git"),
        workspaceRoot: join(root, "workspaces"),
        stateRoot: join(root, "state"),
        baselineContract: join(root, "baseline.json"),
        hostPrivateAddress: "192.0.2.22",
        guestSourcePath: "C:\\VEM\\source",
        visionCoreArtifacts: visionCore(root),
        environment: { CARGO_HOME: join(root, "cargo") },
        pathPrepend: [join(root, "cargo", "bin")],
      }),
      {
        schemaVersion: "vem-runtime-testbed-host/v1",
        mirrorPath: join(root, "mirror.git"),
        workspaceRoot: join(root, "workspaces"),
        stateRoot: join(root, "state"),
        baselineContract: join(root, "baseline.json"),
        hostPrivateAddress: "192.0.2.22",
        guestSourcePath: "C:\\VEM\\source",
        environment: { CARGO_HOME: join(root, "cargo") },
        pathPrepend: [join(root, "cargo", "bin")],
        visionCoreArtifacts: visionCore(root),
      },
    );
  });

  it("requires independent host-local Vision core artifacts", () => {
    assert.throws(
      () =>
        validateHostConfig({
          schemaVersion: "vem-runtime-testbed-host/v1",
          mirrorPath: "/var/lib/vem-testbed/mirror.git",
          workspaceRoot: "/var/lib/vem-testbed/workspaces",
          stateRoot: "/var/lib/vem-testbed/state",
          baselineContract: "/var/lib/vem-testbed/baseline.json",
          hostPrivateAddress: "192.0.2.22",
          guestSourcePath: "C:\\VEM\\source",
        }),
      /visionCoreArtifacts must contain exact-two artifacts/,
    );
    assert.throws(
      () =>
        validateHostConfig({
          schemaVersion: "vem-runtime-testbed-host/v1",
          mirrorPath: "/var/lib/vem-testbed/mirror.git",
          workspaceRoot: "/var/lib/vem-testbed/workspaces",
          stateRoot: "/var/lib/vem-testbed/state",
          baselineContract: "/var/lib/vem-testbed/baseline.json",
          hostPrivateAddress: "192.0.2.22",
          guestSourcePath: "C:\\VEM\\source",
          visionCoreArtifacts: {
            ...visionCore("/var/lib/vem-testbed"),
            runtimeArchive: {
              ...visionCore("/var/lib/vem-testbed").runtimeArchive,
              hostPath: "vision-runtime.zip",
              unexpected: true,
            },
          },
        }),
      /fields are invalid/,
    );
    assert.throws(
      () =>
        validateHostConfig({
          schemaVersion: "vem-runtime-testbed-host/v1",
          mirrorPath: "/var/lib/vem-testbed/mirror.git",
          workspaceRoot: "/var/lib/vem-testbed/workspaces",
          stateRoot: "/var/lib/vem-testbed/state",
          baselineContract: "/var/lib/vem-testbed/baseline.json",
          hostPrivateAddress: "192.0.2.22",
          guestSourcePath: "C:\\VEM\\source",
          visionCoreArtifacts: {
            ...visionCore("/var/lib/vem-testbed"),
            extraArchive: {},
          },
        }),
      /exact-two artifacts/,
    );
    const guest = readFileSync(
      new URL("./run-local-testbed-guest.ps1", import.meta.url),
      "utf8",
    );
    assert.match(
      guest,
      /function Get-TestbedProvisionedVisionCoreArtifact[\s\S]*Properties\["visionCore"\]/,
    );
    assert.doesNotMatch(guest, /Get-VisionMainArtifactCache/);
  });

  it("snapshots the exact two Vision core archives without a guest cache fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vision-core-input-"));
    try {
      const runtime = Buffer.from("runtime archive");
      const fixture = Buffer.from("recorded fixture archive");
      writeFileSync(join(root, "vision-runtime.zip"), runtime);
      writeFileSync(join(root, "recorded-fixtures.zip"), fixture);
      const config = validateHostConfig({
        schemaVersion: "vem-runtime-testbed-host/v1",
        mirrorPath: join(root, "mirror.git"),
        workspaceRoot: join(root, "workspaces"),
        stateRoot: join(root, "state"),
        baselineContract: join(root, "baseline.json"),
        hostPrivateAddress: "192.0.2.22",
        guestSourcePath: "C:\\VEM\\source",
        visionCoreArtifacts: {
          runtimeArchive: {
            hostPath: join(root, "vision-runtime.zip"),
            sha256: digest(runtime),
            byteSize: runtime.length,
            sourceCommit: "c".repeat(40),
          },
          recordedFixtureArchive: {
            hostPath: join(root, "recorded-fixtures.zip"),
            sha256: digest(fixture),
            byteSize: fixture.length,
            sourceCommit: "d".repeat(40),
          },
        },
      });
      const snapshot = await materializeVisionCoreArtifactSnapshot(
        config,
        join(root, "snapshots", "pass-1"),
      );
      assert.match(
        String(recordValue(recordValue(snapshot.guestInput).identity).sha256),
        /^[a-f0-9]{64}$/,
      );
      assert.equal(
        recordValue(snapshot.guestInput).runtimeArchive,
        `D:\\runtime-cache\\v1\\acceptance-inputs\\files\\${digest(runtime)}\\vision-runtime.zip`,
      );
      assert.equal(
        recordValue(snapshot.guestInput).inputRoot,
        `D:\\runtime-cache\\v1\\acceptance-inputs\\vision-core\\${recordValue(recordValue(snapshot.guestInput).identity).sha256}`,
      );
      assert.equal(arrayValue(snapshot.transfers).length, 2);
      assert.ok(
        arrayValue(snapshot.transfers).every((entry: unknown) =>
          String(recordValue(entry).hostPath).includes("snapshots"),
        ),
      );
      assert.ok(
        arrayValue(snapshot.transfers).every(
          (entry: unknown) =>
            !String(recordValue(entry).hostPath).includes("vision-main"),
        ),
      );
      writeFileSync(join(root, "vision-runtime.zip"), "changed source");
      await assert.rejects(
        materializeVisionCoreArtifactSnapshot(
          config,
          join(root, "snapshots", "pass-2"),
        ),
        /Vision runtime host artifact (byte size|SHA-256) is invalid/,
      );
      assert.equal(
        identicalVisionCoreArtifactSnapshot(snapshot, {
          ...snapshot,
          guestInput: {
            ...recordValue(snapshot.guestInput),
            identity: {
              ...recordValue(recordValue(snapshot.guestInput).identity),
              sha256: "0".repeat(64),
            },
          },
        }),
        false,
      );
      const guest = readFileSync(
        new URL("./run-local-testbed-guest.ps1", import.meta.url),
        "utf8",
      );
      assert.match(guest, /Properties\["visionCore"\]/);
      assert.doesNotMatch(guest, /Get-VisionMainArtifactCache/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the same commit-only contract in the thin trigger", () => {
    assert.equal(
      parseTriggerOptions([
        "run",
        "--mode",
        "full",
        "--commit",
        sha,
        "--config",
        "/etc/vem/testbed.json",
        "--out",
        "/tmp/result.json",
      ]).commit,
      sha,
    );
  });

  it("creates the guest archive parent before source transfer", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      source.indexOf("createArchiveParent") <
        source.indexOf('await runProcess("scp"'),
    );
  });

  it("bounds guest SSH work and avoids the Windows SFTP hang path", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /function sshArguments[\s\S]*"ConnectTimeout=15"[\s\S]*"ServerAliveInterval=5"[\s\S]*"ServerAliveCountMax=3"/,
    );
    assert.match(
      source,
      /function scpArguments[\s\S]*"-O"[\s\S]*\.\.\.sshArguments\(guest\)/,
    );
    assert.match(
      source,
      /const scp = scpArguments\(guest\)[\s\S]*await runProcess\("scp", \[\.\.\.scp, archive/,
    );
  });

  it("fails bounded guest SSH work instead of waiting indefinitely", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /const GUEST_SETUP_TIMEOUT_MS = 120_000/);
    assert.match(source, /const GUEST_TRANSFER_TIMEOUT_MS = 300_000/);
    assert.match(
      source,
      /const GUEST_FAST_EXECUTION_TIMEOUT_MS = 15 \* 60_000/,
    );
    assert.match(source, /error\.timedOut = true/);
    assert.match(source, /timeoutLabel: phaseBudget\.timeoutLabel/);
    assert.match(
      source,
      /const GUEST_STARTUP_OBSERVATION_TIMEOUT_MS = 10 \* 60_000/,
    );
    assert.match(source, /child\.kill\("SIGTERM"\)/);
    assert.match(
      source,
      /processError\.exitCode === 255 \|\| processError\.timedOut === true/,
    );
  });

  it("extends the guest SSH execution budget for canonical multi-focus fast acceptance", () => {
    const budget = guestAcceptanceExecutionBudget({
      mode: "fast",
      focus: coreFocusedBusinessSets,
    });

    assert.ok(budget.timeoutMs >= 20 * 60_000);
    assert.equal(
      budget.selectedSets.join(","),
      coreFocusedBusinessSets.join(","),
    );
    assert.match(budget.timeoutLabel, /budgetMs=/);
    assert.match(budget.timeoutLabel, /selectedSets=/);
  });

  it("keeps a single focused business set within the former fast execution limit", () => {
    assert.equal(
      guestAcceptanceExecutionBudget({
        mode: "fast",
        focus: ["visionExperience"],
      }).timeoutMs,
      15 * 60_000,
    );
  });

  it("retains the 45-minute execution limit for full acceptance", () => {
    assert.equal(
      guestAcceptanceExecutionBudget({ mode: "full" }).timeoutMs,
      45 * 60_000,
    );
  });

  it("rejects unknown focus but saturates every legal canonical fast selection", () => {
    assert.throws(
      () =>
        guestAcceptanceExecutionBudget({
          mode: "fast",
          focus: ["unknownBusinessSet"],
        }),
      /unknown business check set: unknownBusinessSet/,
    );
    const registry = Array.from({ length: 8 }, (_, index) => ({
      name: `focused${index}`,
      core: false,
      fullRequired: true,
    })) as unknown as Registry;
    const eight = guestAcceptanceExecutionBudget({
      mode: "fast",
      focus: registry.map((descriptor) => descriptor.name),
      registry,
    });
    assert.equal(eight.timeoutMs, 45 * 60_000);
    assert.deepEqual(
      eight.selectedSets,
      registry.map((descriptor) => descriptor.name),
    );

    const expandedRegistry = Array.from({ length: 12 }, (_, index) => ({
      name: `expanded${index}`,
      core: false,
      fullRequired: true,
    })) as unknown as Registry;
    assert.equal(
      guestAcceptanceExecutionBudget({
        mode: "fast",
        focus: expandedRegistry.map((descriptor) => descriptor.name),
        registry: expandedRegistry,
      }).timeoutMs,
      45 * 60_000,
    );
  });

  it("stages only verified Vision core archives and the current guest projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vision-core-stage-"));
    try {
      writeFileSync(join(root, "guest-input.json"), "{}\n");
      const calls: JsonRecord[] = [];
      const corePreparation = {
        guestInput: {},
        transfers: [
          {
            hostPath: "/snapshot/vision-runtime.zip",
            guestPath:
              "D:\\runtime-cache\\v1\\acceptance-inputs\\files\\runtime-digest\\vision-runtime.zip",
            sha256: "a".repeat(64),
            byteSize: 128,
          },
          {
            hostPath: "/snapshot/recorded-fixtures.zip",
            guestPath:
              "D:\\runtime-cache\\v1\\acceptance-inputs\\files\\fixture-digest\\recorded-fixtures.zip",
            sha256: "b".repeat(64),
            byteSize: 64,
          },
        ],
      };
      const contract = {
        testbed: {
          guest: {
            user: "VEMKiosk",
            host: "win10-testbed.local",
            identityFile: "/tmp/id",
            knownHostsFile: "/tmp/known-hosts",
            stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
          },
        },
      };
      const hostConfig = validateHostConfig({
        schemaVersion: "vem-runtime-testbed-host/v1",
        mirrorPath: join(root, "mirror.git"),
        workspaceRoot: join(root, "workspaces"),
        stateRoot: join(root, "state"),
        baselineContract: join(root, "baseline.json"),
        hostPrivateAddress: "192.0.2.22",
        guestSourcePath: "C:\\VEM\\source",
        visionCoreArtifacts: {
          runtimeArchive: {
            hostPath: "/snapshot/vision-runtime.zip",
            sha256: "a".repeat(64),
            byteSize: 128,
            sourceCommit: "c".repeat(40),
          },
          recordedFixtureArchive: {
            hostPath: "/snapshot/recorded-fixtures.zip",
            sha256: "b".repeat(64),
            byteSize: 64,
            sourceCommit: "d".repeat(40),
          },
        },
      });
      await stageGuestInputs({
        config: hostConfig,
        contract,
        corePreparation,
        captureResult: async () => ({
          stdout: '{"cacheHits":[]}',
          stderr: "",
        }),
        run: async (command: string, args: string[], options?: unknown) => {
          calls.push({ command, args, options });
          return { code: 0, signal: null, pid: undefined };
        },
      });
      const destinations = calls
        .filter((call) => call.command === "scp")
        .map((call) => arrayValue(call.args).at(-1));
      assert.deepEqual(destinations, [
        "VEMKiosk@win10-testbed.local:D:\\runtime-cache\\v1\\acceptance-inputs\\files\\runtime-digest\\vision-runtime.zip",
        "VEMKiosk@win10-testbed.local:D:\\runtime-cache\\v1\\acceptance-inputs\\files\\fixture-digest\\recorded-fixtures.zip",
        "VEMKiosk@win10-testbed.local:C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      ]);
      assert.ok(calls.some((call) => call.command === "ssh"));

      const invalidCalls: unknown[] = [];
      await assert.rejects(
        stageGuestInputs({
          config: hostConfig,
          contract,
          corePreparation: {
            guestInput: {},
            transfers: [{ ...corePreparation.transfers[0], byteSize: 0 }],
          },
          captureResult: async (...args: unknown[]) => {
            invalidCalls.push(args);
            return { stdout: "", stderr: "" };
          },
          run: async (...args: unknown[]) => {
            invalidCalls.push(args);
            return { code: 0, signal: null, pid: undefined };
          },
        }),
        /positive safe integer/,
      );
      assert.deepEqual(invalidCalls, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compresses the commit archive before the guest transfer", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /source-pass-\$\{pass\}\.tar\.gz/);
    assert.match(source, /"--format=tar\.gz"/);
  });

  it("refreshes the current commit host runtime before every fast guest pass", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    const refresh = source.indexOf('"refresh-host-runtime"');
    const guest = source.indexOf("await stageAndRunGuest({", refresh);
    assert.ok(refresh >= 0 && refresh < guest);
    assert.match(source, /host-runtime-refresh-pass-\$\{pass\}\.json/);
    assert.match(
      source,
      /hostRuntimeRefresh:[\s\S]*timing: preparation\.timing/,
    );
    assert.match(
      source.slice(refresh, guest),
      /"--run-id",\s*fixtureIsCurrent \? runId : `\$\{runId\}-PASS-\$\{pass\}`/,
    );
    assert.match(
      source,
      /guestInput:[\s\S]*sha256: preparationGuestInput\.sha256/,
    );
  });

  it("reconstructs a fast host when the cached platform fixture is stale", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /fixtureIdentityForWorkspace\(workspace\)/);
    assert.match(
      source,
      /recordValue\(existingGuestInput\?\.fixtureIdentity\)\.sha256/,
    );
    assert.match(
      source,
      /recordValue\(\s*recordValue\(reconstructionMarker\?\.guestInput\)\.fixtureIdentity,\s*\)\.sha256/,
    );
    assert.match(source, /reconstruct-stale-fixture-pass-\$\{pass\}/);
    assert.match(
      source,
      /fixtureIsCurrent \? "refresh-host-runtime" : "reconstruct"/,
    );
  });

  it("reuses the existing cached PowerShell 7 guest entrypoint", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /ensure-testbed-pwsh\.ps1/);
    assert.match(source, /powershell\\\\7\.4\.6\\\\pwsh\.exe/);
  });

  it("collects evidence from the guest handoff root", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /C:\/ProgramData\/VEM\/testbed\/full-workflow/);
    assert.doesNotMatch(source, /C:\/ProgramData\/VEM\/runtime\/testbed/);
  });

  it("keeps terminal status writes from overwriting an old superseded terminal", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes('if (current.status === "superseded")'));
  });

  it("writes compact terminal status before canonical status", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    const compactWrite = source.indexOf(
      'await writeJson(join(compact, "status.json"), status);',
    );
    const canonicalWrite = source.indexOf(
      "await writeJson(statusPath(config, runId), status);",
    );
    assert.ok(
      compactWrite >= 0 && canonicalWrite >= 0 && compactWrite < canonicalWrite,
    );
  });

  it("treats bounded ssh/scp failures as infrastructure failures", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /\(processError\.command === "ssh" \|\| processError\.command === "scp"\)\s*&&\s*\(\s*processError\.exitCode === 255 \|\| processError\.timedOut === true\s*\)/,
    );
    assert.ok(
      source.includes("error.command = command;") &&
        source.includes("error.exitCode = code;") &&
        source.includes("error.timedOut = true;"),
    );
  });

  it("waits until old process groups are truly terminated before continuing", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      source.includes("if (processGroupExists(processGroupId)) {") &&
        source.includes("failed to terminate process group"),
    );
  });

  it("detaches workers from the caller streams and retains host logs", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /worker\.stdout\.log/);
    assert.match(source, /worker\.stderr\.log/);
    assert.match(source, /detached: true, stdio: \["ignore", stdout, stderr\]/);
    assert.doesNotMatch(source, /detached: true, stdio: "inherit"/);
  });
});
