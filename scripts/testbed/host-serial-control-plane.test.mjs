import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildMqttTopic,
  buildSerialOperationCommand,
  parseHostSerialControlPlaneArgs,
  waitForRawSerialFrame,
} from "./host-serial-control-plane.mjs";

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
    ]);

    assert.deepEqual(options, {
      workspace: "/workspaces/vem",
      stateRoot: "/var/lib/vem-local-testbed",
      bind: "0.0.0.0",
      port: 26851,
      token: "control-plane-token",
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
        runtimeBase: "runtime-base://sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        outPath: "/tmp/vem-state/collect.json",
        sessionBinding: {
          serialSessionId: "session-1",
          sessionBindingToken: "binding-1",
          startOperationReference: "vm-operation://start-1",
          deviceMappingDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        sale: {
          saleCorrelationId: "sale-correlation-1",
          orderId: "order-1",
          paymentId: "payment-1",
          vendingCommandId: "command-1",
        },
        scannerInjection: {
          operationNonce: "op-1",
          scannerCodeDigest: "sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          scannerCodeByteLength: 18,
          scannerCodeSuffix: "678901",
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
    const root = mkdtempSync(join(tmpdir(), "vem-host-serial-"));
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
          { direction: "daemon-to-controller", rawFrameHex: "55010112", opcode: 1, parsedOpcode: "VEND" },
          { direction: "controller-to-daemon", rawFrameHex: "55F0", opcode: 240, parsedOpcode: "F0" },
          { direction: "controller-to-daemon", rawFrameHex: "55F1", opcode: 241, parsedOpcode: "F1" },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      const boundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "F1",
        timeoutMs: 100,
      });
      assert.deepEqual(
        boundary.protocolFrames.map(({ direction, parsedOpcode }) => ({ direction, parsedOpcode })),
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
        waitForRawSerialFrame({ journalPath, parsedOpcode: "F1", timeoutMs: 100 }),
        /F2 appeared before required F1 boundary/,
      );

      writeFileSync(
        journalPath,
        [
          { direction: "daemon-to-controller", rawFrameHex: "55010112", opcode: 1, parsedOpcode: "VEND" },
          { direction: "controller-to-daemon", rawFrameHex: "55F0", opcode: 240, parsedOpcode: "F0" },
          { direction: "controller-to-daemon", rawFrameHex: "55F1", opcode: 241, parsedOpcode: "F1" },
          { direction: "controller-to-daemon", rawFrameHex: "55AF", opcode: 175, parsedOpcode: "AF" },
          { direction: "controller-to-daemon", rawFrameHex: "55F2", opcode: 242, parsedOpcode: "F2" },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
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
          { direction: "daemon-to-controller", rawFrameHex: "55010112", opcode: 1, parsedOpcode: "VEND" },
          { direction: "controller-to-daemon", rawFrameHex: "55F0", opcode: 240, parsedOpcode: "F0" },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      await assert.rejects(
        waitForRawSerialFrame({ journalPath, parsedOpcode: "VEND", timeoutMs: 100 }),
        /F0 appeared before the before-F0 gate was released/,
      );

      writeFileSync(
        journalPath,
        [
          { direction: "daemon-to-controller", rawFrameHex: "55010112", opcode: 1, parsedOpcode: "VEND" },
          { direction: "controller-to-daemon", rawFrameHex: "55F000", opcode: 240, parsedOpcode: "F0" },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      await assert.rejects(
        waitForRawSerialFrame({ journalPath, parsedOpcode: "F0", timeoutMs: 100 }),
        /raw serial journal record 2 F0 must match the 2-byte production frame 55 F0/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts delayed-pickup boundaries with E5 warnings before F1 and AF before F2", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-host-serial-delayed-"));
    const journalPath = join(root, "raw-serial.jsonl");
    try {
      writeFileSync(
        journalPath,
        [
          { direction: "daemon-to-controller", rawFrameHex: "55010112", opcode: 1, parsedOpcode: "VEND" },
          { direction: "controller-to-daemon", rawFrameHex: "55F0", opcode: 240, parsedOpcode: "F0" },
          { direction: "controller-to-daemon", rawFrameHex: "55E5", opcode: 229, parsedOpcode: "E5" },
          { direction: "controller-to-daemon", rawFrameHex: "55E5", opcode: 229, parsedOpcode: "E5" },
          { direction: "controller-to-daemon", rawFrameHex: "55F1", opcode: 241, parsedOpcode: "F1" },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
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
          { direction: "daemon-to-controller", rawFrameHex: "55010112", opcode: 1, parsedOpcode: "VEND" },
          { direction: "controller-to-daemon", rawFrameHex: "55F0", opcode: 240, parsedOpcode: "F0" },
          { direction: "controller-to-daemon", rawFrameHex: "55E5", opcode: 229, parsedOpcode: "E5" },
          { direction: "controller-to-daemon", rawFrameHex: "55E5", opcode: 229, parsedOpcode: "E5" },
          { direction: "controller-to-daemon", rawFrameHex: "55F1", opcode: 241, parsedOpcode: "F1" },
          { direction: "controller-to-daemon", rawFrameHex: "55AF", opcode: 175, parsedOpcode: "AF" },
          { direction: "controller-to-daemon", rawFrameHex: "55F2", opcode: 242, parsedOpcode: "F2" },
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      const f2DelayedBoundary = await waitForRawSerialFrame({
        journalPath,
        parsedOpcode: "F2",
        serialScenario: "delayed-pickup",
        timeoutMs: 100,
      });
      assert.deepEqual(
        f2DelayedBoundary.protocolFrames.map(({ parsedOpcode }) => parsedOpcode),
        ["VEND", "F0", "E5", "E5", "F1", "AF", "F2"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
