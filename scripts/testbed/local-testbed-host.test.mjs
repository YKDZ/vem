import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHostAdmissionPlan,
  buildHostReconstructionPlan,
  executeHostAdmissionPlan,
  renderReconstructedDomainXml,
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
    assert.match(xml, /<name>win10-runtime-testbed<\/name>/);
    assert.match(xml, new RegExp(PATHS.overlay));
    assert.match(xml, new RegExp(PATHS.cacheDisk));
    assert.doesNotMatch(xml, /filterref/);
  });

  it("does not admit the runner until the exact guest input is proven staged", async () => {
    const plan = buildHostAdmissionPlan({
      config: config(),
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      runId: "run-15",
    });
    assert.equal(plan[0].type, "assert-guest-input");
    assert.equal(plan[1].type, "assert-interactive-display");
    assert.equal(
      plan[0].path,
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
    );
    assert.equal(plan.at(-1).type, "assert-interactive-display");
    const operations = [];
    await assert.rejects(
      executeHostAdmissionPlan(plan, {
        runCommand: async (command) => {
          operations.push(command);
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
      runCaptureCommand: async (command) => {
        operations.push(command);
        return {
          stdout: `${JSON.stringify({
            schemaVersion: "vem-local-testbed-display-admission-proof/v1",
            status: "passed",
            widthPx: 1080,
            heightPx: 1920,
            sessionUser: "baseline",
            sessionId: 2,
            source: "enum_display_settings",
          })}\n`,
        };
      },
    });
    assert.equal(result.displayAdmissionProof.widthPx, 1080);
    assert.deepEqual(operations, ["ssh", "ssh"]);
  });
});
