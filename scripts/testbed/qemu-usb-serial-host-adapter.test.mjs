import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  parseLibvirtUsbSerialMappings,
  QEMU_USB_SERIAL_ADAPTER_VERSION,
  validateProductionRawSerialFrame,
} from "./qemu-usb-serial-host-adapter.mjs";

const adapterPath = new URL("./qemu-usb-serial-host-adapter.mjs", import.meta.url).pathname;

function makeTempDir(prefix) {
  const path = join(
    process.cwd(),
    "test-artifacts",
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

function domainXml() {
  return `<domain type="kvm"><devices>
    <serial type="pty"><source path="/dev/pts/41"/><target type="usb-serial" port="0"/><alias name="serial-lower-controller"/></serial>
    <serial type="pty"><source path="/dev/pts/42"/><target type="usb-serial" port="1"/><alias name="serial-scanner"/></serial>
  </devices></domain>`;
}

describe("repo QEMU USB serial host adapter", () => {
  it("rejects missing or duplicate live libvirt USB serial role mappings", () => {
    assert.throws(
      () => parseLibvirtUsbSerialMappings(domainXml().replace("serial-scanner", "serial-other")),
      /exactly one scanner/,
    );
    assert.throws(
      () => parseLibvirtUsbSerialMappings(domainXml().replace("serial-scanner", "serial-lower-controller")),
      /exactly one lower-controller/,
    );
  });

  it("fails closed when raw protocol evidence is not a production 55 frame or has a bad vend checksum", () => {
    assert.throws(
      () =>
        validateProductionRawSerialFrame({
          direction: "controller-to-daemon",
          rawFrameHex: "FAF0",
          opcode: 0xf0,
          parsedOpcode: "F0",
        }),
      /must start with production frame head 55/,
    );
    assert.throws(
      () =>
        validateProductionRawSerialFrame({
          direction: "daemon-to-controller",
          rawFrameHex: "55020500",
          opcode: 0x02,
          parsedOpcode: "VEND",
        }),
      /VEND CRC must match the production dispense checksum/,
    );
  });

  it("passes the production VM host adapter contract for a live serial-session start", () => {
    const root = makeTempDir("vem-qemu-adapter");
    const bin = join(root, "bin");
    const stateRoot = join(root, "state");
    const out = join(root, "start.json");
    mkdirSync(bin, { recursive: true });
    const virsh = join(bin, "virsh");
    const simulator = join(bin, "lower-controller-sim");
    writeFileSync(virsh, `#!/bin/sh\ncat <<'XML'\n${domainXml()}\nXML\n`);
    writeFileSync(simulator, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(virsh, 0o755);
    chmodSync(simulator, 0o755);
    chmodSync(adapterPath, 0o755);
    let simulatorPid = null;
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/run-vm-host-adapter.mjs",
          "--operation", "start-serial-session",
          "--run-id", "RUN-ISSUE16-ADAPTER",
          "--target-identity", "vm-target://release-testbed-0001",
          "--runtime-base", `runtime-base://sha256/${"a".repeat(64)}`,
          "--sale-correlation-id", "sale-correlation://issue16-adapter",
          "--out", out,
        ],
        {
          cwd: new URL("../..", import.meta.url).pathname,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: join(root, "runner-temp"),
            VEM_VM_HOST_ADAPTER: adapterPath,
            VEM_VM_HOST_ADAPTER_VERSION: QEMU_USB_SERIAL_ADAPTER_VERSION,
            VEM_VM_HOST_ADAPTER_SHA256: `sha256:${createHash("sha256").update(readFileSync(adapterPath)).digest("hex")}`,
            VEM_VM_HOST_ADAPTER_DOMAIN: "win10-runtime-testbed",
            VEM_VM_HOST_ADAPTER_STATE_ROOT: stateRoot,
            VEM_LOWER_CONTROLLER_SIM: simulator,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(report.result, "succeeded");
      assert.equal(report.adapter.identity, "vm-host-adapter://repo-qemu-usb-serial@1.0.0");
      assert.deepEqual(
        report.serialSession.deviceMappings.map(({ role, connectionState }) => ({ role, connectionState })),
        [
          { role: "lower-controller", connectionState: "connected" },
          { role: "scanner", connectionState: "connected" },
        ],
      );
      const [sessionDirectory] = readdirSync(join(stateRoot, "sessions"));
      const state = JSON.parse(readFileSync(join(stateRoot, "sessions", sessionDirectory, "state.json"), "utf8"));
      simulatorPid = state.simulatorPid;
    } finally {
      if (Number.isInteger(simulatorPid)) {
        try {
          process.kill(-simulatorPid, "SIGTERM");
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes delayed-pickup scenario through to the lower-controller simulator state", () => {
    const root = makeTempDir("vem-qemu-adapter-delayed");
    const bin = join(root, "bin");
    const stateRoot = join(root, "state");
    const out = join(root, "start.json");
    const argvLog = join(root, "simulator-argv.log");
    mkdirSync(bin, { recursive: true });
    const virsh = join(bin, "virsh");
    const simulator = join(bin, "lower-controller-sim");
    writeFileSync(virsh, `#!/bin/sh\ncat <<'XML'\n${domainXml()}\nXML\n`);
    writeFileSync(
      simulator,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\nexec sleep 60\n`,
    );
    chmodSync(virsh, 0o755);
    chmodSync(simulator, 0o755);
    chmodSync(adapterPath, 0o755);
    let simulatorPid = null;
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/run-vm-host-adapter.mjs",
          "--operation",
          "start-serial-session",
          "--run-id",
          "RUN-ISSUE17-DELAYED",
          "--target-identity",
          "vm-target://release-testbed-0001",
          "--runtime-base",
          `runtime-base://sha256/${"b".repeat(64)}`,
          "--sale-correlation-id",
          "sale-correlation://issue17-delayed",
          "--out",
          out,
        ],
        {
          cwd: new URL("../..", import.meta.url).pathname,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            RUNNER_TEMP: join(root, "runner-temp"),
            VEM_VM_HOST_ADAPTER: adapterPath,
            VEM_VM_HOST_ADAPTER_VERSION: QEMU_USB_SERIAL_ADAPTER_VERSION,
            VEM_VM_HOST_ADAPTER_SHA256: `sha256:${createHash("sha256").update(readFileSync(adapterPath)).digest("hex")}`,
            VEM_VM_HOST_ADAPTER_DOMAIN: "win10-runtime-testbed",
            VEM_VM_HOST_ADAPTER_STATE_ROOT: stateRoot,
            VEM_LOWER_CONTROLLER_SIM: simulator,
            VEM_LOCAL_TESTBED_SERIAL_SCENARIO: "delayed-pickup",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const [sessionDirectory] = readdirSync(join(stateRoot, "sessions"));
      const state = JSON.parse(
        readFileSync(
          join(stateRoot, "sessions", sessionDirectory, "state.json"),
          "utf8",
        ),
      );
      simulatorPid = state.simulatorPid;
      assert.equal(state.serialScenario, "delayed-pickup");
      assert.match(readFileSync(argvLog, "utf8"), /--scenario\npickup-timeout-success\n/);
    } finally {
      if (Number.isInteger(simulatorPid)) {
        try {
          process.kill(-simulatorPid, "SIGTERM");
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
