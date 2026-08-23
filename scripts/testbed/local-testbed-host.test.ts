import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  buildHostAdmissionPlan,
  buildHostReconstructionPlan,
  executeHostAdmissionPlan,
  prepareRuntimeAudioCapture,
  renderReconstructedDomainXml,
  runtimeAudioCapturePath,
  stopDomainBeforeReconstruction,
} from "./local-testbed-host.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

const ROOT = "/var/lib/vem-testbed";
const PATHS = Object.freeze({
  baselineSystem: `${ROOT}/releases/release-0001/system.qcow2`,
  cacheDisk: `${ROOT}/cache-releases/release-0001/cache.qcow2`,
  domainXml: `${ROOT}/releases/release-0001/runtime-profile.xml`,
  overlay: `${ROOT}/runtime/vem-runtime-testbed-system.qcow2`,
  runtimeXml: `${ROOT}/runtime/vem-runtime-testbed.xml`,
  filterXml: `${ROOT}/runtime/vem-runtime-testbed-filter.xml`,
  audio: `${ROOT}/releases/release-0001/system.qcow2.default-audio.wav`,
});

function config() {
  return {
    libvirtUri: "qemu:///system",
    domainName: "win10-runtime-testbed",
    overlayPath: PATHS.overlay,
    runtimeXmlPath: PATHS.runtimeXml,
    admissionFilterName: "vem-runtime-testbed-admission",
    admissionFilterXmlPath: PATHS.filterXml,
    hostPrivateCidr: "10.77.20.1/32",
    ssh: {
      host: "10.77.20.15",
      port: 22,
      user: "baseline",
      identityFile: `${ROOT}/ssh/id_ed25519`,
      knownHostsFile: `${ROOT}/ssh/known_hosts`,
      readinessTimeoutSeconds: 120,
    },
  };
}

function baselineXml() {
  return `<domain type="kvm">
  <name>win10-runtime-baseline</name>
  <uuid>1c94bc95-7791-4ac7-bd44-1771d9b6b029</uuid>
  <clock offset="utc"/>
  <devices>
    <disk type="file" device="disk"><source file="${PATHS.baselineSystem}"/><target dev="sda" bus="sata"/></disk>
    <disk type="file" device="disk"><source file="${PATHS.cacheDisk}"/><target dev="sdb" bus="sata"/></disk>
    <audio id="1" type="file" path="${PATHS.audio}"/>
    <interface type="network"><mac address="52:54:00:12:34:56"/><source network="runtime-testbed"/><model type="e1000e"/></interface>
  </devices>
</domain>`;
}

describe("tracked local testbed host lifecycle", () => {
  it("keeps the reconstructed Windows RTC independent of the host timezone", () => {
    const rendered = renderReconstructedDomainXml({
      templateXml: baselineXml(),
      config: config(),
      baselineSystem: PATHS.baselineSystem,
      cacheDisk: PATHS.cacheDisk,
    });
    assert.match(
      rendered,
      /<clock offset="timezone" timezone="Asia\/Shanghai"\/>/,
    );
    assert.doesNotMatch(rendered, /<clock offset="(?:utc|localtime)"\/>/);
  });

  it("replaces only the exact C overlay and domain while preserving baseline C and D cache", () => {
    const plan = buildHostReconstructionPlan({
      config: config(),
      runId: "run-15",
      ...PATHS,
    });
    assert.deepEqual(
      plan
        .filter((step) => step.type === "remove-file")
        .map((step) => step.path),
      [PATHS.overlay, `${PATHS.overlay}.pending`],
    );
    const create = plan.find((step) => step.command === "qemu-img");
    assert.ok(create);
    assert.deepEqual(create.args, [
      "create",
      "-f",
      "qcow2",
      "-F",
      "qcow2",
      "-b",
      PATHS.baselineSystem,
      `${PATHS.overlay}.pending`,
    ]);
    assert.equal(
      plan.some(
        (step) =>
          step.type === "remove-file" &&
          ([PATHS.baselineSystem, PATHS.cacheDisk] as string[]).includes(
            String(step.path),
          ),
      ),
      false,
    );
    assert.match(plan.map((step) => JSON.stringify(step)).join("\n"), /virsh/);
    const nextPlan = buildHostReconstructionPlan({
      config: config(),
      runId: "run-16",
      ...PATHS,
    });
    assert.deepEqual(
      nextPlan
        .filter((step) => step.type === "remove-file")
        .map((step) => step.path),
      [PATHS.overlay, `${PATHS.overlay}.pending`],
    );
    const mutablePaths = plan.flatMap((step) =>
      [step.path, step.from, step.to].filter(Boolean),
    );
    assert.equal(mutablePaths.includes(PATHS.baselineSystem), false);
    assert.equal(mutablePaths.includes(PATHS.cacheDisk), false);
    assert.deepEqual(
      plan
        .filter((step) =>
          ["destroy-domain", "undefine-domain", "start-domain"].includes(
            String(step.type),
          ),
        )
        .map((step) => arrayValue(step.args).at(-1)),
      [
        "win10-runtime-testbed",
        "win10-runtime-testbed",
        "win10-runtime-testbed",
      ],
    );
    assert.ok(
      plan.findIndex((step) => step.type === "acpi-shutdown-domain") <
        plan.findIndex((step) => step.type === "destroy-domain"),
    );
  });

  it("uses generic libvirt ACPI shutdown before bounded polling and only destroys a still-running domain", async () => {
    const operations: unknown[] = [];
    const states = ["running\n", "shut off\n"];
    const result = await stopDomainBeforeReconstruction(config(), {
      domainDefined: true,
      runCommand: async (command: string, args: string[]) => {
        operations.push([command, args]);
      },
      runCaptureCommand: async (): Promise<{
        stdout: string;
        stderr: string;
      }> => ({ stdout: states.shift() ?? "", stderr: "" }),
      sleep: async () => {
        operations.push(["sleep"]);
      },
    });
    assert.deepEqual(result, { stoppedBy: "acpi" });
    assert.deepEqual(operations, [
      [
        "virsh",
        ["--connect", "qemu:///system", "shutdown", "win10-runtime-testbed"],
      ],
      ["sleep"],
    ]);

    const fallbackOperations: unknown[] = [];
    const fallback = await stopDomainBeforeReconstruction(config(), {
      domainDefined: true,
      runCommand: async (command: string, args: string[]) => {
        fallbackOperations.push([command, args]);
      },
      runCaptureCommand: async (): Promise<{
        stdout: string;
        stderr: string;
      }> => ({ stdout: "running\n", stderr: "" }),
      sleep: async () => {},
      now: (() => {
        let tick = 0;
        return () => (tick += 30_000);
      })(),
    });
    assert.deepEqual(fallback, { stoppedBy: "destroy" });
    assert.deepEqual(fallbackOperations.at(-1), [
      "virsh",
      ["--connect", "qemu:///system", "destroy", "win10-runtime-testbed"],
    ]);

    const missingOperations: unknown[] = [];
    assert.deepEqual(
      await stopDomainBeforeReconstruction(config(), {
        domainDefined: false,
        runCommand: async (...args: unknown[]) => {
          missingOperations.push(args);
        },
      }),
      { stoppedBy: "absent" },
    );
    assert.deepEqual(missingOperations, []);

    const shutOffOperations: unknown[] = [];
    assert.deepEqual(
      await stopDomainBeforeReconstruction(config(), {
        domainDefined: true,
        runCommand: async (...args: unknown[]) => {
          shutOffOperations.push(args);
        },
        runCaptureCommand: async (): Promise<{
          stdout: string;
          stderr: string;
        }> => ({ stdout: "shut off\n", stderr: "" }),
      }),
      { stoppedBy: "shut-off" },
    );
    assert.deepEqual(shutOffOperations, []);
  });

  it("renders the fixed domain against overlay C, persistent D, and the admission gate", () => {
    const xml = renderReconstructedDomainXml({
      templateXml: baselineXml(),
      config: config(),
      baselineSystem: PATHS.baselineSystem,
      cacheDisk: PATHS.cacheDisk,
    });
    assert.doesNotMatch(
      xml,
      new RegExp(`source file="${PATHS.baselineSystem}"`),
    );
    assert.doesNotMatch(xml, /<name>win10-runtime-baseline<\/name>/);
    assert.doesNotMatch(xml, /<uuid>/);
    assert.match(xml, /<name>win10-runtime-testbed<\/name>/);
    assert.match(xml, /<seclabel type="none"\/>/);
    assert.match(xml, new RegExp(PATHS.overlay));
    assert.match(xml, new RegExp(PATHS.cacheDisk));
    assert.doesNotMatch(xml, /filterref/);
    assert.equal(runtimeAudioCapturePath(xml), PATHS.audio);
    const admission = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "display-proof",
      hostNow: new Date("2026-07-20T11:00:00.000Z"),
    });
    assert.match(String(admission[1].input), /CurrentHorizontalResolution/);
  });

  it("prepares the published domain audio output for the unprivileged QEMU process", async () => {
    const root = await mkdtemp("/tmp/vem-runtime-audio-");
    try {
      const path = `${root}/capture.wav`;
      const prepared = await prepareRuntimeAudioCapture(
        `<domain><devices><audio id="1" type="file" path="${path}"/></devices></domain>`,
      );
      const metadata = await stat(prepared);
      assert.equal(prepared, path);
      assert.equal(metadata.mode & 0o777, 0o666);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits only after guest input and desktop proof are available", async () => {
    const plan = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-15",
      hostNow: new Date("2026-07-20T11:00:00.000Z"),
    });
    assert.equal(plan[0].type, "assert-guest-input");
    assert.equal(plan[1].type, "assert-interactive-display");
    assert.equal(plan[2].type, "synchronize-clock");
    assert.match(String(plan[2].input), /2026-07-20T11:00:00\.000Z/);
    assert.match(String(plan[2].input), /Stop-Service -Name W32Time/);
    assert.match(
      String(plan[2].input),
      /Set-Service -Name W32Time -StartupType Disabled/,
    );
    assert.match(String(plan[2].input), /Set-Date/);
    assert.equal(plan.length, 3);
    assert.match(
      String(arrayValue(plan[0].args).at(-1)),
      /^powershell -NoProfile -NonInteractive -EncodedCommand /,
    );
    assert.match(String(plan[0].input), /Get-Content[^\n]+-Encoding UTF8/);
    assert.match(String(plan[0].input), /\$guestDocument\.schemaVersion/);
    assert.doesNotMatch(String(plan[0].input), /\$input\s*=/);
    assert.match(
      String(arrayValue(plan[1].args).at(-1)),
      /^powershell -NoProfile -NonInteractive -EncodedCommand /,
    );
    assert.doesNotMatch(
      String(plan[1].input),
      /interactive-display-report\.json/,
    );
    assert.match(String(plan[1].input), /CurrentHorizontalResolution/);
    assert.match(String(plan[1].input), /CurrentVerticalResolution/);
    assert.match(String(plan[1].input), /VEN_1AF4&DEV_1050/);
    assert.match(String(plan[1].input), /PNPDeviceID -like/);
    assert.match(String(plan[1].input), /PCI\\VEN_1AF4&DEV_1050\*/);
    assert.doesNotMatch(String(plan[1].input), /PNPDeviceID -match/);
    assert.match(String(plan[1].input), /ConfigManagerErrorCode/);
    assert.equal(plan[1].type, "assert-interactive-display");
    assert.ok(
      String(arrayValue(plan[1].args).at(-1)).length <= 8191,
      "display admission must fit the Windows command-line boundary",
    );
    assert.equal(
      String(plan[0].path),
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
    );
    assert.equal(plan[1].type, "assert-interactive-display");
    const lastPlanStep = plan.at(-1);
    assert.ok(lastPlanStep);
    assert.equal(lastPlanStep.type, "synchronize-clock");
    const operations: string[] = [];
    await assert.rejects(
      executeHostAdmissionPlan(plan, {
        runCommand: async (
          command: string,
          args: string[],
          _stdin?: string | Buffer,
          input?: unknown,
        ) => {
          operations.push(command);
          assert.match(
            String(args.at(-1)),
            /^powershell -NoProfile -NonInteractive -EncodedCommand /,
          );
          assert.match(String(input), /guest input/);
          throw new Error("guest input missing");
        },
      }),
      /guest input missing/,
    );
    assert.deepEqual(operations, ["ssh"]);
  });

  it("rebuild admission contains no Actions runner artifact or marker output", () => {
    const plan = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "persistent-worktree",
      runnerRegistrationToken: "registration-token",
      runnerRemovalToken: "removal-token",
      runnerProxy: {
        configured: true,
        http: "http://proxy.example.test:8080",
        https: "http://proxy.example.test:8080",
        noProxy: "localhost,127.0.0.1",
      },
    } as unknown as Parameters<typeof buildHostAdmissionPlan>[0]);
    assert.equal(plan.length, 3);
    assert.equal(
      plan.some((step) => step.type === "restart-runner-and-await-listener"),
      false,
    );
    assert.equal(plan[1].type, "assert-interactive-display");
    assert.doesNotMatch(String(plan[1].input), /C:\\actions-runner/);
    assert.doesNotMatch(String(plan[1].input), /actions\.runner/);
    assert.doesNotMatch(String(plan[1].input), /Listening for Jobs/);
    assert.doesNotMatch(String(plan[1].input), /Runner\.Listener/);
    assert.doesNotMatch(
      String(plan[1].input),
      /runner-admission|listenerMarker|serviceName|diagnosticLog/,
    );
  });

  it("accepts only the exact 1080x1920 desktop proof", async () => {
    const plan = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-15",
    });
    const operations: string[] = [];
    const result = await executeHostAdmissionPlan(plan, {
      runCommand: async (command: string) => {
        operations.push(command);
      },
      runCaptureCommand: async (
        command: string,
        args: string[],
        _stdin?: string | Buffer,
        input?: unknown,
      ) => {
        operations.push(command);
        assert.match(
          String(args.at(-1)),
          /^powershell -NoProfile -NonInteractive -EncodedCommand /,
        );
        if (!String(input).includes("CurrentHorizontalResolution")) {
          return { stdout: "ok\n", stderr: "" };
        }
        return {
          stdout: `${JSON.stringify({
            schemaVersion: "vem-local-testbed-display-admission-proof/v1",
            status: "passed",
            widthPx: 1080,
            heightPx: 1920,
            sessionUser: "baseline",
            sessionId: 2,
            source: "live_video_controller",
          })}\n`,
          stderr: "",
        };
      },
    });
    assert.equal(recordValue(result.displayAdmissionProof).widthPx, 1080);
    assert.equal(result.runnerAdmission, undefined);
    assert.deepEqual(operations, ["ssh", "ssh", "ssh"]);
  });
});
