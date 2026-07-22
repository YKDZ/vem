import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  mqttEvidenceProvesNoDispense,
  refreshAdminAccessToken,
  unwrapServiceApiEnvelope,
  waitForMachineOnline,
  parsePaymentRecoveryGuestArgs,
  selectCanonicalSlot,
  validatePaymentRecoveryEvidence,
} from "./payment-recovery-guest-full.mjs";

describe("payment recovery guest full", () => {
  it("publishes its serial session so track handoff can restore hardware", () => {
    const source = readFileSync(
      new URL("./payment-recovery-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /report\.serialSession\s*=\s*\{/);
    assert.match(source, /sessionId:\s*required\(session\.sessionId/);
  });
  it("parses the installed guest contract", () => {
    assert.equal(
      parsePaymentRecoveryGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\input.json",
        "--handoff",
        "C:\\handoff.json",
        "--out",
        "C:\\out.json",
      ]).mode,
      "full",
    );
  });
  it("refreshes the admin token through the existing login path", async () => {
    const calls = [];
    const token = await refreshAdminAccessToken(
      {
        serviceApi: { adminUsername: "seeded-admin", adminPassword: "secret" },
      },
      async (_input, path, options) => {
        calls.push({ path, options });
        return { accessToken: "fresh-token" };
      },
    );
    assert.equal(token, "fresh-token");
    assert.deepEqual(calls[0], {
      path: "/auth/login",
      options: {
        method: "POST",
        body: { username: "seeded-admin", password: "secret" },
      },
    });
  });
  it("unwraps real Service API admin response envelopes", () => {
    assert.deepEqual(unwrapServiceApiEnvelope({ code: 0, data: { id: 17 } }), {
      id: 17,
    });
  });
  it("resolves a slot from daemon canonical sale-view", () => {
    assert.deepEqual(
      selectCanonicalSlot(
        {
          planogramVersion: "P-7",
          items: [
            { slotDisplayLabel: "A1", slotId: "slot-1", inventoryId: "inv-1" },
          ],
        },
        { slotDisplayLabel: "A1" },
      ),
      {
        slotDisplayLabel: "A1",
        slotId: "slot-1",
        inventoryId: "inv-1",
        planogramVersion: "P-7",
      },
    );
  });
  it("waits for the matching Service API machine to become online", async () => {
    const statuses = ["starting", "online"];
    const calls = [];
    const machine = await waitForMachineOnline(
      { runtimeBootstrap: { provisioningApiBaseUrl: "http://api" } },
      "MACHINE-17",
      "admin-token",
      {
        query: async (_input, path, options) => {
          calls.push({ path, options });
          return {
            code: 0,
            data: {
              items: [{ code: "MACHINE-17", status: statuses.shift() }],
            },
          };
        },
        wait: async () => {},
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
      },
    );
    assert.equal(machine.status, "online");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.token, "admin-token");
  });
  it("fails after a finite wait when the machine never becomes online", async () => {
    await assert.rejects(
      waitForMachineOnline(
        { runtimeBootstrap: { provisioningApiBaseUrl: "http://api" } },
        "MACHINE-17",
        "admin-token",
        {
          timeoutMs: 1,
          query: async () => ({
            items: [{ code: "MACHINE-17", status: "offline" }],
          }),
          wait: async () => {},
          now: (() => {
            let value = 0;
            return () => value++;
          })(),
        },
      ),
      /did not become online/,
    );
  });
  it("requires real dispense-topic evidence that recovery did not vend", () => {
    assert.equal(
      mqttEvidenceProvesNoDispense({
        mqtt: { topic: "vem/machines/M-1/commands/dispense", messages: [] },
      }),
      true,
    );
    assert.equal(
      mqttEvidenceProvesNoDispense({
        mqtt: {
          topic: "vem/machines/M-1/commands/dispense",
          messages: [{ payload: { commandNo: "VEND-1" } }],
        },
      }),
      false,
    );
  });
  it("requires production recovery boundaries and no duplicate dispense", () => {
    const report = recoveryReport();
    assert.deepEqual(validatePaymentRecoveryEvidence(report), {
      paymentId: "pay-1",
      action: "query_payment",
      duplicatePaymentCount: 0,
      attemptCount: 4,
    });
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          recoveryMqttEvidence: {
            mqtt: {
              topic: "vem/machines/M-1/commands/dispense",
              messages: [{ payload: { commandNo: "CMD-1" } }],
            },
          },
        }),
      /MQTT/,
    );
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          assertions: { duplicatePaymentCount: 1, dispenseStarted: false },
        }),
      /duplicate/,
    );
  });

  it("requires every recovery attempt to reach its terminal state without retaining a reservation", () => {
    const report = recoveryReport();

    assert.equal(validatePaymentRecoveryEvidence(report).attemptCount, 4);
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          attempts: report.attempts.map((attempt, index) =>
            index === 2
              ? {
                  ...attempt,
                  reservation: {
                    ...attempt.reservation,
                    terminal: {
                      ...attempt.reservation.terminal,
                      activeRows: 1,
                    },
                  },
                }
              : attempt,
          ),
        }),
      /reservation baseline/,
    );
  });

  it("rejects report-only customer copy and locally invented correlations", () => {
    const report = recoveryReport();
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          attempts: report.attempts.map((attempt) => ({
            ...attempt,
            customer: { saleable: true, semanticChineseOnly: true },
            technicalEvidence: { correlationId: `local:${attempt.kind}` },
          })),
        }),
      /customer surface|correlation/,
    );
  });
});

function recoveryReport() {
  const terminalByKind = {
    create_failure: {
      paymentStatus: "failed",
      orderStatus: "canceled",
      paymentState: "payment_failed",
      resultKind: "payment_failed",
    },
    query_failure: {
      paymentStatus: "canceled",
      orderStatus: "canceled",
      paymentState: "canceled",
      resultKind: "closed",
    },
    canceled: {
      paymentStatus: "canceled",
      orderStatus: "canceled",
      paymentState: "canceled",
      resultKind: "closed",
    },
    expired: {
      paymentStatus: "expired",
      orderStatus: "payment_expired",
      paymentState: "payment_expired",
      resultKind: "payment_expired",
    },
  };
  return {
    schemaVersion: "vem-payment-recovery-guest-full/v1",
    ok: true,
    inventory: { id: "inventory-1" },
    payment: { id: "pay-1" },
    recoveryMqttEvidence: {
      mqtt: { topic: "vem/machines/M-1/commands/dispense", messages: [] },
    },
    attempts: Object.entries(terminalByKind).map(([kind, terminal]) => ({
      kind,
      order: { id: `order-${kind}`, paymentId: `pay-${kind}` },
      payment: { id: `pay-${kind}`, paymentNo: `payment-${kind}` },
      expectedTerminal: terminal,
      reservation: {
        quantity: 1,
        baseline: { onHandQty: 3, reservedQty: 0, activeRows: 0 },
        active: {
          onHandQty: 3,
          reservedQty: 1,
          activeRows: 1,
          orderReservationRows: 1,
          row: { id: `reservation-${kind}`, status: "active" },
        },
        terminal: {
          onHandQty: 3,
          reservedQty: 0,
          activeRows: 0,
          orderReservationRows: 1,
          row: { id: `reservation-${kind}`, status: "released" },
        },
      },
      daemon: {
        active: { orderId: `order-${kind}`, paymentId: `pay-${kind}` },
        terminal: {
          orderId: `order-${kind}`,
          paymentId: `pay-${kind}`,
          paymentStatus: terminal.paymentStatus,
        },
      },
      terminal: {
        paymentStatus: terminal.paymentStatus,
        orderStatus: terminal.orderStatus,
        paymentState: terminal.paymentState,
      },
      customer: {
        source: "installed_machine_runtime_cdp",
        orderId: `order-${kind}`,
        paymentId: `pay-${kind}`,
        resultKind: terminal.resultKind,
        text: "本次订单已取消，未完成扣款。",
      },
      technicalEvidence: {
        runtimeTrace: {
          source: "installed_machine_runtime_trace_cdp",
          orderId: `order-${kind}`,
          paymentId: `pay-${kind}`,
          resultKind: terminal.resultKind,
          entry: { id: 1 },
        },
      },
      ...(kind === "query_failure"
        ? {
            recovery: {
              queryFault: {
                source: "mock_provider_query_fault_boundary",
                paymentNo: `payment-${kind}`,
              },
              reconciliationAttempt: {
                paymentId: `pay-${kind}`,
                status: "network_error",
                errorCode: "query_failed",
              },
              closeAction: { action: "close_or_reverse_uncertain_payment" },
            },
          }
        : {}),
      ...(kind === "expired"
        ? {
            expiryInjection: {
              source: "testbed_payment_expiry_time_injection",
              beforePaymentStatus: "pending",
            },
          }
        : {}),
    })),
    subsequentSale: {
      order: {
        id: "order-paid",
        paymentId: "pay-paid",
        inventoryId: "inventory-1",
      },
      inventory: { beforeOnHandQty: 3, afterOnHandQty: 2, movementCount: 1 },
      terminal: {
        paymentStatus: "succeeded",
        orderStatus: "fulfilled",
        fulfillmentState: "dispensed",
      },
      serial: { protocol: ["VEND", "F0", "F1", "F2"], stopped: true },
    },
    assertions: { duplicatePaymentCount: 0 },
  };
}
