import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createRunId,
  identicalVisionCoreArtifactSnapshot,
  guestAcceptanceExecutionBudget,
  loadVisionCoreArtifacts,
  materializeVisionCoreArtifactSnapshot,
  parseOrchestratorOptions,
  powerShellFocusArgument,
  provisionAiAcceptanceBlock,
  provisionAiAcceptanceGuestInput,
  stageAiAcceptanceInputs,
  summarizeGuestBusinessFailures,
  validateHostConfig,
} from "./runtime-testbed-orchestrator.mjs";
import { parseTriggerOptions } from "./runtime-testbed-trigger.mjs";

const sha = "a".repeat(40);
const sevenFocusedBusinessSets = [
  "visionExperience",
  "aiVirtualTryOn",
  "pickupProtocol",
  "presenceAndAudio",
  "paymentRecovery",
  "stockMaintenance",
  "localOperations",
];
const visionCore = (root) => ({
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

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compactCanonical(value) {
  const sort = (entry) =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, sort(entry[key])]),
          )
        : entry;
  return `${JSON.stringify(sort(value))}\n`;
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
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /`\$\{options\.runId\}-PASS-\$\{pass\}`/);
    assert.doesNotMatch(source, /`\$\{options\.runId\}-pass-/);
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
    assert.throws(
      () =>
        parseOrchestratorOptions([
          "run",
          "--mode",
          "full",
          "--focus",
          "sale",
          "--commit",
          sha,
          "--config",
          "/etc/vem/testbed.json",
        ]),
      /--focus is only valid with --mode fast/,
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
      /--focus is only valid with --mode fast/,
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
      /--focus is only valid with --mode fast/,
    );
  });

  it("passes multiple focused sets as one PowerShell array parameter", () => {
    assert.equal(powerShellFocusArgument([]), "");
    assert.equal(
      powerShellFocusArgument(["sale", "scannerPayment", "name'quoted"]),
      " -Focus @('sale', 'scannerPayment', 'name''quoted')",
    );
  });

  it("passes the independent AI virtual try-on focus through the host boundary", () => {
    const options = parseOrchestratorOptions([
      "run",
      "--mode",
      "fast",
      "--focus",
      "aiVirtualTryOn",
      "--commit",
      sha,
      "--config",
      "/etc/vem/testbed.json",
    ]);
    assert.deepEqual(options.focus, ["aiVirtualTryOn"]);
    assert.equal(
      powerShellFocusArgument(options.focus),
      " -Focus @('aiVirtualTryOn')",
    );
  });

  it("tells the guest which reconstructed pass owns the runtime build", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
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

  it("accepts only the functional AI input in host configuration", () => {
    const config = validateHostConfig({
      schemaVersion: "vem-runtime-testbed-host/v1",
      mirrorPath: "/var/lib/vem-testbed/mirror.git",
      workspaceRoot: "/var/lib/vem-testbed/workspaces",
      stateRoot: "/var/lib/vem-testbed/state",
      baselineContract: "/var/lib/vem-testbed/baseline.json",
      hostPrivateAddress: "192.0.2.22",
      guestSourcePath: "C:\\VEM\\source",
      visionCoreArtifacts: visionCore("/var/lib/vem-testbed"),
      aiVirtualTryOnFunctional: {
        materializedModelPackRoot: "/var/lib/vem-testbed/model-pack",
        modelPackArchive: "/var/lib/vem-testbed/model-pack.zip",
        modelPackByteSize: 1024,
        modelPackSha256: "a".repeat(64),
      },
    });
    assert.equal(
      config.aiVirtualTryOnFunctional.modelPackArchive,
      "/var/lib/vem-testbed/model-pack.zip",
    );
  });

  it("requires independent host-local Vision core artifacts before any AI input", () => {
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

  it("snapshots the exact two Vision core archives for a blocked AI pass without a guest cache fallback", async () => {
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
      assert.match(snapshot.guestInput.identity.sha256, /^[a-f0-9]{64}$/);
      assert.equal(
        snapshot.guestInput.runtimeArchive,
        `D:\\runtime-cache\\v1\\acceptance-inputs\\files\\${digest(runtime)}\\vision-runtime.zip`,
      );
      assert.equal(
        snapshot.guestInput.inputRoot,
        `D:\\runtime-cache\\v1\\acceptance-inputs\\vision-core\\${snapshot.guestInput.identity.sha256}`,
      );
      assert.equal(snapshot.transfers.length, 2);
      assert.ok(
        snapshot.transfers.every((entry) =>
          entry.hostPath.includes("snapshots"),
        ),
      );
      assert.ok(
        snapshot.transfers.every(
          (entry) => !entry.hostPath.includes("vision-main"),
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
            ...snapshot.guestInput,
            identity: {
              ...snapshot.guestInput.identity,
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
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.ok(
      source.indexOf("createArchiveParent") <
        source.indexOf('await runProcess("scp"'),
    );
  });

  it("bounds guest SSH work and avoids the Windows SFTP hang path", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
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
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /const GUEST_SETUP_TIMEOUT_MS = 120_000/);
    assert.match(source, /const GUEST_TRANSFER_TIMEOUT_MS = 300_000/);
    assert.match(
      source,
      /const GUEST_FAST_EXECUTION_TIMEOUT_MS = 15 \* 60_000/,
    );
    assert.match(source, /error\.timedOut = true/);
    assert.match(source, /timeoutLabel: executionBudget\.timeoutLabel/);
    assert.match(source, /child\.kill\("SIGTERM"\)/);
    assert.match(
      source,
      /error\.exitCode === 255 \|\| error\.timedOut === true/,
    );
  });

  it("extends the guest SSH execution budget for canonical multi-focus fast acceptance", () => {
    const budget = guestAcceptanceExecutionBudget({
      mode: "fast",
      focus: sevenFocusedBusinessSets,
    });

    assert.ok(budget.timeoutMs >= 20 * 60_000);
    assert.equal(
      budget.selectedSets.join(","),
      sevenFocusedBusinessSets.join(","),
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
    }));
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
    }));
    assert.equal(
      guestAcceptanceExecutionBudget({
        mode: "fast",
        focus: expandedRegistry.map((descriptor) => descriptor.name),
        registry: expandedRegistry,
      }).timeoutMs,
      45 * 60_000,
    );
  });

  it("budgets a 4.5 GB guest input transfer for the observed slow link", async () => {
    const calls = [];
    const byteSize = 4_506_259_239;
    await stageAiAcceptanceInputs({
      config: { stateRoot: "/var/lib/vem-testbed/state" },
      contract: {
        testbed: {
          guest: {
            user: "VEMKiosk",
            host: "win10-testbed.local",
            identityFile: "/tmp/id",
            knownHostsFile: "/tmp/known_hosts",
            stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
          },
        },
      },
      preparation: {
        transfers: [
          {
            hostPath: "/host/model-pack.zip",
            guestPath:
              "D:\\runtime-cache\\v1\\acceptance-inputs\\files\\digest\\model-pack.zip",
            sha256: "a".repeat(64),
            byteSize,
          },
        ],
      },
      captureResult: async () => ({ stdout: '{"cacheHits":[]}' }),
      run: async (command, args, options) =>
        calls.push({ command, args, options }),
    });

    const transfer = calls.find(
      (call) =>
        call.command === "scp" && call.args.at(-1).endsWith("model-pack.zip"),
    );
    assert.equal(transfer.options.timeoutMs, 657_188);
    assert.match(transfer.options.timeoutLabel, /4506259239/);
    assert.match(
      transfer.options.timeoutLabel,
      new RegExp(String(transfer.options.timeoutMs)),
    );
  });

  it("keeps independent guest input budgets bounded by the small-transfer floor and hard cap", async () => {
    const calls = [];
    const smallPath = "D:\\runtime-cache\\small.bin";
    const directoryPath = "D:\\runtime-cache\\model-pack";
    const hugePath = "D:\\runtime-cache\\huge.bin";
    await stageAiAcceptanceInputs({
      config: { stateRoot: "/var/lib/vem-testbed/state" },
      contract: {
        testbed: {
          guest: {
            user: "VEMKiosk",
            host: "win10-testbed.local",
            identityFile: "/tmp/id",
            knownHostsFile: "/tmp/known_hosts",
            stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
          },
        },
      },
      preparation: {
        transfers: [
          {
            hostPath: "/host/small.bin",
            guestPath: smallPath,
            sha256: "a".repeat(64),
            byteSize: 1,
          },
          {
            hostPath: "/host/model-pack",
            guestPath: directoryPath,
            sha256: "b".repeat(64),
            byteSize: 100_000_000_000,
            members: [
              {
                name: "weights/first.bin",
                sha256: "c".repeat(64),
                byteSize: 2_500_000_000,
              },
              {
                name: "weights/second.bin",
                sha256: "d".repeat(64),
                byteSize: 2_006_259_239,
              },
            ],
          },
          {
            hostPath: "/host/huge.bin",
            guestPath: hugePath,
            sha256: "e".repeat(64),
            byteSize: 100_000_000_000,
          },
        ],
      },
      captureResult: async () => ({ stdout: '{"cacheHits":[]}' }),
      run: async (command, args, options) =>
        calls.push({ command, args, options }),
    });

    const transferOptions = (guestPath) =>
      calls.find(
        (call) =>
          call.command === "scp" && call.args.at(-1).endsWith(guestPath),
      ).options;
    assert.equal(transferOptions(smallPath).timeoutMs, 300_000);
    assert.equal(transferOptions(directoryPath).timeoutMs, 657_188);
    assert.equal(transferOptions(hugePath).timeoutMs, 30 * 60_000);
    assert.match(transferOptions(smallPath).timeoutLabel, /bytes=1/);
    assert.match(
      transferOptions(directoryPath).timeoutLabel,
      /bytes=4506259239/,
    );
    assert.match(transferOptions(hugePath).timeoutLabel, /budgetMs=1800000/);
  });

  it("rejects an invalid file byte size before probing or mutating the guest", async () => {
    for (const byteSize of [Number.NaN, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
      const calls = [];
      await assert.rejects(
        stageAiAcceptanceInputs({
          config: { stateRoot: "/var/lib/vem-testbed/state" },
          contract: {
            testbed: {
              guest: {
                user: "VEMKiosk",
                host: "win10-testbed.local",
                identityFile: "/tmp/id",
                knownHostsFile: "/tmp/known_hosts",
                stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
              },
            },
          },
          preparation: {
            transfers: [
              {
                hostPath: "/host/invalid.bin",
                guestPath: "D:\\runtime-cache\\invalid.bin",
                sha256: "f".repeat(64),
                byteSize,
              },
            ],
          },
          captureResult: async (...args) => calls.push(["capture", ...args]),
          run: async (...args) => calls.push(["run", ...args]),
        }),
        (error) => {
          assert.match(error.message, /kind=file/);
          assert.ok(error.message.includes(`byteSize=${String(byteSize)}`));
          assert.match(error.message, /positive safe integer/);
          return true;
        },
      );
      assert.deepEqual(calls, []);
    }
  });

  it("rejects an invalid directory member byte size before probing or mutating the guest", async () => {
    for (const byteSize of [Number.NaN, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
      const calls = [];
      await assert.rejects(
        stageAiAcceptanceInputs({
          config: { stateRoot: "/var/lib/vem-testbed/state" },
          contract: {
            testbed: {
              guest: {
                user: "VEMKiosk",
                host: "win10-testbed.local",
                identityFile: "/tmp/id",
                knownHostsFile: "/tmp/known_hosts",
                stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
              },
            },
          },
          preparation: {
            transfers: [
              {
                hostPath: "/host/invalid-directory",
                guestPath: "D:\\runtime-cache\\invalid-directory",
                sha256: "f".repeat(64),
                byteSize: 1,
                members: [
                  {
                    name: "weights/model.bin",
                    sha256: "e".repeat(64),
                    byteSize,
                  },
                ],
              },
            ],
          },
          captureResult: async (...args) => calls.push(["capture", ...args]),
          run: async (...args) => calls.push(["run", ...args]),
        }),
        (error) => {
          assert.match(error.message, /kind=directory_member/);
          assert.match(error.message, /member=weights\/model\.bin/);
          assert.ok(error.message.includes(`byteSize=${String(byteSize)}`));
          assert.match(error.message, /positive safe integer/);
          return true;
        },
      );
      assert.deepEqual(calls, []);
    }
  });

  it("rejects a directory byte-size sum overflow before probing or mutating the guest", async () => {
    const calls = [];
    await assert.rejects(
      stageAiAcceptanceInputs({
        config: { stateRoot: "/var/lib/vem-testbed/state" },
        contract: {
          testbed: {
            guest: {
              user: "VEMKiosk",
              host: "win10-testbed.local",
              identityFile: "/tmp/id",
              knownHostsFile: "/tmp/known_hosts",
              stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
            },
          },
        },
        preparation: {
          transfers: [
            {
              hostPath: "/host/overflow-directory",
              guestPath: "D:\\runtime-cache\\overflow-directory",
              sha256: "f".repeat(64),
              byteSize: Number.MAX_SAFE_INTEGER,
              members: [
                {
                  name: "weights/first.bin",
                  sha256: "e".repeat(64),
                  byteSize: Number.MAX_SAFE_INTEGER,
                },
                {
                  name: "weights/second.bin",
                  sha256: "d".repeat(64),
                  byteSize: 1,
                },
              ],
            },
          ],
        },
        captureResult: async (...args) => calls.push(["capture", ...args]),
        run: async (...args) => calls.push(["run", ...args]),
      }),
      /guest input transfer byte size invalid.*kind=directory_total.*exceeds Number\.MAX_SAFE_INTEGER/,
    );
    assert.deepEqual(calls, []);
  });

  it("rejects a zero-byte directory before probing or mutating the guest", async () => {
    const calls = [];
    await assert.rejects(
      stageAiAcceptanceInputs({
        config: { stateRoot: "/var/lib/vem-testbed/state" },
        contract: {
          testbed: {
            guest: {
              user: "VEMKiosk",
              host: "win10-testbed.local",
              identityFile: "/tmp/id",
              knownHostsFile: "/tmp/known_hosts",
              stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
            },
          },
        },
        preparation: {
          transfers: [
            {
              hostPath: "/host/empty-directory",
              guestPath: "D:\\runtime-cache\\empty-directory",
              sha256: "f".repeat(64),
              byteSize: 0,
              members: [],
            },
          ],
        },
        captureResult: async (...args) => calls.push(["capture", ...args]),
        run: async (...args) => calls.push(["run", ...args]),
      }),
      /guest input transfer byte size invalid.*kind=directory_total.*byteSize=0.*positive safe integer/,
    );
    assert.deepEqual(calls, []);
  });

  it("compresses the commit archive before the guest transfer", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /source-pass-\$\{pass\}\.tar\.gz/);
    assert.match(source, /"--format=tar\.gz"/);
  });

  it("refreshes the current commit host runtime before every fast guest pass", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
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
      /"--run-id",\s*fixtureIsCurrent \? options\.runId : `\$\{options\.runId\}-PASS-\$\{pass\}`/,
    );
    assert.match(
      source,
      /guestInput:[\s\S]*sha256: preparation\.guestInput\.sha256/,
    );
  });

  it("reconstructs a fast host when the cached platform fixture is stale", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /fixtureIdentityForWorkspace\(workspace\)/);
    assert.match(source, /existingGuestInput\?\.fixtureIdentity\?\.sha256/);
    assert.match(
      source,
      /reconstructionMarker\?\.guestInput\?\.fixtureIdentity\?\.sha256/,
    );
    assert.match(source, /reconstruct-stale-fixture-pass-\$\{pass\}/);
    assert.match(
      source,
      /fixtureIsCurrent \? "refresh-host-runtime" : "reconstruct"/,
    );
  });

  it("reuses the existing cached PowerShell 7 guest entrypoint", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /ensure-testbed-pwsh\.ps1/);
    assert.match(source, /powershell\\\\7\.4\.6\\\\pwsh\.exe/);
  });

  it("collects evidence from the guest handoff root", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /C:\/ProgramData\/VEM\/testbed\/full-workflow/);
    assert.doesNotMatch(source, /C:\/ProgramData\/VEM\/runtime\/testbed/);
  });

  it("provisions digest-bound AI inputs before each selected guest execution", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /requiresAiAcceptanceInputs\(options\)/);
    assert.match(source, /aiVirtualTryOn: preparation\.guestInput/);
    assert.match(source, /await stageAiAcceptanceInputs/);
    assert.match(source, /full pass 2 AI acceptance input drifted from pass 1/);
    assert.match(
      source,
      /AI acceptance inputs changed during host preparation/,
    );
  });

  it("stages every fixed AI destination and always sends the current blocked guest input", async () => {
    const calls = [];
    const config = { stateRoot: "/var/lib/vem-testbed/state" };
    const contract = {
      testbed: {
        guest: {
          user: "VEMKiosk",
          host: "win10-testbed.local",
          identityFile: "/tmp/id",
          knownHostsFile: "/tmp/known_hosts",
          stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        },
      },
    };
    const preparation = {
      guestInput: {
        inputRoot: "C:\\ProgramData\\VEM\\testbed\\ai-inputs\\a".repeat(64),
      },
      transfers: Array.from({ length: 7 }, (_, index) => ({
        hostPath: `/snapshot/${index}`,
        guestPath: `C:\\ProgramData\\VEM\\testbed\\ai-inputs\\digest\\entry-${index}`,
        byteSize: 1,
        sha256: "a".repeat(64),
        ...(index < 2 || index === 6
          ? {
              members: [
                { name: "member", byteSize: 1, sha256: "b".repeat(64) },
              ],
            }
          : {}),
      })),
    };
    await stageAiAcceptanceInputs({
      config,
      contract,
      preparation,
      captureResult: async () => ({ stdout: '{"cacheHits":[]}' }),
      run: async (command, args) => calls.push({ command, args }),
    });
    await stageAiAcceptanceInputs({
      config,
      contract,
      preparation: null,
      captureResult: async () => ({ stdout: '{"cacheHits":[]}' }),
      run: async (command, args) => calls.push({ command, args }),
    });
    const destinations = calls
      .filter((call) => call.command === "scp")
      .map((call) => call.args.at(-1));
    assert.ok(
      destinations.includes(
        "VEMKiosk@win10-testbed.local:C:\\ProgramData\\VEM\\testbed\\ai-inputs\\digest\\entry-0",
      ),
    );
    assert.ok(
      destinations.includes(
        "VEMKiosk@win10-testbed.local:C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      ),
    );
    assert.equal(
      destinations.filter((value) => value.endsWith("guest-input.json")).length,
      2,
    );
    assert.equal(
      destinations.some((value) => value.endsWith("undefined")),
      false,
    );
  });

  it("keeps full-run guest input cleanup below the Windows command-line limit", async () => {
    const calls = [];
    const aiRoot = `C:\\ProgramData\\VEM\\testbed\\ai-inputs\\${"a".repeat(64)}`;
    const coreRoot = `C:\\ProgramData\\VEM\\testbed\\vision-core\\${"b".repeat(64)}`;
    const file = (hostPath, guestPath, byteSize) => ({
      hostPath,
      guestPath,
      byteSize,
      sha256: "c".repeat(64),
    });
    const directory = (hostPath, guestPath) => ({
      hostPath,
      guestPath,
      byteSize: 1,
      sha256: "d".repeat(64),
      members: [{ name: "member", byteSize: 1, sha256: "e".repeat(64) }],
    });
    const coreTransfers = [
      file(
        "/snapshot/core-runtime.zip",
        `${coreRoot}\\vision-runtime.zip`,
        1_484_082_923,
      ),
      file(
        "/snapshot/core-fixtures.zip",
        `${coreRoot}\\recorded-fixtures.zip`,
        1_788_616,
      ),
    ];
    const aiTransfers = [
      file(
        "/snapshot/vision-runtime.zip",
        `${aiRoot}\\vision-runtime.zip`,
        1_484_082_923,
      ),
      file(
        "/snapshot/recorded-fixtures.zip",
        `${aiRoot}\\recorded-fixtures.zip`,
        1_788_616,
      ),
      file(
        "/snapshot/model-pack.zip",
        `${aiRoot}\\model-pack.zip`,
        4_506_259_239,
      ),
      directory("/snapshot/model-pack", `${aiRoot}\\model-pack`),
    ];

    await stageAiAcceptanceInputs({
      config: { stateRoot: "/var/lib/vem-testbed/state" },
      contract: {
        testbed: {
          guest: {
            user: "VEMKiosk",
            host: "win10-testbed.local",
            identityFile: "/tmp/id",
            knownHostsFile: "/tmp/known_hosts",
            stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
          },
        },
      },
      corePreparation: { transfers: coreTransfers },
      preparation: { transfers: aiTransfers },
      captureResult: async () => ({ stdout: '{"cacheHits":[]}' }),
      run: async (command, args) => calls.push({ command, args }),
    });

    const cleanupCalls = calls.filter((call) => call.command === "ssh");
    assert.ok(cleanupCalls.length > 0);
    for (const call of cleanupCalls) {
      const remoteCommand = call.args.slice(-4).join(" ");
      assert.ok(
        remoteCommand.length <= 8_191,
        `remote Windows command is ${remoteCommand.length} characters`,
      );
    }
    const cleanup = cleanupCalls
      .map((call) =>
        Buffer.from(call.args.at(-1), "base64").toString("utf16le"),
      )
      .join("\n");
    for (const transfer of [...coreTransfers, ...aiTransfers]) {
      assert.match(
        cleanup,
        new RegExp(transfer.guestPath.replaceAll("\\", "\\\\")),
      );
    }
  });

  it("retains matching regular guest archives while refreshing the guest projection", async () => {
    const calls = [];
    const probes = [];
    const runtimePath =
      "C:\\ProgramData\\VEM\\testbed\\vision-core\\digest\\vision-runtime.zip";
    const modelPath =
      "C:\\ProgramData\\VEM\\testbed\\ai-inputs\\digest\\official-model-pack.zip";
    await stageAiAcceptanceInputs({
      config: { stateRoot: "/var/lib/vem-testbed/state" },
      contract: {
        testbed: {
          guest: {
            user: "VEMKiosk",
            host: "win10-testbed.local",
            identityFile: "/tmp/id",
            knownHostsFile: "/tmp/known_hosts",
            stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
          },
        },
      },
      corePreparation: {
        guestInput: {
          inputRoot: "C:\\ProgramData\\VEM\\testbed\\vision-core\\digest",
        },
        transfers: [
          {
            hostPath: "/host/vision-runtime.zip",
            guestPath: runtimePath,
            sha256: "a".repeat(64),
            byteSize: 1_484_082_923,
          },
        ],
      },
      preparation: {
        guestInput: {
          inputRoot: "C:\\ProgramData\\VEM\\testbed\\ai-inputs\\digest",
        },
        transfers: [
          {
            hostPath: "/host/official-model-pack.zip",
            guestPath: modelPath,
            sha256: "b".repeat(64),
            byteSize: 4_506_000_000,
          },
        ],
      },
      captureResult: async (command, args) => {
        assert.equal(command, "ssh");
        const probe = Buffer.from(args.at(-1), "base64").toString("utf16le");
        probes.push(probe);
        assert.match(probe, /System\.IO\.FileInfo/);
        assert.match(probe, /FileAttributes\]::ReparsePoint/);
        assert.match(probe, /Get-FileHash/);
        return {
          stdout: JSON.stringify({
            cacheHits: [probe.includes("1484082923") ? runtimePath : modelPath],
          }),
        };
      },
      run: async (command, args) => calls.push({ command, args }),
    });
    const destinations = calls
      .filter((call) => call.command === "scp")
      .map((call) => call.args.at(-1));
    assert.deepEqual(destinations, [
      "VEMKiosk@win10-testbed.local:C:\\ProgramData\\VEM\\testbed\\guest-input.json",
    ]);
    assert.match(probes.join("\n"), /1484082923/);
    assert.match(probes.join("\n"), /4506000000/);
  });

  it("retains exact guest directories and deduplicates shared digest destinations", async () => {
    const calls = [];
    const probes = [];
    const cacheRoot =
      "D:\\runtime-cache\\v1\\acceptance-inputs\\directories\\digest";
    const archivePath =
      "D:\\runtime-cache\\v1\\acceptance-inputs\\files\\digest\\vision-runtime.zip";
    const archive = {
      hostPath: "/host/vision-runtime.zip",
      guestPath: archivePath,
      sha256: "a".repeat(64),
      byteSize: 1_484_082_923,
    };
    await stageAiAcceptanceInputs({
      config: { stateRoot: "/var/lib/vem-testbed/state" },
      contract: {
        testbed: {
          guest: {
            user: "VEMKiosk",
            host: "win10-testbed.local",
            identityFile: "/tmp/id",
            knownHostsFile: "/tmp/known_hosts",
            stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
          },
        },
      },
      corePreparation: { transfers: [archive] },
      preparation: {
        transfers: [
          { ...archive, hostPath: "/other-snapshot/vision-runtime.zip" },
          {
            hostPath: "/host/model-pack",
            guestPath: cacheRoot,
            sha256: "b".repeat(64),
            byteSize: 7,
            members: [
              {
                name: "weights/model.bin",
                sha256: "c".repeat(64),
                byteSize: 7,
              },
            ],
          },
        ],
      },
      captureResult: async (_command, args) => {
        const probe = Buffer.from(args.at(-1), "base64").toString("utf16le");
        probes.push(probe);
        return {
          stdout: JSON.stringify({
            cacheHits: [
              probe.includes("Get-ChildItem") ? cacheRoot : archivePath,
            ],
          }),
        };
      },
      run: async (command, args) => calls.push({ command, args }),
    });

    assert.ok(probes.some((probe) => probe.includes("Get-ChildItem")));
    assert.deepEqual(
      calls
        .filter((call) => call.command === "scp")
        .map((call) => call.args.at(-1)),
      [
        "VEMKiosk@win10-testbed.local:C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      ],
    );
  });

  it("rejects changed, incomplete, extra-file, and reparse-point guest directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-guest-directory-cache-"));
    const modelRoot = join(root, "model-pack");
    const modelDirectory = join(modelRoot, "weights");
    const modelPath = join(modelDirectory, "model.bin");
    const extraPath = join(modelRoot, "extra.bin");
    const emptyDirectory = join(modelRoot, "empty");
    const linkPath = join(modelRoot, "model-link.bin");
    const content = "model-v1";
    const transfer = {
      hostPath: "/host/model-pack",
      guestPath: modelRoot,
      sha256: digest(`${digest(content)}\0${content.length}`),
      byteSize: content.length,
      members: [
        {
          name: "weights/model.bin",
          sha256: digest(content),
          byteSize: content.length,
        },
      ],
    };
    const stage = async () => {
      const calls = [];
      await stageAiAcceptanceInputs({
        config: { stateRoot: root },
        contract: {
          testbed: {
            guest: {
              user: "VEMKiosk",
              host: "win10-testbed.local",
              identityFile: "/tmp/id",
              knownHostsFile: "/tmp/known_hosts",
              stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
            },
          },
        },
        preparation: { transfers: [transfer] },
        captureResult: async (_command, args) => {
          const result = spawnSync(
            "pwsh",
            ["-NoProfile", "-EncodedCommand", args.at(-1)],
            { encoding: "utf8" },
          );
          assert.equal(result.status, 0, result.stderr);
          return { stdout: result.stdout };
        },
        run: async (command, args) => calls.push({ command, args }),
      });
      return calls.some(
        (call) =>
          call.command === "scp" && call.args.at(-1).endsWith(modelRoot),
      );
    };
    try {
      mkdirSync(modelDirectory, { recursive: true });
      writeFileSync(modelPath, content);
      assert.equal(await stage(), false);

      writeFileSync(modelPath, "changed!");
      assert.equal(await stage(), true);
      writeFileSync(modelPath, content);

      rmSync(modelPath);
      assert.equal(await stage(), true);
      writeFileSync(modelPath, content);

      writeFileSync(extraPath, "extra");
      assert.equal(await stage(), true);
      rmSync(extraPath);

      mkdirSync(join(emptyDirectory, "nested"), { recursive: true });
      assert.equal(await stage(), false);
      rmSync(emptyDirectory, { recursive: true });

      symlinkSync("weights/model.bin", linkPath);
      assert.equal(await stage(), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a cold-staged host directory with non-authoritative empty directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-empty-directory-cache-"));
    const sourceRoot = join(root, "host-source");
    const cacheRoot = join(root, "guest-cache");
    const content = "model-v1";
    const transfer = {
      hostPath: sourceRoot,
      guestPath: cacheRoot,
      sha256: digest(`${digest(content)}\0${content.length}`),
      byteSize: content.length,
      members: [
        {
          name: "weights/model.bin",
          sha256: digest(content),
          byteSize: content.length,
        },
      ],
    };
    const stage = async ({ populateCache = false } = {}) => {
      const calls = [];
      await stageAiAcceptanceInputs({
        config: { stateRoot: root },
        contract: {
          testbed: {
            guest: {
              user: "VEMKiosk",
              host: "win10-testbed.local",
              identityFile: "/tmp/id",
              knownHostsFile: "/tmp/known_hosts",
              stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
            },
          },
        },
        preparation: { transfers: [transfer] },
        captureResult: async (_command, args) => {
          const result = spawnSync(
            "pwsh",
            ["-NoProfile", "-EncodedCommand", args.at(-1)],
            { encoding: "utf8" },
          );
          assert.equal(result.status, 0, result.stderr);
          return { stdout: result.stdout };
        },
        run: async (command, args) => {
          calls.push({ command, args });
          if (
            populateCache &&
            command === "scp" &&
            args.at(-1).endsWith(cacheRoot)
          ) {
            cpSync(sourceRoot, cacheRoot, { recursive: true });
          }
        },
      });
      return calls
        .filter((call) => call.command === "scp")
        .map((call) => call.args.at(-1));
    };
    try {
      mkdirSync(join(sourceRoot, "weights"), { recursive: true });
      mkdirSync(join(sourceRoot, "empty", "nested"), { recursive: true });
      writeFileSync(join(sourceRoot, "weights", "model.bin"), content);

      assert.ok(
        (await stage({ populateCache: true })).some((destination) =>
          destination.endsWith(cacheRoot),
        ),
      );
      assert.deepEqual(await stage(), [
        "VEMKiosk@win10-testbed.local:C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate guest destinations with different identities", async () => {
    const destination =
      "D:\\runtime-cache\\v1\\acceptance-inputs\\files\\digest\\runtime.zip";
    await assert.rejects(
      stageAiAcceptanceInputs({
        config: { stateRoot: "/var/lib/vem-testbed/state" },
        contract: {
          testbed: {
            guest: {
              user: "VEMKiosk",
              host: "win10-testbed.local",
              identityFile: "/tmp/id",
              knownHostsFile: "/tmp/known_hosts",
              stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
            },
          },
        },
        corePreparation: {
          transfers: [
            {
              hostPath: "/host/runtime.zip",
              guestPath: destination,
              sha256: "a".repeat(64),
              byteSize: 1,
            },
          ],
        },
        preparation: {
          transfers: [
            {
              hostPath: "/other/runtime.zip",
              guestPath: destination,
              sha256: "b".repeat(64),
              byteSize: 1,
            },
          ],
        },
      }),
      /destination identity conflicts/,
    );
  });

  it("replaces a digest-mismatched regular guest archive without clearing a matching sibling", async () => {
    const calls = [];
    const runtimePath =
      "C:\\ProgramData\\VEM\\testbed\\vision-core\\digest\\vision-runtime.zip";
    const modelPath =
      "C:\\ProgramData\\VEM\\testbed\\ai-inputs\\digest\\official-model-pack.zip";
    await stageAiAcceptanceInputs({
      config: { stateRoot: "/var/lib/vem-testbed/state" },
      contract: {
        testbed: {
          guest: {
            user: "VEMKiosk",
            host: "win10-testbed.local",
            identityFile: "/tmp/id",
            knownHostsFile: "/tmp/known_hosts",
            stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
          },
        },
      },
      corePreparation: {
        guestInput: {
          inputRoot: "C:\\ProgramData\\VEM\\testbed\\vision-core\\digest",
        },
        transfers: [
          {
            hostPath: "/host/vision-runtime.zip",
            guestPath: runtimePath,
            sha256: "a".repeat(64),
            byteSize: 1_484_082_923,
          },
        ],
      },
      preparation: {
        guestInput: {
          inputRoot: "C:\\ProgramData\\VEM\\testbed\\ai-inputs\\digest",
        },
        transfers: [
          {
            hostPath: "/host/official-model-pack.zip",
            guestPath: modelPath,
            sha256: "b".repeat(64),
            byteSize: 4_506_000_000,
          },
        ],
      },
      captureResult: async (_command, args) => {
        const probe = Buffer.from(args.at(-1), "base64").toString("utf16le");
        return {
          stdout: JSON.stringify({
            cacheHits: probe.includes("1484082923") ? [runtimePath] : [],
          }),
        };
      },
      run: async (command, args) => calls.push({ command, args }),
    });
    const destinations = calls
      .filter((call) => call.command === "scp")
      .map((call) => call.args.at(-1));
    assert.deepEqual(destinations, [
      `VEMKiosk@win10-testbed.local:${modelPath}`,
      "VEMKiosk@win10-testbed.local:C:\\ProgramData\\VEM\\testbed\\guest-input.json",
    ]);
    const cleanup = Buffer.from(
      calls.find((call) => call.command === "ssh").args.at(-1),
      "base64",
    ).toString("utf16le");
    assert.equal(
      cleanup.includes(`Remove-Item -LiteralPath '${modelPath}`),
      true,
    );
    assert.equal(
      cleanup.includes(`Remove-Item -LiteralPath '${runtimePath}`),
      false,
    );
  });

  it("writes a blocked marker before synchronizing the guest projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-ai-blocked-projection-"));
    try {
      writeFileSync(
        join(root, "guest-input.json"),
        '{"schemaVersion":"vem-local-testbed-guest-input/v1","workflowIdentity":{}}\n',
      );
      await provisionAiAcceptanceBlock({
        config: { stateRoot: root },
        pass: 1,
        reason: "AI acceptance input blocked: manifest is missing",
      });
      const guestInput = JSON.parse(
        readFileSync(join(root, "guest-input.json"), "utf8"),
      );
      assert.equal(
        guestInput.acceptanceBlocks.aiVirtualTryOn,
        "AI acceptance input blocked: manifest is missing",
      );
      assert.equal(guestInput.workflowIdentity.pass, 1);
      let staged;
      await stageAiAcceptanceInputs({
        config: { stateRoot: root },
        contract: {
          testbed: {
            guest: {
              user: "VEMKiosk",
              host: "win10-testbed.local",
              identityFile: "/tmp/id",
              knownHostsFile: "/tmp/known_hosts",
              stagingPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
            },
          },
        },
        preparation: null,
        run: async (command, args) => {
          if (command === "scp")
            staged = JSON.parse(readFileSync(args.at(-2), "utf8"));
        },
      });
      assert.equal(
        staged.acceptanceBlocks.aiVirtualTryOn,
        "AI acceptance input blocked: manifest is missing",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unblocks a warm AI rerun when valid host inputs replace an earlier AI block", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-ai-warm-unblock-"));
    try {
      writeFileSync(
        join(root, "guest-input.json"),
        JSON.stringify({
          schemaVersion: "vem-local-testbed-guest-input/v1",
          workflowIdentity: {},
          acceptanceBlocks: {
            aiVirtualTryOn: "earlier host input failure",
            payment: "provider unavailable",
          },
        }),
      );
      await provisionAiAcceptanceBlock({
        config: { stateRoot: root },
        pass: 1,
        reason: "AI acceptance input blocked: manifest is missing",
      });
      await provisionAiAcceptanceGuestInput({
        config: { stateRoot: root },
        pass: 1,
        preparation: {
          guestInput: {
            inputRoot: "C:\\testbed\\ai",
            identities: { manifestSha256: "b".repeat(64) },
          },
        },
      });
      const guestInput = JSON.parse(
        readFileSync(join(root, "guest-input.json"), "utf8"),
      );
      assert.deepEqual(guestInput.acceptanceBlocks, {
        payment: "provider unavailable",
      });
      assert.equal(guestInput.aiVirtualTryOn.inputRoot, "C:\\testbed\\ai");
      assert.deepEqual(guestInput.workflowIdentity.aiVirtualTryOn, {
        input: { manifestSha256: "b".repeat(64) },
      });
      writeFileSync(
        join(root, "guest-input.json"),
        JSON.stringify({
          schemaVersion: "vem-local-testbed-guest-input/v1",
          workflowIdentity: {},
          acceptanceBlocks: { aiVirtualTryOn: "earlier host input failure" },
        }),
      );
      await provisionAiAcceptanceGuestInput({
        config: { stateRoot: root },
        pass: 1,
        preparation: {
          guestInput: { inputRoot: "C:\\testbed\\ai", identities: {} },
        },
      });
      assert.equal(
        Object.hasOwn(
          JSON.parse(readFileSync(join(root, "guest-input.json"), "utf8")),
          "acceptanceBlocks",
        ),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps terminal status writes from overwriting an old superseded terminal", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes('if (current.status === "superseded")'));
  });

  it("writes compact terminal status before canonical status", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    const compactWrite = source.indexOf(
      'await writeJson(join(compact, "status.json"), status);',
    );
    const canonicalWrite = source.indexOf(
      "await writeJson(statusPath(config, options.runId), status);",
    );
    assert.ok(
      compactWrite >= 0 && canonicalWrite >= 0 && compactWrite < canonicalWrite,
    );
  });

  it("treats bounded ssh/scp failures as infrastructure failures", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /\(error\.command === "ssh" \|\| error\.command === "scp"\)\s*&&\s*\(\s*error\.exitCode === 255 \|\| error\.timedOut === true\s*\)/,
    );
    assert.ok(
      source.includes("error.command = command;") &&
        source.includes("error.exitCode = code;") &&
        source.includes("error.timedOut = true;"),
    );
  });

  it("waits until old process groups are truly terminated before continuing", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.ok(
      source.includes("if (processGroupExists(processGroupId)) {") &&
        source.includes("failed to terminate process group"),
    );
  });

  it("detaches workers from the caller streams and retains host logs", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /worker\.stdout\.log/);
    assert.match(source, /worker\.stderr\.log/);
    assert.match(source, /detached: true, stdio: \["ignore", stdout, stderr\]/);
    assert.doesNotMatch(source, /detached: true, stdio: "inherit"/);
  });
});
