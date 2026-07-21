import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createRunId,
  parseOrchestratorOptions,
  powerShellFocusArgument,
  validateHostConfig,
} from "./runtime-testbed-orchestrator.mjs";
import { parseTriggerOptions } from "./runtime-testbed-trigger.mjs";

const sha = "a".repeat(40);

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
  });

  it("passes multiple focused sets as one PowerShell array parameter", () => {
    assert.equal(powerShellFocusArgument([]), "");
    assert.equal(
      powerShellFocusArgument(["sale", "scannerPayment", "name'quoted"]),
      " -Focus @('sale', 'scannerPayment', 'name''quoted')",
    );
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
      },
    );
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

  it("compresses the commit archive before the guest transfer", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /source-pass-\$\{pass\}\.tar\.gz/);
    assert.match(source, /"--format=tar\.gz"/);
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

  it("treats ssh exit 255 as infrastructure failure", () => {
    const source = readFileSync(
      new URL("./runtime-testbed-orchestrator.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /\(error\.command === "ssh" \|\| error\.command === "scp"\)\s*&&\s*error\.exitCode === 255/,
    );
    assert.ok(
      source.includes("error.command = command;") &&
        source.includes("error.exitCode = code;"),
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
