import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
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
  readRawSerialJournal,
  scannerDescriptorMatchesRequest,
  validateProductionRawSerialFrame,
} from "./qemu-usb-serial-host-adapter.mjs";
import { createScannerCodeDescriptor } from "./vm-host-adapter-contract.mjs";

const adapterPath = new URL(
  "./qemu-usb-serial-host-adapter.mjs",
  import.meta.url,
).pathname;

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
    <serial type="pty"><source path="/dev/pts/41"/><target type="usb-serial" port="0"/><alias name="serial-lower-controller"/><address type="usb" bus="0" port="3.1"/></serial>
    <serial type="pty"><source path="/dev/pts/42"/><target type="usb-serial" port="1"/><alias name="serial-scanner"/><address type="usb" bus="0" port="3.2"/></serial>
  </devices></domain>`;
}

function libvirtNormalizedDomainXml() {
  return domainXml()
    .replace("serial-lower-controller", "serial0")
    .replace("serial-scanner", "serial1")
    .replace('port="3.1"', 'port="1"')
    .replace('port="3.2"', 'port="2"');
}

describe("repo QEMU USB serial host adapter", () => {
  it("accepts a scanner descriptor when the request also carries its operation nonce", () => {
    const descriptor = createScannerCodeDescriptor(
      Buffer.from("2860123456789\r\n", "utf8"),
    );
    assert.equal(
      scannerDescriptorMatchesRequest(descriptor, {
        ...descriptor,
        operationNonce: "scanner-injection://runtime-acceptance-1",
      }),
      true,
    );
    assert.equal(
      scannerDescriptorMatchesRequest(descriptor, {
        ...descriptor,
        scannerCodeDigest: `sha256:${"0".repeat(64)}`,
        operationNonce: "scanner-injection://runtime-acceptance-1",
      }),
      false,
    );
  });

  it("derives roles after libvirt normalizes the serial aliases", () => {
    assert.deepEqual(
      parseLibvirtUsbSerialMappings(libvirtNormalizedDomainXml()).map(
        ({ role, alias }) => ({ role, alias }),
      ),
      [
        { role: "lower-controller", alias: "serial0" },
        { role: "scanner", alias: "serial1" },
      ],
    );
  });

  it("rejects missing or duplicate live libvirt USB serial role mappings", () => {
    assert.throws(
      () =>
        parseLibvirtUsbSerialMappings(
          domainXml().replace("serial-scanner", "serial-other"),
        ),
      /exactly one scanner/,
    );
    assert.throws(
      () =>
        parseLibvirtUsbSerialMappings(
          domainXml().replace("serial-scanner", "serial-lower-controller"),
        ),
      /exactly one lower-controller/,
    );
  });

  it("publishes the live libvirt USB topology for both serial roles", () => {
    const mappings = parseLibvirtUsbSerialMappings(domainXml());
    assert.deepEqual(
      mappings.map(({ role, guestUsbTopology }) => ({ role, guestUsbTopology })),
      [
        {
          role: "lower-controller",
          guestUsbTopology: {
            alias: "serial-lower-controller",
            targetPort: 0,
            usbBus: 0,
            usbPort: "3.1",
          },
        },
        {
          role: "scanner",
          guestUsbTopology: {
            alias: "serial-scanner",
            targetPort: 1,
            usbBus: 0,
            usbPort: "3.2",
          },
        },
      ],
    );
  });

  it("publishes semantic role aliases after libvirt alias normalization", () => {
    const mappings = parseLibvirtUsbSerialMappings(libvirtNormalizedDomainXml());
    assert.equal(mappings[0].alias, "serial0");
    assert.equal(mappings[1].alias, "serial1");
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

  it("accepts the asymmetric production B0 query and environment sample frames", () => {
    assert.equal(
      validateProductionRawSerialFrame({
        direction: "daemon-to-controller",
        rawFrameHex: "55B002",
        opcode: 0xb0,
        parsedOpcode: "B0",
      }).bytes.length,
      3,
    );
    assert.equal(
      validateProductionRawSerialFrame({
        direction: "controller-to-daemon",
        rawFrameHex: "55B02048",
        opcode: 0xb0,
        parsedOpcode: "B0",
      }).bytes.length,
      4,
    );
  });

  it("parses timestamped bytes from the host PTY bridge rather than simulator JSONL", () => {
    const root = makeTempDir("vem-qemu-pty-trace");
    const tracePath = join(root, "qemu-pty.trace");
    try {
      writeFileSync(
        tracePath,
        [
          "> 2026/07/18 08:00:00.123456 length=2",
          " 55 f0",
          "< 2026/07/18 08:00:00.500001 length=3",
          " 55 b0 02",
          "> 2026/07/18 08:00:00.600001 length=4",
          " 55 b0 18 2d",
          "< 2026/07/18 08:00:01.000001 length=4",
          " 55 02 05 31",
        ].join("\n"),
      );
      assert.deepEqual(
        readRawSerialJournal(tracePath).map(
          ({ direction, rawFrameHex, parsedOpcode, capturedAt }) => ({
            direction,
            rawFrameHex,
            parsedOpcode,
            capturedAt,
          }),
        ),
        [
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            parsedOpcode: "F0",
            capturedAt: "2026-07-18T08:00:00.123Z",
          },
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55B002",
            parsedOpcode: "B0",
            capturedAt: "2026-07-18T08:00:00.500Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55B0182D",
            parsedOpcode: "B0",
            capturedAt: "2026-07-18T08:00:00.600Z",
          },
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55020531",
            parsedOpcode: "VEND",
            capturedAt: "2026-07-18T08:00:01.000Z",
          },
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes the production VM host adapter contract for a live serial-session start", () => {
    const root = makeTempDir("vem-qemu-adapter");
    const bin = join(root, "bin");
    const stateRoot = join(root, "state");
    const out = join(root, "start.json");
    mkdirSync(bin, { recursive: true });
    const virsh = join(bin, "virsh");
    const simulator = join(bin, "lower-controller-sim");
    const socat = join(bin, "socat");
    writeFileSync(virsh, `#!/bin/sh\ncat <<'XML'\n${domainXml()}\nXML\n`);
    writeFileSync(simulator, "#!/bin/sh\nexec sleep 60\n");
    writeFileSync(
      socat,
      '#!/bin/sh\nfor value in "$@"; do case "$value" in PTY,link=*) path=${value#PTY,link=}; path=${path%%,*}; touch "$path";; esac; done\nexec sleep 60\n',
    );
    chmodSync(virsh, 0o755);
    chmodSync(simulator, 0o755);
    chmodSync(socat, 0o755);
    chmodSync(adapterPath, 0o755);
    let simulatorPid = null;
    let bridgePid = null;
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/testbed/run-vm-host-adapter.mjs",
          "--operation",
          "start-serial-session",
          "--run-id",
          "RUN-ISSUE16-ADAPTER",
          "--target-identity",
          "vm-target://release-testbed-0001",
          "--runtime-base",
          `runtime-base://sha256/${"a".repeat(64)}`,
          "--sale-correlation-id",
          "sale-correlation://issue16-adapter",
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
          },
        },
      );
      assert.equal(
        result.status,
        0,
        result.stderr ||
          result.stdout ||
          (existsSync(out) ? readFileSync(out, "utf8") : ""),
      );
      const report = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(report.result, "succeeded");
      assert.equal(
        report.adapter.identity,
        "vm-host-adapter://repo-qemu-usb-serial@1.0.0",
      );
      assert.deepEqual(
        report.serialSession.deviceMappings.map(
          ({ role, connectionState }) => ({ role, connectionState }),
        ),
        [
          { role: "lower-controller", connectionState: "connected" },
          { role: "scanner", connectionState: "connected" },
        ],
      );
      const scanner = report.serialSession.deviceMappings.find(
        (mapping) => mapping.role === "scanner",
      );
      assert.deepEqual(scanner.guestUsbTopology, {
        alias: "serial-scanner",
        targetPort: 1,
        usbBus: 0,
        usbPort: "3.2",
      });
      assert.equal(
        scanner.guestDeviceIdentity,
        "guest-device://libvirt-usb-bus-0-port-3-2-target-1",
      );
      const [sessionDirectory] = readdirSync(join(stateRoot, "sessions"));
      const state = JSON.parse(
        readFileSync(
          join(stateRoot, "sessions", sessionDirectory, "state.json"),
          "utf8",
        ),
      );
      simulatorPid = state.simulatorPid;
      bridgePid = state.ptyCapturePid;
    } finally {
      if (Number.isInteger(simulatorPid)) {
        try {
          process.kill(-simulatorPid, "SIGTERM");
        } catch {}
      }
      if (Number.isInteger(bridgePid)) {
        try {
          process.kill(-bridgePid, "SIGKILL");
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the stable socat log as the single raw serial journal", () => {
    const source = readFileSync(adapterPath, "utf8");
    assert.match(
      source,
      /journalPath: join\(path, "raw-serial\.socat\.log"\)/,
    );
    assert.match(source, /const journalPath = qemuUsbSerialSessionPaths\(/);
    assert.match(source, /"-lf",\s*socatLifecycleLogPath/);
    assert.match(
      source,
      /stdio: \["ignore", "ignore", openSync\(journalPath, "a", 0o600\)\]/,
    );
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
    const socat = join(bin, "socat");
    writeFileSync(virsh, `#!/bin/sh\ncat <<'XML'\n${domainXml()}\nXML\n`);
    writeFileSync(
      simulator,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\nexec sleep 60\n`,
    );
    writeFileSync(
      socat,
      '#!/bin/sh\nfor value in "$@"; do case "$value" in PTY,link=*) path=${value#PTY,link=}; path=${path%%,*}; touch "$path";; esac; done\nexec sleep 60\n',
    );
    chmodSync(virsh, 0o755);
    chmodSync(simulator, 0o755);
    chmodSync(socat, 0o755);
    chmodSync(adapterPath, 0o755);
    let simulatorPid = null;
    let bridgePid = null;
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
      bridgePid = state.ptyCapturePid;
      assert.equal(state.serialScenario, "delayed-pickup");
      assert.match(
        readFileSync(argvLog, "utf8"),
        /--scenario\npickup-timeout-success\n/,
      );
    } finally {
      if (Number.isInteger(simulatorPid)) {
        try {
          process.kill(-simulatorPid, "SIGTERM");
        } catch {}
      }
      if (Number.isInteger(bridgePid)) {
        try {
          process.kill(-bridgePid, "SIGKILL");
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the scanner PTY open until binding confirmation stops the probe", () => {
    const implementation = readFileSync(adapterPath, "utf8");
    assert.match(implementation, /const fd = openSync\(path, 'a'\)/);
    assert.match(implementation, /setInterval\(emit, 500\)/);
    assert.doesNotMatch(implementation, /appendFileSync\(path, bytes\); process\.exit/);
  });
});
