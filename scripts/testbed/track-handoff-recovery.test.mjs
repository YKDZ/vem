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
      track: { key: "visionExperience", transactionProducing: false },
      terminal: { facts: { route: "#/catalog" } },
      fixtureAllocation: {
        visionExperience: { slotDisplayLabel: "A3", inventoryId: "vision" },
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

  it("records supported fixture recovery evidence after restoring a track fixture", async () => {
    const result = await recoverTrackHandoff({
      track: {
        key: "stockMaintenance",
        fixtureKey: "stockMaintenance",
        restoreFixtureStock: true,
      },
      terminal: { facts: { route: "#/catalog" } },
      fixtureAllocation: {
        stockMaintenance: { inventoryId: "inventory-stock-1", onHandQty: 1 },
      },
      disableFaultInjection: async () => undefined,
      restoreFixtureStock: async (fixture) => ({
        targetQuantity: fixture.onHandQty,
        daemon: { changed: true, mode: "physical_stock_attestation" },
        platform: {
          inventories: [
            {
              inventoryId: fixture.inventoryId,
              onHandQty: fixture.onHandQty,
              reservedQty: 0,
            },
          ],
        },
      }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.actions, [
      "disableFaultInjection",
      "restoreFixtureStock",
    ]);
    assert.deepEqual(result.evidence.fixtureStock, {
      targetQuantity: 1,
      daemon: { changed: true, mode: "physical_stock_attestation" },
      platform: {
        inventories: [
          { inventoryId: "inventory-stock-1", onHandQty: 1, reservedQty: 0 },
        ],
      },
    });
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

  it("allows the payment recovery set to hand an uncertain transaction to bounded recovery", async () => {
    const terminal = await captureTrackTerminalFacts({
      track: { key: "paymentRecovery", allowActiveTransactionHandoff: true },
      context: { report: {} },
      readRoute: async () => "#/payment",
      daemonGet: async (path) =>
        path === "/v1/transactions/current"
          ? { orderId: "order-uncertain", nextAction: "wait_payment" }
          : {},
      platformQuery: async () => ({ inventories: [] }),
    });
    assert.equal(terminal.ok, true);
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
      returnToCatalog: async () => {
        throw new Error("payment cancel is disabled");
      },
      disableFaultInjection: async () => calls.push("fault"),
    });
    assert.equal(result.ok, false);
    assert.match(
      result.errors[0],
      /returnToCatalog: payment cancel is disabled/,
    );
    assert.deepEqual(result.actions, ["disableFaultInjection"]);
    assert.deepEqual(calls, ["fault"]);
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
    assert.deepEqual(calls, ["fault", "catalog"]);
    assert.deepEqual(result.actions, [
      "disableFaultInjection",
      "returnToCatalog",
    ]);
  });

  it("self-checks and clears the whole-machine lock only for its capability blocker", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/catalog",
          saleStartCapability: {
            blockers: [{ code: "WHOLE_MACHINE_LOCKED" }],
          },
        },
      },
      selfCheckHardware: async () => calls.push("self-check"),
      clearWholeMachineLock: async (note) => calls.push(["clear", note]),
      wholeMachineLockOperatorNote: "handoff recovery",
      disableFaultInjection: async () => calls.push("fault"),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      "self-check",
      ["clear", "handoff recovery"],
      "fault",
    ]);
    assert.deepEqual(result.actions, [
      "selfCheckHardware",
      "clearWholeMachineLock",
      "disableFaultInjection",
    ]);
  });

  it("does not call whole-machine recovery endpoints without the lock blocker", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/catalog",
          saleStartCapability: { blockers: [{ code: "MQTT_UNAVAILABLE" }] },
        },
      },
      selfCheckHardware: async () => calls.push("self-check"),
      clearWholeMachineLock: async () => calls.push("clear"),
      disableFaultInjection: async () => calls.push("fault"),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["fault"]);
  });

  it("does not clear the lock when self-check fails", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/catalog",
          saleStartCapability: { blockers: [{ code: "WHOLE_MACHINE_LOCKED" }] },
        },
      },
      selfCheckHardware: async () => {
        calls.push("self-check");
        throw new Error("production serial path unavailable");
      },
      clearWholeMachineLock: async () => calls.push("clear"),
      disableFaultInjection: async () => calls.push("fault"),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ["self-check"]);
    assert.match(result.errors[0], /production serial path unavailable/);
  });

  it("cancels a leaked wait_payment transaction before waiting for terminal state", async () => {
    const calls = [];
    const result = await recoverTrackHandoff({
      track: { key: "scanner" },
      terminal: {
        facts: {
          route: "#/payment",
          transaction: {
            orderId: "order-1",
            orderNo: "ORD-1",
            nextAction: "wait_payment",
          },
        },
      },
      fixtureAllocation: {},
      returnToCatalog: async () => calls.push("catalog"),
      disableFaultInjection: async () => calls.push("fault"),
      cancelActiveTransaction: async (transaction) =>
        calls.push(`cancel:${transaction.orderNo}`),
      waitForTransactionTerminal: async () => ({
        orderId: "order-1",
        nextAction: "canceled",
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["cancel:ORD-1", "fault", "catalog"]);
    assert.deepEqual(result.actions, [
      "cancelActiveTransaction",
      "disableFaultInjection",
      "returnToCatalog",
    ]);
  });

  it("cancels a transaction that arrives after a failed create-order gate is released", async () => {
    const calls = [];
    const lateTransaction = {
      orderId: "late-order-1",
      orderNo: "ORD-LATE-1",
      nextAction: "wait_payment",
    };
    const result = await recoverTrackHandoff({
      track: { key: "sale" },
      terminal: { facts: { route: "#/catalog", transaction: null } },
      recoverAfterFailure: true,
      disableFaultInjection: async () => calls.push("fault"),
      readLateTransaction: async () => lateTransaction,
      cancelActiveTransaction: async (transaction) =>
        calls.push(`cancel:${transaction.orderNo}`),
      waitForTransactionTerminal: async () => ({
        ...lateTransaction,
        nextAction: "closed",
      }),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["fault", "cancel:ORD-LATE-1"]);
    assert.deepEqual(result.actions, [
      "disableFaultInjection",
      "cancelActiveTransaction",
    ]);
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
      cancelActiveTransaction: async () => calls.push("cancel"),
      waitForTransactionTerminal: async () => ({
        orderId: "order-1",
        nextAction: "success",
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ["cancel", "fault", "catalog"]);
    assert.deepEqual(result.actions, [
      "cancelActiveTransaction",
      "disableFaultInjection",
      "returnToCatalog",
    ]);
  });
});
