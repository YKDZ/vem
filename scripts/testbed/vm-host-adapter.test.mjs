import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildLibvirtQcow2RestorePlan,
  restoreLibvirtQcow2Vm,
} from "./vm-host-adapter.mjs";

function fixtureConfig(root, overrides = {}) {
  const baseImage = join(root, "base.qcow2");
  const overlayDisk = join(root, "overlay.qcow2");
  const configPath = join(root, "adapter.json");
  writeFileSync(baseImage, "base");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        adapter: "libvirt-qcow2",
        allowedTargets: [
          {
            name: "win10-vem-solidified-acceptance",
            overlayDisk,
            baseImages: [baseImage],
            windowsSshUser: "YKDZ",
            windowsSshHosts: ["192.0.2.10"],
            ...overrides,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { baseImage, overlayDisk, configPath };
}

describe("vm-host-adapter", () => {
  it("builds a restore plan from an allowlisted libvirt qcow2 target", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-adapter-"));
    const { baseImage, overlayDisk, configPath } = fixtureConfig(root);

    const plan = buildLibvirtQcow2RestorePlan({
      config: configPath,
      runId: "run 191",
      targetVm: "win10-vem-solidified-acceptance",
      baseImage,
      overlayDisk,
      windowsSshUser: "YKDZ",
      windowsSshHost: "192.0.2.10",
    });

    assert.equal(plan.schemaVersion, "vm-host-restore-plan/v1");
    assert.equal(plan.runId, "RUN-191");
    assert.equal(plan.tempOverlayDisk, `${overlayDisk}.tmp-RUN-191`);
  });

  it("rejects non-allowlisted destructive disk paths", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-adapter-"));
    const { baseImage, configPath } = fixtureConfig(root);

    assert.throws(
      () =>
        buildLibvirtQcow2RestorePlan({
          config: configPath,
          runId: "RUN-191",
          targetVm: "win10-vem-solidified-acceptance",
          baseImage,
          overlayDisk: join(root, "other.qcow2"),
          windowsSshUser: "YKDZ",
          windowsSshHost: "192.0.2.10",
        }),
      /overlay disk is not allowlisted/,
    );
  });

  it("emits vm-host-restore-report in dry-run without live commands", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-adapter-"));
    const { baseImage, overlayDisk, configPath } = fixtureConfig(root);
    const commands = [];

    const report = restoreLibvirtQcow2Vm(
      {
        config: configPath,
        runId: "RUN-191",
        targetVm: "win10-vem-solidified-acceptance",
        baseImage,
        overlayDisk,
        windowsSshUser: "YKDZ",
        windowsSshHost: "192.0.2.10",
        out: join(root, "report.json"),
        dryRun: true,
      },
      {
        runner(command, args) {
          commands.push([command, args]);
          return `${"a".repeat(64)}  ${baseImage}\n`;
        },
      },
    );

    assert.equal(report.schemaVersion, "vm-host-restore-report/v1");
    assert.equal(report.adapter, "libvirt-qcow2");
    assert.equal(report.result, "passed");
    assert.equal(report.baseImage.sha256, "a".repeat(64));
    assert.equal(report.windowsSsh.host, "192.0.2.10");
    assert.deepEqual(commands, [["sha256sum", [baseImage]]]);
  });

  it("allows dry-run with supplied base image hash when host path is not local", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-vm-host-adapter-"));
    mkdirSync(join(root, "mnt", "base"), { recursive: true });
    const baseImage = "/mnt/user/isos/base.qcow2";
    const overlayDisk = "/mnt/user/domains/vm/vdisk1.qcow2";
    const configPath = join(root, "adapter.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        adapter: "libvirt-qcow2",
        allowedTargets: [
          {
            name: "vm",
            overlayDisk,
            baseImages: [baseImage],
            windowsSshUser: "YKDZ",
            windowsSshHosts: ["192.0.2.10"],
          },
        ],
      })}\n`,
    );

    const report = restoreLibvirtQcow2Vm({
      config: configPath,
      runId: "RUN-191",
      targetVm: "vm",
      baseImage,
      baseImageSha256: "b".repeat(64),
      overlayDisk,
      windowsSshUser: "YKDZ",
      windowsSshHost: "192.0.2.10",
      dryRun: true,
    });

    assert.equal(report.baseImage.sha256, "b".repeat(64));
    assert.equal(report.evidence.dryRun, true);
  });
});
