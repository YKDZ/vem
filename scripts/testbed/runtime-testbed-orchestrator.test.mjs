import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createRunId,
  identicalVisionCoreArtifactSnapshot,
  loadVisionCoreArtifacts,
  materializeVisionCoreArtifactSnapshot,
  parseOrchestratorOptions,
  powerShellFocusArgument,
  provisionAiAcceptanceBlock,
  provisionAiAcceptanceGuestInput,
  stageAiAcceptanceInputs,
  validateHostConfig,
} from "./runtime-testbed-orchestrator.mjs";
import { parseTriggerOptions } from "./runtime-testbed-trigger.mjs";

const sha = "a".repeat(40);
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

  it("runs measurement as an explicit successful collection operation", () => {
    const options = parseOrchestratorOptions([
      "run",
      "--mode",
      "measurement",
      "--commit",
      sha,
      "--config",
      "/etc/vem/testbed.json",
    ]);
    assert.equal(options.mode, "measurement");
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /mode === "measurement" \? "fast" : mode/);
    assert.match(source, /measured_not_accepted/);
    assert.match(source, /measurementPending/);
    assert.match(source, /materializeHostCalibrationSourceSnapshot/);
    assert.match(source, /sourceInputPath: hostSource\.inputPath/);
    assert.match(source, /measurement-evidence-bundle/);
    assert.match(source, /-Measurement/);
    assert.match(source, /if \(mode === "measurement"\) throw error/);
    assert.match(
      source,
      /validateMeasurementEvidenceTransport\(transportRoot\)/,
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

  it("accepts the AI input manifest only as an external host configuration", () => {
    const config = validateHostConfig({
      schemaVersion: "vem-runtime-testbed-host/v1",
      mirrorPath: "/var/lib/vem-testbed/mirror.git",
      workspaceRoot: "/var/lib/vem-testbed/workspaces",
      stateRoot: "/var/lib/vem-testbed/state",
      baselineContract: "/var/lib/vem-testbed/baseline.json",
      hostPrivateAddress: "192.0.2.22",
      guestSourcePath: "C:\\VEM\\source",
      visionCoreArtifacts: visionCore("/var/lib/vem-testbed"),
      aiVirtualTryOnInputManifest: "/var/lib/vem-testbed/ai-input.json",
      aiVirtualTryOnAllowedHttpsOrigins: ["https://cache.example.test"],
    });
    assert.equal(
      config.aiVirtualTryOnInputManifest,
      "/var/lib/vem-testbed/ai-input.json",
    );
    assert.deepEqual(config.aiVirtualTryOnAllowedHttpsOrigins, [
      "https://cache.example.test",
    ]);
    assert.throws(
      () =>
        validateHostConfig({
          ...config,
          aiVirtualTryOnAllowedHttpsOrigins: "https://cache.example.test",
        }),
      /must be an array/,
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
        `C:\\ProgramData\\VEM\\testbed\\vision-core\\${snapshot.guestInput.identity.sha256}\\vision-runtime.zip`,
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

  it("rejects the installed Vision pair when it diverges from host-verified acceptance authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-ai-authority-core-"));
    try {
      const runtime = Buffer.from("runtime");
      const fixture = Buffer.from("fixture");
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
            sourceCommit: "a".repeat(40),
          },
          recordedFixtureArchive: {
            hostPath: join(root, "recorded-fixtures.zip"),
            sha256: digest(fixture),
            byteSize: fixture.length,
            sourceCommit: "b".repeat(40),
          },
        },
      });
      await assert.rejects(
        loadVisionCoreArtifacts(config, {
          visionCore: {
            runtimeArchive: {
              sha256: "0".repeat(64),
              sourceCommit: "a".repeat(40),
            },
            recordedFixtureArchive: {
              sha256: digest(fixture),
              sourceCommit: "b".repeat(40),
            },
          },
        }),
        /do not match host-verified AI acceptance authority/,
      );
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

  it("bounds guest file transfers and avoids the Windows SFTP hang path", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /function scpArguments[\s\S]*"-O"[\s\S]*"ConnectTimeout=15"[\s\S]*"ServerAliveInterval=5"[\s\S]*"ServerAliveCountMax=3"/,
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
    assert.match(source, /timeoutLabel: "guest acceptance execution"/);
    assert.match(
      source,
      /error\.exitCode === 255 \|\| error\.timedOut === true/,
    );
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
        ...(index < 2 || index === 6 ? { members: [] } : {}),
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

  it("retains matching regular guest archives while refreshing the guest projection", async () => {
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
      captureResult: async (command, args) => {
        assert.equal(command, "ssh");
        const probe = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.match(probe, /System\.IO\.FileInfo/);
        assert.match(probe, /FileAttributes\]::ReparsePoint/);
        assert.match(probe, /Get-FileHash/);
        assert.match(probe, /1484082923/);
        assert.match(probe, /4506000000/);
        return {
          stdout: JSON.stringify({ cacheHits: [runtimePath, modelPath] }),
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
      captureResult: async () => ({
        stdout: JSON.stringify({ cacheHits: [runtimePath] }),
      }),
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
          acceptanceAuthorityReceipt: {
            value: { resources: { workerExecutableSha256: "a".repeat(64) } },
          },
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
        authority: { resources: { workerExecutableSha256: "a".repeat(64) } },
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
          acceptanceAuthorityReceipt: { value: {} },
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
