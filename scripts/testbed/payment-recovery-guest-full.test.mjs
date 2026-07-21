import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mqttEvidenceMatchesPayment,
  refreshAdminAccessToken,
  unwrapServiceApiEnvelope,
  waitForMachineOnline,
  parsePaymentRecoveryGuestArgs,
  selectCanonicalSlot,
  validatePaymentRecoveryEvidence,
} from "./payment-recovery-guest-full.mjs";

describe("payment recovery guest full", () => {
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
          items: [{ slotCode: "A1", slotId: "slot-1", inventoryId: "inv-1" }],
        },
        { slotCode: "A1" },
      ),
      {
        slotCode: "A1",
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
  it("requires MQTT evidence correlated to the recovered payment", () => {
    const payment = {
      id: "pay-1",
      paymentNo: "PAY-001",
      orderNo: "ORD-001",
    };
    assert.equal(
      mqttEvidenceMatchesPayment(
        { machineMqtt: { messages: [{ payload: { orderNo: "ORD-001" } }] } },
        payment,
      ),
      true,
    );
    assert.equal(
      mqttEvidenceMatchesPayment(
        { mqtt: { messages: [{ payload: { orderNo: "ORD-OTHER" } }] } },
        payment,
      ),
      false,
    );
  });
  it("requires production recovery boundaries and no duplicate dispense", () => {
    const report = {
      schemaVersion: "vem-payment-recovery-guest-full/v1",
      ok: true,
      boundaries: { serviceApi: true, mqtt: true, daemon: true },
      payment: { id: "pay-1" },
      recovery: { action: { action: "query_payment" } },
      assertions: { duplicatePaymentCount: 0, dispenseStarted: false },
    };
    assert.deepEqual(validatePaymentRecoveryEvidence(report), {
      paymentId: "pay-1",
      action: "query_payment",
      duplicatePaymentCount: 0,
    });
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          boundaries: { ...report.boundaries, mqtt: false },
        }),
      /boundaries/,
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
});
