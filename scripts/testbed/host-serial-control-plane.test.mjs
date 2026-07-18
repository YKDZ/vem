import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildMqttTopic,
  buildSerialOperationCommand,
  parseHostSerialControlPlaneArgs,
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
    assert.match(command.args.join(" "), /--scanner-injection-operation-nonce op-1/);
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
});
