import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildMqttTopic,
  buildSerialOperationCommand,
  createHostSerialControlPlane,
  mockPaymentCreateGatePaths,
  parseHostSerialControlPlaneArgs,
  runJsonCommand,
  waitForRawSerialFrame,
} from "./host-serial-control-plane.mjs";
import {
  qemuUsbSerialSessionPaths,
  QEMU_USB_SERIAL_ADAPTER_VERSION,
} from "./qemu-usb-serial-host-adapter.mjs";
import {
  createFileBackedAudioCaptureTestBackend,
  executeSaleAudioCaptureHostAdapter,
} from "./sale-audio-capture-host-adapter.mjs";

process.env.VEM_TEST_ALLOW_JSON_PTY_FIXTURE = "1";

const adapterPath = new URL(
  "./qemu-usb-serial-host-adapter.mjs",
  import.meta.url,
).pathname;

function isIso8601(value) {
  return Number.isFinite(Date.parse(value));
}

function makeTempDir(prefix) {
  const path = join(
    process.cwd(),
    "test-artifacts",
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

function wavWithTone(frameCount = 48_000, sampleRate = 48_000, channels = 2) {
  const blockAlign = channels * 2;
  const data = Buffer.alloc(frameCount * blockAlign);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = frame % 8 < 2 ? 1_024 : frame % 8 < 4 ? 2_048 : 0;
    for (let channel = 0; channel < channels; channel += 1) {
      data.writeInt16LE(sample, frame * blockAlign + channel * 2);
    }
  }
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

async function requestJson(baseUrl, token, path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

describe("host serial control plane", () => {
  it("parses an absolute stateful HTTP listener contract", () => {
    const options = parseHostSerialControlPlaneArgs([
      "--workspace",
      "/workspaces/vem",
      "--state-root",
      "/var/lib/vem-local-testbed",
      "--bind",
      "0.0.0.0",
      "--port",
      "26851",
      "--token",
      "control-plane-token",
      "--libvirt-uri",
      "qemu:///system",
      "--domain-name",
      "win10-runtime-testbed",
    ]);

    assert.deepEqual(options, {
      workspace: "/workspaces/vem",
      stateRoot: "/var/lib/vem-local-testbed",
      bind: "0.0.0.0",
      port: 26851,
      token: "control-plane-token",
      libvirtUri: "qemu:///system",
      domainName: "win10-runtime-testbed",
    });
  });

  it("builds the canonical dispense topic and staged host adapter commands", () => {
    assert.equal(
      buildMqttTopic("VEM-TESTBED-LOCAL"),
      "vem/machines/VEM-TESTBED-LOCAL/commands/dispense",
    );
    const command = buildSerialOperationCommand({
      workspace: "/workspaces/vem",
      stateRoot: "/tmp/vem-state",
      request: {
        operation: "collect-serial-evidence",
        runId: "RUN-16",
        targetIdentity: "vm-target://release-testbed-0001",
        runtimeBase:
          "runtime-base://sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        outPath: "/tmp/vem-state/collect.json",
        sessionBinding: {
          serialSessionId: "session-1",
          sessionBindingToken: "binding-1",
          startOperationReference: "vm-operation://start-1",
          deviceMappingDigest:
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        sale: {
          saleCorrelationId: "sale-correlation-1",
          orderId: "order-1",
          paymentId: "payment-1",
          vendingCommandId: "command-1",
        },
        scannerInjection: {
          operationNonce: "op-1",
          scannerCodeDigest:
            "sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          scannerCodeByteLength: 18,
          scannerCodeSuffix: "678901",
        },
        operationEvidence: {
          runnerChallenge:
            "serial-runner-challenge://sha256-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          startReportDigest:
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          injectReportDigest:
            "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        },
      },
    });

    assert.equal(command.command, process.execPath);
    assert.deepEqual(command.args.slice(0, 2), [
      "scripts/testbed/run-vm-host-adapter.mjs",
      "--operation",
    ]);
    assert.match(command.args.join(" "), /collect-serial-evidence/);
    assert.match(command.args.join(" "), /--vending-command-id command-1/);
    assert.match(
      command.args.join(" "),
      /--scanner-injection-operation-nonce op-1/,
    );
    assert.match(command.args.join(" "), /--serial-runner-challenge/);
    assert.match(command.args.join(" "), /--serial-start-report-digest/);
    assert.match(command.args.join(" "), /--serial-inject-report-digest/);
  });

  it("passes delayed-pickup scenario into start-serial-session commands", () => {
    const command = buildSerialOperationCommand({
      workspace: "/workspaces/vem",
      stateRoot: "/tmp/vem-state",
      request: {
        operation: "start-serial-session",
        runId: "RUN-17",
        targetIdentity: "vm-target://release-testbed-0001",
        runtimeBase:
          "runtime-base://sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        serialScenario: "delayed-pickup",
        saleCorrelationId: "sale-correlation-17",
        outPath: "/tmp/vem-state/start.json",
      },
    });

    assert.equal(
      command.env.VEM_LOCAL_TESTBED_SERIAL_SCENARIO,
      "delayed-pickup",
    );
  });

  it("passes the explicit E6 failure scenario into the real host serial adapter", () => {
    const command = buildSerialOperationCommand({
      workspace: "/workspaces/vem",
      stateRoot: "/tmp/vem-state",
      request: {
        operation: "start-serial-session",
        runId: "RUN-20",
        targetIdentity: "vm-target://release-testbed-0001",
        runtimeBase:
          "runtime-base://sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        serialScenario: "e6",
        saleCorrelationId: "sale-correlation-20",
        outPath: "/tmp/vem-state/start.json",
      },
    });

    assert.equal(command.env.VEM_LOCAL_TESTBED_SERIAL_SCENARIO, "e6");
  });

  it("arms, polls, releases, and reopens the mock payment create gate through the host control plane API", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-host-control-plane-"));
    const controlPlane = createHostSerialControlPlane({
      workspace: "/workspaces/vem",
      stateRoot: root,
      bind: "127.0.0.1",
      port: 0,
      token: "control-plane-token",
    });
    const server = controlPlane.listen();
    try {
      if (!server.listening) {
        await once(server, "listening");
      }
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const headers = {
        authorization: "Bearer control-plane-token",
        "content-type": "application/json",
      };

      const arm = await fetch(`${baseUrl}/v1/mock-payment-create-gate/arm`, {
        method: "POST",
        headers,
        body: "{}",
      }).then((response) => response.json());
      assert.equal(arm.ok, true);
      assert.equal(arm.state, "hold");

      const gate = mockPaymentCreateGatePaths(root);
      const armedState = JSON.parse(readFileSync(gate.statePath, "utf8"));
      assert.deepEqual(armedState, { state: "hold" });

      const status = await fetch(
        `${baseUrl}/v1/mock-payment-create-gate/status`,
        {
          method: "POST",
          headers,
          body: "{}",
        },
      ).then((response) => response.json());
      assert.equal(status.ok, true);
      assert.equal(status.pending, null);

      const release = await fetch(
        `${baseUrl}/v1/mock-payment-create-gate/release`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ paymentNo: "PAY-1" }),
        },
      ).then((response) => response.json());
      assert.equal(release.ok, true);
      assert.equal(release.state, "release");
      assert.deepEqual(JSON.parse(readFileSync(gate.statePath, "utf8")), {
        state: "release",
        paymentNo: "PAY-1",
      });

      const open = await fetch(`${baseUrl}/v1/mock-payment-create-gate/open`, {
        method: "POST",
        headers,
        body: "{}",
      }).then((response) => response.json());
      assert.equal(open.ok, true);
      assert.equal(open.state, "open");
      assert.deepEqual(JSON.parse(readFileSync(gate.statePath, "utf8")), {
        state: "open",
      });
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the repo-owned adapter wrapper and local mosquitto topic capture", () => {
    const implementation = readFileSync(
      new URL("./host-serial-control-plane.mjs", import.meta.url),
      "utf8",
    );
    assert.match(implementation, /run-vm-host-adapter\.mjs/);
    assert.match(implementation, /vem-local-testbed-mosquitto/);
    assert.match(implementation, /commands\/dispense/);
    assert.match(implementation, /collect-serial-evidence/);
    assert.doesNotMatch(implementation, /simulatedHardwareSaleFlow/);
  });

  it("waits on independent raw inbound F1 evidence and fails closed on an invalid boundary", async () => {
    const root = makeTempDir("vem-host-serial");
    const journalPath = join(root, "raw-serial.jsonl");
    try {
      writeFileSync(
        journalPath,
        `${JSON.stringify({ direction: "daemon-to-controller", rawFrameHex: "55010112", opcode: 1, parsedOpcode: "VEND" })}\n`,
      );
      const beforeF0Boundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "VEND",
        timeoutMs: 100,
      });
      assert.deepEqual(
        beforeF0Boundary.protocolFrames.map(({ parsedOpcode }) => parsedOpcode),
        ["VEND"],
      );

      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55010112",
            opcode: 1,
            parsedOpcode: "VEND",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const boundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "F1",
        timeoutMs: 100,
      });
      assert.deepEqual(
        boundary.protocolFrames.map(({ direction, parsedOpcode }) => ({
          direction,
          parsedOpcode,
        })),
        [
          { direction: "daemon-to-controller", parsedOpcode: "VEND" },
          { direction: "controller-to-daemon", parsedOpcode: "F0" },
          { direction: "controller-to-daemon", parsedOpcode: "F1" },
        ],
      );

      writeFileSync(
        journalPath,
        `${JSON.stringify({ direction: "controller-to-daemon", rawFrameHex: "55F2", opcode: 242, parsedOpcode: "F2" })}\n`,
      );
      await assert.rejects(
        waitForRawSerialFrame({
          journalPath,
          parsedOpcode: "F1",
          timeoutMs: 100,
        }),
        /F2 appeared before required F1 boundary/,
      );

      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55010112",
            opcode: 1,
            parsedOpcode: "VEND",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55AF",
            opcode: 175,
            parsedOpcode: "AF",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F2",
            opcode: 242,
            parsedOpcode: "F2",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const f2Boundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "F2",
        timeoutMs: 100,
      });
      assert.deepEqual(
        f2Boundary.protocolFrames.map(({ parsedOpcode }) => parsedOpcode),
        ["VEND", "F0", "F1", "AF", "F2"],
      );

      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55010112",
            opcode: 1,
            parsedOpcode: "VEND",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      await assert.rejects(
        waitForRawSerialFrame({
          journalPath,
          parsedOpcode: "VEND",
          timeoutMs: 100,
        }),
        /F0 appeared before the before-F0 gate was released/,
      );

      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55010112",
            opcode: 1,
            parsedOpcode: "VEND",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F000",
            opcode: 240,
            parsedOpcode: "F0",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      await assert.rejects(
        waitForRawSerialFrame({
          journalPath,
          parsedOpcode: "F0",
          timeoutMs: 100,
        }),
        /raw serial journal record 2 F0 must match the 2-byte production frame 55 F0/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts delayed-pickup boundaries with E5 warnings before F1 and AF before F2", async () => {
    const root = makeTempDir("vem-host-serial-delayed");
    const journalPath = join(root, "raw-serial.jsonl");
    try {
      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55010112",
            opcode: 1,
            parsedOpcode: "VEND",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const f1Boundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "F1",
        serialScenario: "delayed-pickup",
        timeoutMs: 100,
      });
      assert.deepEqual(
        f1Boundary.protocolFrames.map(({ parsedOpcode }) => parsedOpcode),
        ["VEND", "F0", "E5", "E5", "F1"],
      );

      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55010112",
            opcode: 1,
            parsedOpcode: "VEND",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55AF",
            opcode: 175,
            parsedOpcode: "AF",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F2",
            opcode: 242,
            parsedOpcode: "F2",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const f2DelayedBoundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "F2",
        serialScenario: "delayed-pickup",
        timeoutMs: 100,
      });
      assert.deepEqual(
        f2DelayedBoundary.protocolFrames.map(
          ({ parsedOpcode }) => parsedOpcode,
        ),
        ["VEND", "F0", "E5", "E5", "F1", "AF", "F2"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts E6 boundaries with 15/25-second pickup timeout warning timing", async () => {
    const root = makeTempDir("vem-host-serial-e6-timeout");
    const journalPath = join(root, "raw-serial.jsonl");
    try {
      writeFileSync(
        journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55010112",
            opcode: 1,
            parsedOpcode: "VEND",
            capturedAt: "2026-07-18T08:00:00.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
            capturedAt: "2026-07-18T08:00:01.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
            capturedAt: "2026-07-18T08:00:16.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
            capturedAt: "2026-07-18T08:00:20.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
            capturedAt: "2026-07-18T08:00:26.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
            capturedAt: "2026-07-18T08:00:28.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55AF",
            opcode: 175,
            parsedOpcode: "AF",
            capturedAt: "2026-07-18T08:00:30.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E6",
            opcode: 230,
            parsedOpcode: "E6",
            capturedAt: "2026-07-18T08:00:35.000Z",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const e6Boundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "E6",
        serialScenario: "e6",
        timeoutMs: 100,
      });
      assert.deepEqual(
        e6Boundary.protocolFrames.map(({ parsedOpcode }) => parsedOpcode),
        ["VEND", "F0", "E5", "E5", "F1", "E6"],
      );

      const frames = e6Boundary.protocolFrames;
      const f0 = frames.find((frame) => frame.parsedOpcode === "F0");
      const e5 = frames.filter((frame) => frame.parsedOpcode === "E5");
      assert.equal(
        frames.some((frame) => frame.parsedOpcode === "F1"),
        true,
      );
      assert.equal(isIso8601(f0?.capturedAt), true);
      assert.equal(isIso8601(e5[0]?.capturedAt), true);
      assert.equal(isIso8601(e5[1]?.capturedAt), true);
      const f0At = Date.parse(f0.capturedAt);
      const e5aAt = Date.parse(e5[0].capturedAt);
      const e5bAt = Date.parse(e5[1].capturedAt);
      const firstDelta = e5aAt - f0At;
      const secondDelta = e5bAt - f0At;
      assert.ok(firstDelta > 12_000 && firstDelta < 18_000);
      assert.ok(secondDelta > 22_000 && secondDelta < 28_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves sale audio start/stop over HTTP and exports timestamped raw serial evidence through the host control plane", async () => {
    const root = makeTempDir("vem-host-audio-http");
    const workspace = new URL("../..", import.meta.url).pathname;
    const stateRoot = join(root, "state");
    const bin = join(root, "bin");
    const token = "control-plane-token";
    const previousEnvironment = {
      PATH: process.env.PATH,
      RUNNER_TEMP: process.env.RUNNER_TEMP,
      VEM_VM_HOST_ADAPTER: process.env.VEM_VM_HOST_ADAPTER,
      VEM_VM_HOST_ADAPTER_VERSION: process.env.VEM_VM_HOST_ADAPTER_VERSION,
      VEM_VM_HOST_ADAPTER_SHA256: process.env.VEM_VM_HOST_ADAPTER_SHA256,
      VEM_VM_HOST_ADAPTER_DOMAIN: process.env.VEM_VM_HOST_ADAPTER_DOMAIN,
      VEM_VM_HOST_ADAPTER_STATE_ROOT:
        process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT,
      VEM_LOWER_CONTROLLER_SIM: process.env.VEM_LOWER_CONTROLLER_SIM,
    };
    const domainXml = `<domain type="kvm"><devices>
      <serial type="pty"><source path="/dev/pts/41"/><target type="usb-serial" port="0"/><alias name="serial-lower-controller"/><address type="usb" bus="0" port="3.1"/></serial>
      <serial type="pty"><source path="/dev/pts/42"/><target type="usb-serial" port="1"/><alias name="serial-scanner"/><address type="usb" bus="0" port="3.2"/></serial>
    </devices></domain>`;
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "virsh"),
      `#!/bin/sh\ncat <<'XML'\n${domainXml}\nXML\n`,
    );
    writeFileSync(
      join(bin, "lower-controller-sim"),
      "#!/bin/sh\nexec sleep 60\n",
    );
    writeFileSync(
      join(bin, "socat"),
      '#!/bin/sh\nfor value in "$@"; do case "$value" in PTY,link=*) path=${value#PTY,link=}; path=${path%%,*}; touch "$path";; esac; done\nexec sleep 60\n',
    );
    chmodSync(join(bin, "virsh"), 0o755);
    chmodSync(join(bin, "lower-controller-sim"), 0o755);
    chmodSync(join(bin, "socat"), 0o755);
    let controlPlane;
    let server;
    try {
      process.env.PATH = `${bin}:${process.env.PATH}`;
      process.env.RUNNER_TEMP = join(root, "runner-temp");
      process.env.VEM_VM_HOST_ADAPTER = adapterPath;
      process.env.VEM_VM_HOST_ADAPTER_VERSION = QEMU_USB_SERIAL_ADAPTER_VERSION;
      process.env.VEM_VM_HOST_ADAPTER_SHA256 = `sha256:${createHash("sha256").update(readFileSync(adapterPath)).digest("hex")}`;
      process.env.VEM_VM_HOST_ADAPTER_DOMAIN = "win10-runtime-testbed";
      process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT = join(stateRoot, "adapter");
      process.env.VEM_LOWER_CONTROLLER_SIM = join(bin, "lower-controller-sim");
      const capturedWavPath = join(root, "captured.wav");
      writeFileSync(capturedWavPath, "");
      controlPlane = createHostSerialControlPlane(
        {
          workspace,
          stateRoot,
          bind: "127.0.0.1",
          port: 0,
          token,
          libvirtUri: "qemu:///system",
          domainName: "win10-runtime-testbed",
        },
        {
          executeSaleAudioCapture: (input, dependencies) =>
            executeSaleAudioCaptureHostAdapter(input, {
              ...dependencies,
              backendFactory: () =>
                createFileBackedAudioCaptureTestBackend(capturedWavPath),
              readSerialJournal: (journalPath) =>
                readFileSync(journalPath, "utf8")
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .map((line) => JSON.parse(line)),
            }),
          abortSaleAudioCapture: async () => ({ aborted: true }),
        },
      );
      server = controlPlane.listen();
      await new Promise((resolve) => server.once("listening", resolve));
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const session = await requestJson(
        baseUrl,
        token,
        "/v1/serial-sessions/start",
        {
          runId: "RUN-17-CONTROL-PLANE",
          machineCode: "MACHINE-17",
          targetIdentity: "vm-target://runtime-testbed",
          runtimeBase: `runtime-base://sha256/${"a".repeat(64)}`,
          saleCorrelationId: "sale-correlation://run-17-control-plane",
          serialScenario: "delayed-pickup",
        },
      );
      assert.equal(
        session.qemuUsbSerialMappings.every(
          (mapping) =>
            ["lower-controller", "scanner"].includes(mapping.role) &&
            typeof mapping.guestUsbTopology?.alias === "string",
        ),
        true,
      );
      const probe = await requestJson(
        baseUrl,
        token,
        `/v1/serial-sessions/${session.sessionId}/stop-scanner-probe`,
        {},
      );
      assert.equal(
        probe.scannerBindingProbe.purpose,
        "non_payment_scanner_binding_probe",
      );
      assert.equal(
        probe.scannerBindingProbe.stopReason,
        "daemon_binding_confirmed",
      );
      assert.equal(typeof probe.scannerBindingProbe.stoppedAt, "string");
      const sessionPaths = qemuUsbSerialSessionPaths(
        process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT,
        session.binding.serialSessionId,
      );
      writeFileSync(
        sessionPaths.journalPath,
        [
          {
            direction: "daemon-to-controller",
            rawFrameHex: "55020531",
            opcode: 2,
            parsedOpcode: "VEND",
            capturedAt: "2026-07-18T08:00:00.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F0",
            opcode: 240,
            parsedOpcode: "F0",
            capturedAt: "2026-07-18T08:00:01.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
            capturedAt: "2026-07-18T08:00:16.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55E5",
            opcode: 229,
            parsedOpcode: "E5",
            capturedAt: "2026-07-18T08:00:26.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F1",
            opcode: 241,
            parsedOpcode: "F1",
            capturedAt: "2026-07-18T08:00:31.000Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55AF",
            opcode: 175,
            parsedOpcode: "AF",
            capturedAt: "2026-07-18T08:00:31.500Z",
          },
          {
            direction: "controller-to-daemon",
            rawFrameHex: "55F2",
            opcode: 242,
            parsedOpcode: "F2",
            capturedAt: "2026-07-18T08:00:32.000Z",
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const started = await requestJson(
        baseUrl,
        token,
        "/v1/audio-captures/start",
        {
          sessionId: session.sessionId,
          runId: "RUN-17-CONTROL-PLANE",
          lifecycleReference: "vm-lifecycle://run-17-control-plane.runtime",
          transactionId: "transaction://run-17-control-plane.sale",
          targetIdentity: "vm-target://runtime-testbed",
          operationId: "audio-operation-17",
          runtime: {
            processId: 42,
            executablePath: "C:\\VEM\\bringup\\machine.exe",
            principal: "FIELD\\Operator",
            sessionId: 7,
            cdpTargetId: "target-17",
            cdpSessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
          },
        },
      );
      writeFileSync(capturedWavPath, wavWithTone());
      const stopped = await requestJson(
        baseUrl,
        token,
        `/v1/audio-captures/${started.audioCaptureId}/stop`,
        {
          saleCorrelationId: "sale-correlation://run-17-control-plane.sale",
          orderId: "11111111-1111-4111-8111-111111111111",
          orderNo: "ORDER-17-CONTROL-PLANE",
          commandId: "22222222-2222-4222-8222-222222222222",
          commandNo: "COMMAND-17-CONTROL-PLANE",
        },
      );
      assert.equal(stopped.stopReport.capture.source, "windows_default_output");
      assert.equal(stopped.stopReport.evidence.length, 2);
      assert.equal(stopped.evidencePayloads.length, 2);
      assert.equal(
        stopped.evidencePayloads.every(
          (entry) =>
            typeof entry.fileName === "string" &&
            Buffer.from(entry.bytesBase64, "base64").length > 0,
        ),
        true,
      );
      const serialFile = stopped.stopReport.evidence.find(
        (entry) => entry.role === "sale-serial-frame-capture",
      );
      const serialCapture = JSON.parse(
        readFileSync(
          join(
            controlPlane.audioCaptures.get(started.audioCaptureId)
              .evidenceDirectory,
            serialFile.fileName,
          ),
          "utf8",
        ),
      );
      assert.equal(
        serialCapture.frames.every(
          (frame) => typeof frame.capturedAt === "string",
        ),
        true,
      );
      const recovered = await requestJson(
        baseUrl,
        token,
        "/v1/audio-captures/start",
        {
          sessionId: session.sessionId,
          runId: "RUN-17-CONTROL-PLANE",
          lifecycleReference: "vm-lifecycle://run-17-control-plane.runtime",
          transactionId: "transaction://run-17-control-plane.recovered",
          targetIdentity: "vm-target://runtime-testbed",
          operationId: "audio-operation-response-lost",
          runtime: {
            processId: 42,
            executablePath: "C:\\VEM\\bringup\\machine.exe",
            principal: "FIELD\\Operator",
            sessionId: 7,
            cdpTargetId: "target-17",
            cdpSessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
          },
        },
      );
      const retried = await requestJson(
        baseUrl,
        token,
        "/v1/audio-captures/start",
        {
          sessionId: session.sessionId,
          runId: "RUN-17-CONTROL-PLANE",
          lifecycleReference: "vm-lifecycle://run-17-control-plane.runtime",
          transactionId: "transaction://run-17-control-plane.recovered",
          targetIdentity: "vm-target://runtime-testbed",
          operationId: "audio-operation-response-lost",
          runtime: {
            processId: 42,
            executablePath: "C:\\VEM\\bringup\\machine.exe",
            principal: "FIELD\\Operator",
            sessionId: 7,
            cdpTargetId: "target-17",
            cdpSessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
          },
        },
      );
      assert.equal(retried.audioCaptureId, recovered.audioCaptureId);
      assert.equal(retried.repeated, true);
      const cancelled = await requestJson(
        baseUrl,
        token,
        "/v1/audio-captures/cancel",
        {
          operationId: "audio-operation-response-lost",
        },
      );
      assert.equal(cancelled.status, "cancelled");
      const recoveredCapture = controlPlane.audioCaptures.get(
        recovered.audioCaptureId,
      );
      assert.equal(recoveredCapture.cancelledAt !== null, true);
      const diagnostics = await requestJson(
        baseUrl,
        token,
        `/v1/audio-captures/${recovered.audioCaptureId}/diagnostics`,
      );
      assert.equal(diagnostics.status, "cancelled");
      assert.equal(diagnostics.cancelledAt, recoveredCapture.cancelledAt);
      const replacement = await requestJson(
        baseUrl,
        token,
        "/v1/serial-sessions/start",
        {
          runId: "RUN-17-CONTROL-PLANE-REPLACEMENT",
          machineCode: "MACHINE-17",
          targetIdentity: "vm-target://runtime-testbed",
          runtimeBase: `runtime-base://sha256/${"b".repeat(64)}`,
          saleCorrelationId:
            "sale-correlation://run-17-control-plane-replacement",
        },
      );
      assert.equal(controlPlane.sessions.has(session.sessionId), false);
      assert.equal(controlPlane.sessions.has(replacement.sessionId), true);
      assert.equal(controlPlane.sessions.size, 1);
      const replacedState = JSON.parse(
        readFileSync(sessionPaths.statePath, "utf8"),
      );
      assert.equal(replacedState.active, false);
      assert.equal(replacedState.cleanup.survivingProcessCount, 0);
      assert.equal(replacedState.cleanup.survivingSocketCount, 0);
      await requestJson(
        baseUrl,
        token,
        `/v1/serial-sessions/${replacement.sessionId}/abort`,
      );
      assert.equal(controlPlane.sessions.size, 0);
    } finally {
      if (controlPlane) await controlPlane.close();
      else if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces a deadline and escalates a SIGTERM-resistant host command to SIGKILL", async () => {
    const root = makeTempDir("vem-run-json-command-timeout");
    const childPath = join(root, "resistant-child.mjs");
    writeFileSync(
      childPath,
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);\n',
    );
    const startedAt = Date.now();
    try {
      await assert.rejects(
        runJsonCommand(
          {
            command: process.execPath,
            args: [childPath],
            cwd: root,
            env: process.env,
          },
          { timeoutMs: 100, terminationGraceMs: 100 },
        ),
        /exceeded 100ms deadline/,
      );
      assert.ok(Date.now() - startedAt < 2_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
