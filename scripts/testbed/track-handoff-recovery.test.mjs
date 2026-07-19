import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isActiveTransaction,
  isTerminalTransaction,
  captureTrackTerminalFacts,
  recoverTrackHandoff,
} from "./track-handoff-recovery.mjs";

describe("Track Handoff Recovery", () => {
  it("records checkout facts and marks an unsettled production route before recovery", async () => {
    const calls = [];
    const terminal = await captureTrackTerminalFacts({
      track: { key: "scanner" },
      context: { report: { sessionStart: { sessionId: "serial-1" } } },
      readRoute: async () => "#/checkout",
      daemonGet: async (path) => {
        calls.push(path);
        return { path };
      },
      platformQuery: async () => ({ inventories: [] }),
    });
    assert.equal(terminal.ok, false);
    assert.match(terminal.reason, /#\/checkout/);
    assert.deepEqual(calls, [
      "/v1/transactions/current",
      "/v1/sale-start-capability",
      "/v1/sale-view",
      "/v1/hardware-bindings",
    ]);
    assert.equal(terminal.facts.deviceSession.sessionId, "serial-1");
  });

  it("does not require host fast-sale session IDs to match hardware binding identities", async () => {
    const terminal = await captureTrackTerminalFacts({
      track: { key: "scanner" },
      context: {
        report: { sessionStart: { sessionId: "host-fast-sale-session" } },
      },
      readRoute: async () => "#/result/success",
      daemonGet: async (path) => {
        if (path === "/v1/hardware-bindings") {
          return {
            roles: [
              {
                role: "scanner",
                binding: {
                  identity: {
                    identityKey: "usb:usb:vid_1a86&pid_7523",
                  },
                },
              },
            ],
          };
        }
        if (path === "/v1/sale-start-capability") return { canStartSale: true };
        if (path === "/v1/transactions/current") return null;
        return { path };
      },
      platformQuery: async () => ({ inventories: [] }),
    });
    assert.equal(terminal.ok, true);
    assert.equal(
      terminal.facts.deviceSession.sessionId,
      "host-fast-sale-session",
    );
    assert.equal(terminal.facts.hardwareBindings.roles.length, 1);
  });

  it("selects the host control-plane session instead of the nested serial evidence identity", async () => {
    const terminal = await captureTrackTerminalFacts({
      track: { key: "fast" },
      context: {
        report: {
          summary: { serialSessionId: "serial-session://sha256-evidence" },
          serial: {
            start: {
              sessionId: "fast-sale-control-session",
              binding: {
                serialSessionId: "serial-session://sha256-evidence",
              },
            },
          },
        },
      },
      readRoute: async () => "#/catalog",
      daemonGet: async (path) => {
        if (path === "/v1/transactions/current") return null;
        if (path === "/v1/hardware-bindings") return { roles: [] };
        return {};
      },
      platformQuery: async () => ({ inventories: [] }),
    });
    assert.equal(
      terminal.facts.deviceSession.sessionId,
      "fast-sale-control-session",
    );
  });

  it("records hardware binding degradation without reclassifying a completed child track", async () => {
    const terminal = await captureTrackTerminalFacts({
      track: { key: "scanner" },
      context: { report: {} },
      readRoute: async () => "#/result/success",
      daemonGet: async (path) => {
        if (path === "/v1/hardware-bindings") return { notRoles: [] };
        if (path === "/v1/sale-start-capability") return { canStartSale: true };
        if (path === "/v1/transactions/current") return null;
        return { path };
      },
      platformQuery: async () => ({ inventories: [] }),
    });
    assert.equal(terminal.ok, true);
    assert.deepEqual(terminal.facts.hardwareBindings, { notRoles: [] });
  });

  it("allows null device session when no control-plane session is available yet", async () => {
    const terminal = await captureTrackTerminalFacts({
      track: { key: "scanner" },
      context: { report: {} },
      readRoute: async () => "#/result/success",
      daemonGet: async (path) => {
        if (path === "/v1/hardware-bindings") {
          return {
            roles: [
              {
                role: "scanner",
              },
            ],
          };
        }
        if (path === "/v1/sale-start-capability") return { canStartSale: true };
        if (path === "/v1/transactions/current") return null;
        return { path };
      },
      platformQuery: async () => ({ inventories: [] }),
    });
    assert.equal(terminal.ok, true);
  });

  it("only uses bounded controls after capture and never applies recovery to Vision protocol failure", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "visionTryOn", transactionProducing: false },
      terminal: { facts: { route: "#/catalog" } },
      fixtureAllocation: {
        visionTryOn: { slotCode: "A3", inventoryId: "vision" },
      },
      returnToCatalog: async () => calls.push("catalog"),
      disableFaultInjection: async () => calls.push("fault"),
      restoreSerialSession: async () => calls.push("serial"),
      restoreFixtureStock: async () => calls.push("stock"),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["fault"]);
    assert.deepEqual(result.actions, ["disableFaultInjection"]);
  });

  it("preserves every available terminal fact when one daemon observation fails", async () => {
    const terminal = await captureTrackTerminalFacts({
      track: { key: "ipcRecovery" },
      context: { report: {} },
      readRoute: async () => "#/dispensing",
      daemonGet: async (path) => {
        if (path === "/v1/sale-view") throw new Error("daemon IPC unavailable");
        return { path };
      },
      platformQuery: async () => ({ inventories: [{ id: "inventory-ipc" }] }),
    });
    assert.equal(terminal.ok, false);
    assert.equal(terminal.facts.route, "#/dispensing");
    assert.equal(terminal.facts.saleView, null);
    assert.equal(terminal.facts.inventory.inventories[0].id, "inventory-ipc");
    assert.match(terminal.reason, /saleView/);
    assert.match(terminal.diagnostics[0], /daemon IPC unavailable/);
  });

  it("rejects a settled route only when transaction facts prove leakage", async () => {
    const terminal = await captureTrackTerminalFacts({
      track: { key: "fast" },
      context: { report: {} },
      readRoute: async () => "#/catalog",
      daemonGet: async (path) =>
        path === "/v1/transactions/current"
          ? { orderId: "order-1", nextAction: "wait_payment" }
          : { canStartSale: false },
      platformQuery: async () => ({ inventories: [] }),
    });
    assert.equal(terminal.ok, false);
    assert.match(terminal.reason, /transaction remains active/);
  });

  it("treats terminal success with orderId as non-leaked", () => {
    assert.equal(
      isActiveTransaction({ orderId: "order-1", nextAction: "success" }),
      false,
    );
    assert.equal(
      isTerminalTransaction({ orderId: "order-1", nextAction: "success" }),
      true,
    );
  });

  it("returns a failure when active return is unavailable on payment route", async () => {
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/payment",
          transaction: { orderId: "order-1", nextAction: "success" },
        },
      },
      fixtureAllocation: {},
      returnToCatalog: async () => {
        throw new Error("payment cancel is disabled");
      },
      disableFaultInjection: async () => {
        assert.fail("fault injection should be skipped on return failure");
      },
    });
    assert.equal(result.ok, false);
    assert.match(
      result.errors[0],
      /returnToCatalog: payment cancel is disabled/,
    );
    assert.deepEqual(result.actions, []);
  });

  it("allows payment success snapshot with orderId to recover without waiting", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/payment",
          transaction: { orderId: "order-1", nextAction: "success" },
        },
      },
      fixtureAllocation: {},
      returnToCatalog: async () => calls.push("catalog"),
      disableFaultInjection: async () => calls.push("fault"),
      waitForTransactionTerminal: async () => {
        assert.fail("active transaction should not wait");
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["catalog", "fault"]);
    assert.deepEqual(result.actions, [
      "returnToCatalog",
      "disableFaultInjection",
    ]);
  });

  it("wait_payment snapshot is treated as leaked and must be waited on before recovery controls", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/payment",
          transaction: { orderId: "order-1", nextAction: "wait_payment" },
        },
      },
      fixtureAllocation: {},
      returnToCatalog: async () => calls.push("catalog"),
      disableFaultInjection: async () => calls.push("fault"),
      waitForTransactionTerminal: async () => ({
        orderId: "order-1",
        nextAction: "wait_payment",
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /active transaction did not reach/);
    assert.deepEqual(calls, []);
  });

  it("treats a wait_for loop settled response as terminal even with orderId", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/payment",
          transaction: { orderId: "order-1", nextAction: "wait_payment" },
        },
      },
      fixtureAllocation: {},
      returnToCatalog: async () => calls.push("catalog"),
      disableFaultInjection: async () => calls.push("fault"),
      waitForTransactionTerminal: async () => ({
        orderId: "order-1",
        nextAction: "success",
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["catalog", "fault"]);
    assert.deepEqual(result.actions, [
      "returnToCatalog",
      "disableFaultInjection",
    ]);
  });
});
