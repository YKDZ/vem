import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mqttEvidenceMatchesPayment,
  adminAccessToken,
  parsePaymentRecoveryGuestArgs,
  selectCanonicalSlot,
  validatePaymentRecoveryEvidence,
} from "./payment-recovery-guest-full.mjs";

describe("payment recovery guest full", () => {
  it("uses the seeded Service API admin access token from guest input", () => {
    assert.equal(
      adminAccessToken({ serviceApi: { adminAccessToken: "seeded-token" } }),
      "seeded-token",
    );
    assert.throws(
      () => adminAccessToken({}),
      /serviceApi\.adminAccessToken is required/,
    );
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
