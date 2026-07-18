import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHostAdmissionPlan,
  buildHostReconstructionPlan,
  executeHostAdmissionPlan,
  renderReconstructedDomainXml,
  stopDomainBeforeReconstruction,
} from "./local-testbed-host.mjs";

const ROOT = "/var/lib/vem-testbed";
const PATHS = Object.freeze({
  baselineSystem: `${ROOT}/releases/release-0001/system.qcow2`,
  cacheDisk: `${ROOT}/cache-releases/release-0001/cache.qcow2`,
  domainXml: `${ROOT}/releases/release-0001/runtime-profile.xml`,
  overlay: `${ROOT}/runtime/vem-runtime-testbed-system.qcow2`,
  runtimeXml: `${ROOT}/runtime/vem-runtime-testbed.xml`,
  filterXml: `${ROOT}/runtime/vem-runtime-testbed-filter.xml`,
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
  <devices>
    <disk type="file" device="disk"><source file="${PATHS.baselineSystem}"/><target dev="sda" bus="sata"/></disk>
    <disk type="file" device="disk"><source file="${PATHS.cacheDisk}"/><target dev="sdb" bus="sata"/></disk>
    <interface type="network"><mac address="52:54:00:12:34:56"/><source network="runtime-testbed"/><model type="e1000e"/></interface>
  </devices>
</domain>`;
}

describe("tracked local testbed host lifecycle", () => {
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
          [PATHS.baselineSystem, PATHS.cacheDisk].includes(step.path),
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
            step.type,
          ),
        )
        .map((step) => step.args.at(-1)),
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
    const operations = [];
    const states = ["running\n", "shut off\n"];
    const result = await stopDomainBeforeReconstruction(config(), {
      domainDefined: true,
      runCommand: async (command, args) => operations.push([command, args]),
      runCaptureCommand: async () => ({ stdout: states.shift() }),
      sleep: async () => operations.push(["sleep"]),
    });
    assert.deepEqual(result, { stoppedBy: "acpi" });
    assert.deepEqual(operations, [
      [
        "virsh",
        ["--connect", "qemu:///system", "shutdown", "win10-runtime-testbed"],
      ],
      ["sleep"],
    ]);

    const fallbackOperations = [];
    const fallback = await stopDomainBeforeReconstruction(config(), {
      domainDefined: true,
      runCommand: async (command, args) =>
        fallbackOperations.push([command, args]),
      runCaptureCommand: async () => ({ stdout: "running\n" }),
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

    const missingOperations = [];
    assert.deepEqual(
      await stopDomainBeforeReconstruction(config(), {
        domainDefined: false,
        runCommand: async (...args) => missingOperations.push(args),
      }),
      { stoppedBy: "absent" },
    );
    assert.deepEqual(missingOperations, []);

    const shutOffOperations = [];
    assert.deepEqual(
      await stopDomainBeforeReconstruction(config(), {
        domainDefined: true,
        runCommand: async (...args) => shutOffOperations.push(args),
        runCaptureCommand: async () => ({ stdout: "shut off\n" }),
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
    assert.doesNotMatch(xml, new RegExp(PATHS.baselineSystem));
    assert.doesNotMatch(xml, /<name>win10-runtime-baseline<\/name>/);
    assert.doesNotMatch(xml, /<uuid>/);
    assert.match(xml, /<name>win10-runtime-testbed<\/name>/);
    assert.match(xml, new RegExp(PATHS.overlay));
    assert.match(xml, new RegExp(PATHS.cacheDisk));
    assert.doesNotMatch(xml, /filterref/);
    const admission = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "display-proof",
    });
    assert.match(
      admission[1].input,
      /C:\\ProgramData\\WindowsRuntimeBaseline\\interactive-display-report\.json/,
    );
  });

  it("does not admit the runner until the exact guest input is proven staged", async () => {
    const plan = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-15",
    });
    assert.equal(plan[0].type, "assert-guest-input");
    assert.equal(
      plan[0].args.at(-1),
      'powershell -NoProfile -NonInteractive -Command "$script = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))"',
    );
    assert.match(plan[0].input, /Get-Content[^\n]+-Encoding UTF8/);
    assert.match(plan[0].input, /\$guestDocument\.schemaVersion/);
    assert.doesNotMatch(plan[0].input, /\$input\s*=/);
    assert.equal(
      plan[1].args.at(-1),
      'powershell -NoProfile -NonInteractive -Command "$script = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))"',
    );
    assert.match(plan[1].input, /interactive-display-report\.json/);
    assert.match(plan[1].input, /-Encoding UTF8 \| ConvertFrom-Json/);
    assert.equal(plan[1].type, "assert-interactive-display");
    assert.equal(
      plan[0].path,
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
    );
    assert.equal(plan[1].type, "assert-interactive-display");
    assert.equal(plan.at(-1).type, "restart-runner-and-await-listener");
    const operations = [];
    await assert.rejects(
      executeHostAdmissionPlan(plan, {
        runCommand: async (command, args, input) => {
          operations.push(command);
          assert.equal(
            args.at(-1),
            'powershell -NoProfile -NonInteractive -Command "$script = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))"',
          );
          assert.match(input, /guest input/);
          throw new Error("guest input missing");
        },
      }),
      /guest input missing/,
    );
    assert.deepEqual(operations, ["ssh"]);
  });

  it("requires exact 1080x1920 proof before scheduling the runner", async () => {
    const plan = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-15",
    });
    const operations = [];
    const result = await executeHostAdmissionPlan(plan, {
      runCommand: async (command) => {
        operations.push(command);
      },
      runCaptureCommand: async (command, args, input) => {
        operations.push(command);
        assert.equal(
          args.at(-1),
          'powershell -NoProfile -NonInteractive -Command "$script = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))"',
        );
        if (!input.includes("interactive-display-report")) {
          return {
            stdout: `${JSON.stringify({
              serviceName: "actions.runner.example.runtime",
              listenerMarker: "Listening for Jobs",
              diagnosticLog: "Runner_20260718-000000-utc.log",
            })}\n`,
          };
        }
        assert.match(input, /interactive-display-report\.json/);
        return {
          stdout: `${JSON.stringify({
            schemaVersion: "vem-local-testbed-display-admission-proof/v1",
            status: "passed",
            widthPx: 1080,
            heightPx: 1920,
            sessionUser: "baseline",
            sessionId: 2,
            source: "interactive_autologon_report",
          })}\n`,
        };
      },
    });
    assert.equal(result.displayAdmissionProof.widthPx, 1080);
    assert.deepEqual(operations, ["ssh", "ssh", "ssh"]);
  });

  it("clears explicitly configured proxy entries, restarts the discovered service, and waits for a newly appended listener diagnostic", async () => {
    const plan = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-15",
      runnerProxy: {
        configured: true,
        http: "http://proxy.example.test:8080",
        https: "",
        noProxy: "localhost,127.0.0.1",
      },
    });
    const runner = plan.at(-1);
    assert.equal(runner.type, "restart-runner-and-await-listener");
    assert.match(runner.input, /C:\\actions-runner\\.env/);
    assert.match(runner.input, /actions\.runner\.\*/);
    assert.match(runner.input, /Restart-Service/);
    assert.match(runner.input, /Set-Date -Date \(\[DateTimeOffset\]::FromUnixTimeSeconds\(\d+\)\.LocalDateTime\)/);
    assert.match(runner.input, /Listening for Jobs|Runner reconnected/);
    assert.match(runner.input, /A session for this runner already exists/);
    assert.doesNotMatch(runner.input, /Session created/);
    assert.match(runner.input, /\$diagnosticOffsets/);
    assert.match(runner.input, /\.Length/);
    assert.match(runner.input, /\.Seek\(\$offset/);
    assert.match(runner.input, /HTTP_PROXY=http:\/\/proxy\.example\.test:8080/);
    assert.doesNotMatch(runner.input, /HTTPS_PROXY=/);
    assert.match(runner.input, /NO_PROXY=localhost,127\.0\.0\.1/);
    assert.match(runner.input, /Where-Object \{ \$_ -notmatch/);
    assert.doesNotMatch(runner.input, /GitHub API|GITHUB_TOKEN|gh api/i);

    const result = await executeHostAdmissionPlan(plan, {
      runCommand: async () => {},
      runCaptureCommand: async (_command, _args, input) => {
        if (input.includes("interactive-display-report")) {
          return {
            stdout: `${JSON.stringify({
              schemaVersion: "vem-local-testbed-display-admission-proof/v1",
              status: "passed",
              widthPx: 1080,
              heightPx: 1920,
              sessionUser: "baseline",
            })}\n`,
          };
        }
        return {
          stdout: `${JSON.stringify({
            serviceName: "actions.runner.example.runtime",
            listenerMarker: "Listening for Jobs",
            diagnosticLog: "Runner_20260718-000000-utc.log",
          })}\n`,
        };
      },
    });
    assert.equal(result.runnerAdmission.listenerMarker, "Listening for Jobs");

    await assert.rejects(
      executeHostAdmissionPlan(plan, {
        runCommand: async () => {},
        runCaptureCommand: async (_command, _args, input) => {
          if (input.includes("interactive-display-report")) {
            return {
              stdout: `${JSON.stringify({
                schemaVersion: "vem-local-testbed-display-admission-proof/v1",
                status: "passed",
                widthPx: 1080,
                heightPx: 1920,
                sessionUser: "baseline",
              })}\n`,
            };
          }
          return {
            stdout: `${JSON.stringify({
              serviceName: "actions.runner.example.runtime",
              listenerMarker: "Session created",
              diagnosticLog: "Runner_old.log",
            })}\n`,
          };
        },
      }),
      /invalid listener marker/,
    );

    const withoutProxy = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-16",
    }).at(-1);
    assert.doesNotMatch(withoutProxy.input, /WriteAllLines|\$proxyLines/);

    const clearProxy = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-17",
      runnerProxy: { configured: true, http: "", https: "", noProxy: "" },
    }).at(-1);
    assert.match(clearProxy.input, /\$proxyLines = @\(\)/);
    assert.match(clearProxy.input, /Where-Object \{ \$_ -notmatch/);
    assert.doesNotMatch(clearProxy.input, /HTTP_PROXY=|HTTPS_PROXY=|NO_PROXY=/);

    const dynamicRegistration = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-18",
      runnerRegistration: {
        adminToken: "runner-admin-token",
        repository: "example/runtime",
      },
    }).at(-1);
    assert.match(dynamicRegistration.input, /curl\.exe.*actions\/runners\/registration-token/s);
    assert.match(dynamicRegistration.input, /config\.cmd.*--runasservice/s);
    assert.match(dynamicRegistration.input, /forest-win10-runtime-current/);

    const proxiedRegistration = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-19",
      runnerProxy: {
        configured: true,
        http: "http://proxy.example.test:8080",
        https: "http://proxy.example.test:8080",
        noProxy: "localhost,127.0.0.1",
      },
      runnerRegistration: {
        adminToken: "runner-admin-token",
        repository: "example/runtime",
      },
    }).at(-1);
    assert.match(
      proxiedRegistration.input,
      /curl\.exe.*'--proxy' 'http:\/\/proxy\.example\.test:8080'/s,
    );
  });
});
